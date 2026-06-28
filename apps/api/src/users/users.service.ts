import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import * as bcrypt from 'bcryptjs';
import { ActorType, withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { RbacService, scopeWithin } from '../rbac/rbac.service';
import { QuotaService } from '../subscription/quota.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ListUsersQuery } from './dto/list-users.query';
import {
  UserRow,
  UserRoleBrief,
  UserSummary,
  UserDetail,
  toUserSummary,
  toUserDetail,
} from './users.response';
import {
  DuplicateUserEmailException,
  LastOwnerException,
  PrivilegeEscalationException,
  RoleNotFoundException,
  SelfLockException,
  UserNotFoundException,
} from './users.errors';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
  // Read-path session actor type (defaults to 'tenant_user'). The platform
  // support-access path (1K-B §3.4) passes 'platform_admin' to read tenant
  // user/role config honestly. Write methods always run as tenant_user.
  actorType?: ActorType;
}

export interface ListResult {
  data: UserSummary[];
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const UNIQUE_VIOLATION = '23505';
const BCRYPT_COST = 12;

// Columns selected for the response shape — never includes password_hash.
const USER_COLS = `id, tenant_id, email, name, phone, status, is_tenant_owner,
                   last_login_at, created_at, updated_at, deleted_at`;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
    private readonly rbacService: RbacService,
    private readonly quota: QuotaService,
  ) {}

  // --- auth-facing reads (existing; unchanged signatures) ---

  async findByEmailForAuth(tenantId: string, email: string): Promise<AuthUserRow | null> {
    return withTenantContext(
      this.pool,
      { tenantId, userId: null, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<AuthUserRow>(
          `SELECT id, tenant_id, email, password_hash, name, status, is_tenant_owner, deleted_at
           FROM users WHERE email = $1 AND deleted_at IS NULL`,
          [email],
        );
        return rows[0] ?? null;
      },
    );
  }

  async findById(
    tenantId: string,
    userId: string,
  ): Promise<Omit<AuthUserRow, 'password_hash'> | null> {
    return withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query(
          `SELECT id, tenant_id, email, name, status, is_tenant_owner, deleted_at
           FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        );
        return rows[0] ?? null;
      },
    );
  }

  // own/assigned narrow user-management reads to the caller's own record;
  // user administration generally requires scope=all. Defensive narrowing.
  private restrictsToSelf(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  // --- management CRUD (plan §3.1) ---

  async create(actor: RequestActor, dto: CreateUserDto): Promise<UserDetail> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    const { row, roles } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        if (dto.roleIds && dto.roleIds.length > 0) {
          await this.assertRolesAssignable(client, actor, dto.roleIds);
        }
        let created: UserRow;
        try {
          const { rows } = await client.query<UserRow>(
            `INSERT INTO users (tenant_id, email, password_hash, name, phone, status, is_tenant_owner)
             VALUES ($1, $2, $3, $4, $5, 'active', false)
             RETURNING ${USER_COLS}`,
            [actor.tenantId, dto.email, passwordHash, dto.name, dto.phone ?? null],
          );
          created = rows[0];
        } catch (err) {
          if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
            throw new DuplicateUserEmailException();
          }
          throw err;
        }
        const assigned = await this.replaceUserRoles(client, actor, created.id, dto.roleIds ?? []);
        return { row: created, roles: assigned };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'user.created',
      resourceId: row.id,
      after: { ...toUserSummary(row), roles },
    });

    void this.quota
      .increment(actor.tenantId, actor.userId)
      .catch(() => this.logger.warn('quota increment failed for user.create'));
    return toUserDetail(row, roles);
  }

  async list(actor: RequestActor, query: ListUsersQuery): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];

    if (this.restrictsToSelf(actor.dataScope)) {
      params.push(actor.userId);
      conditions.push(`id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      const p = `$${params.length}`;
      conditions.push(`(name ILIKE ${p} OR email ILIKE ${p})`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    return withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        const totalRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM users ${where}`,
          params,
        );
        const dataRes = await client.query<UserRow>(
          `SELECT ${USER_COLS} FROM users ${where}
           ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: dataRes.rows.map(toUserSummary),
          page,
          pageSize,
          total: parseInt(totalRes.rows[0].count, 10),
        };
      },
    );
  }

  async getOne(actor: RequestActor, id: string): Promise<UserDetail> {
    return withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        const row = await this.fetchInScope(client, actor, id);
        const roles = await this.loadUserRoles(client, id);
        return toUserDetail(row, roles);
      },
    );
  }

  async update(actor: RequestActor, id: string, dto: UpdateUserDto): Promise<UserDetail> {
    const { before, after, roles } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, actor, id);

        // Deactivating via status change is guarded like an explicit deactivate.
        if (dto.status === 'inactive' && existing.status === 'active') {
          await this.assertCanDeactivate(client, actor, existing);
        }

        const allowed = ['name', 'phone', 'status'] as const;
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const col of allowed) {
          if (dto[col] !== undefined) {
            params.push(dto[col]);
            sets.push(`${col} = $${params.length}`);
          }
        }
        sets.push('updated_at = now()');
        params.push(id);
        const { rows } = await client.query<UserRow>(
          `UPDATE users SET ${sets.join(', ')}
           WHERE id = $${params.length} AND deleted_at IS NULL RETURNING ${USER_COLS}`,
          params,
        );
        const updatedRoles = await this.loadUserRoles(client, id);
        return { before: existing, after: rows[0], roles: updatedRoles };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'user.updated',
      resourceId: id,
      before: toUserSummary(before),
      after: toUserSummary(after),
    });

    return toUserDetail(after, roles);
  }

  // Full-replace the user's role set (plan §3.1, §4.1 guards 1 + 2).
  async setRoles(actor: RequestActor, id: string, roleIds: string[]): Promise<UserDetail> {
    const { before, after, row } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, actor, id);
        const beforeRoles = await this.loadUserRoles(client, id);
        if (roleIds.length > 0) {
          await this.assertRolesAssignable(client, actor, roleIds);
        }
        // Removing roles could strip the last owner's powers; the owner flag
        // itself is unaffected by roles, so no last-owner check here — owner
        // status is governed by is_tenant_owner, guarded on deactivate.
        const afterRoles = await this.replaceUserRoles(client, actor, id, roleIds);
        return { before: beforeRoles, after: afterRoles, row: existing };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'user.roles_replaced',
      resourceId: id,
      before: { roles: before },
      after: { roles: after },
    });

    return toUserDetail(row, after);
  }

  // Soft-delete + deactivate (no hard delete). Last-owner + self-lock guards.
  async deactivate(actor: RequestActor, id: string): Promise<void> {
    const before = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, actor, id);
        await this.assertCanDeactivate(client, actor, existing);
        await client.query(
          `UPDATE users SET deleted_at = now(), status = 'inactive', updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        return existing;
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'user.deactivated',
      resourceId: id,
      before: toUserSummary(before),
      after: { ...toUserSummary(before), status: 'inactive', deleted: true },
    });

    void this.quota
      .decrement(actor.tenantId, actor.userId)
      .catch(() => this.logger.warn('quota decrement failed for user.deactivate'));
  }

  // --- helpers ---

  private async fetchInScope(
    client: PoolClient,
    actor: RequestActor,
    id: string,
  ): Promise<UserRow> {
    const params: unknown[] = [id];
    let scopeClause = '';
    if (this.restrictsToSelf(actor.dataScope)) {
      params.push(actor.userId);
      scopeClause = ' AND id = $2';
    }
    const { rows } = await client.query<UserRow>(
      `SELECT ${USER_COLS} FROM users WHERE id = $1 AND deleted_at IS NULL${scopeClause}`,
      params,
    );
    if (rows.length === 0) throw new UserNotFoundException();
    return rows[0];
  }

  private async loadUserRoles(client: PoolClient, userId: string): Promise<UserRoleBrief[]> {
    const { rows } = await client.query<UserRoleBrief>(
      `SELECT r.id, r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id
       WHERE ur.user_id = $1 ORDER BY r.name`,
      [userId],
    );
    return rows;
  }

  // Replaces the user's role set within the current transaction. Validates that
  // every role id exists in the tenant (RLS already scopes to tenant).
  private async replaceUserRoles(
    client: PoolClient,
    actor: RequestActor,
    userId: string,
    roleIds: string[],
  ): Promise<UserRoleBrief[]> {
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
    if (roleIds.length > 0) {
      const found = await client.query<{ id: string }>(`SELECT id FROM roles WHERE id = ANY($1)`, [
        roleIds,
      ]);
      if (found.rows.length !== new Set(roleIds).size) {
        throw new RoleNotFoundException();
      }
      for (const roleId of roleIds) {
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id, role_id) DO NOTHING`,
          [actor.tenantId, userId, roleId],
        );
      }
    }
    return this.loadUserRoles(client, userId);
  }

  // Subset guard (plan §4.1 guard 1): the caller may only assign roles whose
  // every permission the caller also holds, at a data_scope no wider than the
  // caller's own. Prevents privilege escalation through role assignment.
  private async assertRolesAssignable(
    client: PoolClient,
    actor: RequestActor,
    roleIds: string[],
  ): Promise<void> {
    const held = await this.rbacService.listEffectivePermissions(actor.userId, actor.tenantId);
    const { rows } = await client.query<{ code: string; data_scope: string }>(
      `SELECT DISTINCT p.code, rp.data_scope
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ANY($1)`,
      [roleIds],
    );
    for (const r of rows) {
      const callerScope = held.get(r.code);
      if (callerScope === undefined) {
        throw new PrivilegeEscalationException(`missing permission ${r.code}`);
      }
      if (!scopeWithin(r.data_scope, callerScope)) {
        throw new PrivilegeEscalationException(`scope ${r.data_scope} exceeds own for ${r.code}`);
      }
    }
  }

  // Last-owner + self-lock guards (plan §4.1 guards 2 + 3).
  private async assertCanDeactivate(
    client: PoolClient,
    actor: RequestActor,
    target: UserRow,
  ): Promise<void> {
    if (target.id === actor.userId) {
      throw new SelfLockException();
    }
    if (target.is_tenant_owner) {
      const { rows } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users
         WHERE is_tenant_owner = true AND status = 'active' AND deleted_at IS NULL`,
      );
      if (parseInt(rows[0].count, 10) <= 1) {
        throw new LastOwnerException();
      }
    }
  }

  // Audit after the business transaction commits (separate transaction). A
  // failure here must not undo the committed change; we log it so it is visible.
  private async safeAudit(params: {
    tenantId: string;
    actorId: string;
    action: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    try {
      await this.auditService.log({
        tenantId: params.tenantId,
        actorType: 'tenant_user',
        actorId: params.actorId,
        action: params.action,
        resourceType: 'user',
        resourceId: params.resourceId,
        before: params.before,
        after: params.after,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} user=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}

// Row shape for the auth-facing reads (includes password_hash). Kept separate
// from the management UserRow (users.response.ts), which never carries the hash.
export interface AuthUserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  name: string;
  status: string;
  is_tenant_owner: boolean;
  deleted_at: string | null;
}
