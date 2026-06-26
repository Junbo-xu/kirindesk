import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { ActorType, withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { RbacService, scopeWithin } from '../rbac/rbac.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { PermissionGrantDto } from './dto/set-role-permissions.dto';
import {
  RoleCountsRow,
  RoleDetail,
  RoleSummary,
  PermissionGrant,
  CatalogModule,
  toRoleSummary,
  toRoleDetail,
} from './roles.response';
import {
  DuplicateRoleNameException,
  PermissionNotFoundException,
  PrivilegeEscalationException,
  RoleInUseException,
  RoleNotFoundException,
  SystemRoleReadOnlyException,
} from './roles.errors';

// Caller identity + injected dataScope. Roles are tenant-global (no per-row
// owner), so reads are isolated by RLS alone; the actor carries the caller id
// for the subset guard (plan §4.1 guard 1) and audit attribution.
export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
  // Read-path session actor type (defaults to 'tenant_user'). The platform
  // support-access path (1K-B §3.4) passes 'platform_admin'. Write methods
  // always run as tenant_user.
  actorType?: ActorType;
}

const UNIQUE_VIOLATION = '23505';

// Selected columns + per-role counts for list/detail. Never returns internal-only
// columns (roles carries none sensitive, but the shape is fixed for the contract).
const ROLE_SELECT = `r.id, r.tenant_id, r.name, r.description, r.is_system,
                     r.created_at, r.updated_at,
                     (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id)::int
                       AS permission_count,
                     (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id)::int
                       AS user_count`;

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
    private readonly rbacService: RbacService,
  ) {}

  // --- reads (plan §3.2) ---

  async list(actor: RequestActor): Promise<RoleSummary[]> {
    return withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        const { rows } = await client.query<RoleCountsRow>(
          `SELECT ${ROLE_SELECT} FROM roles r ORDER BY r.is_system DESC, r.name`,
        );
        return rows.map(toRoleSummary);
      },
    );
  }

  async getOne(actor: RequestActor, id: string): Promise<RoleDetail> {
    return withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        const row = await this.fetchInScope(client, id);
        const permissions = await this.loadRolePermissions(client, id);
        return toRoleDetail(row, permissions);
      },
    );
  }

  // Permission dictionary grouped by module (plan §3.3). Global read-only tables;
  // still gated by roles:view at the controller. No tenant dimension.
  async listPermissionCatalog(actor: RequestActor): Promise<CatalogModule[]> {
    return withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        const { rows } = await client.query<{
          module_code: string;
          module_name: string;
          sort_order: number;
          id: string;
          code: string;
          name: string;
          action: string;
        }>(
          `SELECT m.code AS module_code, m.name AS module_name, m.sort_order,
                  p.id, p.code, p.name, p.action
           FROM permissions p
           JOIN modules m ON m.id = p.module_id
           ORDER BY m.sort_order, m.code, p.code`,
        );
        const byModule = new Map<string, CatalogModule>();
        for (const r of rows) {
          let mod = byModule.get(r.module_code);
          if (!mod) {
            mod = { code: r.module_code, name: r.module_name, permissions: [] };
            byModule.set(r.module_code, mod);
          }
          mod.permissions.push({ id: r.id, code: r.code, name: r.name, action: r.action });
        }
        return [...byModule.values()];
      },
    );
  }

  // --- writes (plan §3.2, §4 guards) ---

  async create(actor: RequestActor, dto: CreateRoleDto): Promise<RoleDetail> {
    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        try {
          // is_system is forced false — the API can never mint a system role.
          const { rows } = await client.query<RoleCountsRow>(
            `INSERT INTO roles (tenant_id, name, description, is_system)
             VALUES ($1, $2, $3, false)
             RETURNING id, tenant_id, name, description, is_system, created_at, updated_at,
                       0 AS permission_count, 0 AS user_count`,
            [actor.tenantId, dto.name, dto.description ?? null],
          );
          return rows[0];
        } catch (err) {
          if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
            throw new DuplicateRoleNameException();
          }
          throw err;
        }
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'role.created',
      resourceId: row.id,
      after: { name: row.name, description: row.description },
    });

    return toRoleDetail(row, []);
  }

  async update(actor: RequestActor, id: string, dto: UpdateRoleDto): Promise<RoleDetail> {
    const { before, after, permissions } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, id);
        if (existing.is_system) throw new SystemRoleReadOnlyException();

        const allowed = ['name', 'description'] as const;
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
        let updated: RoleCountsRow;
        try {
          const { rows } = await client.query<RoleCountsRow>(
            `WITH upd AS (
               UPDATE roles SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id
             )
             SELECT ${ROLE_SELECT} FROM roles r WHERE r.id = (SELECT id FROM upd)`,
            params,
          );
          updated = rows[0];
        } catch (err) {
          if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
            throw new DuplicateRoleNameException();
          }
          throw err;
        }
        const perms = await this.loadRolePermissions(client, id);
        return { before: existing, after: updated, permissions: perms };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'role.updated',
      resourceId: id,
      before: { name: before.name, description: before.description },
      after: { name: after.name, description: after.description },
    });

    return toRoleDetail(after, permissions);
  }

  // Full-replace the role's permission set (plan §3.2, §4.1 guards 1 + 4).
  async setPermissions(
    actor: RequestActor,
    id: string,
    grants: PermissionGrantDto[],
  ): Promise<RoleDetail> {
    const { before, after, row } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, id);
        if (existing.is_system) throw new SystemRoleReadOnlyException();

        const beforeGrants = await this.loadRolePermissions(client, id);
        if (grants.length > 0) {
          await this.assertGrantsAssignable(client, actor, grants);
        }
        await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
        for (const g of grants) {
          await client.query(
            `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, role_id, permission_id) DO NOTHING`,
            [actor.tenantId, id, g.permissionId, g.dataScope],
          );
        }
        const afterGrants = await this.loadRolePermissions(client, id);
        return { before: beforeGrants, after: afterGrants, row: existing };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'role.permissions_replaced',
      resourceId: id,
      before: {
        permissions: before.map((g) => ({ permissionId: g.permissionId, dataScope: g.dataScope })),
      },
      after: {
        permissions: after.map((g) => ({ permissionId: g.permissionId, dataScope: g.dataScope })),
      },
    });

    return toRoleDetail(row, after);
  }

  // Delete a custom role (plan §3.2, §4.1 guards 4 + 5). System roles rejected;
  // roles still bound to users rejected (no dangling grants).
  async remove(actor: RequestActor, id: string): Promise<void> {
    const before = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, id);
        if (existing.is_system) throw new SystemRoleReadOnlyException();
        if (existing.user_count > 0) throw new RoleInUseException();
        // No user_roles rows reference it; clear its permission grants then drop it.
        await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
        await client.query(`DELETE FROM roles WHERE id = $1`, [id]);
        return existing;
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'role.deleted',
      resourceId: id,
      before: { name: before.name, description: before.description },
    });
  }

  // --- helpers ---

  private async fetchInScope(client: PoolClient, id: string): Promise<RoleCountsRow> {
    const { rows } = await client.query<RoleCountsRow>(
      `SELECT ${ROLE_SELECT} FROM roles r WHERE r.id = $1`,
      [id],
    );
    if (rows.length === 0) throw new RoleNotFoundException();
    return rows[0];
  }

  private async loadRolePermissions(
    client: PoolClient,
    roleId: string,
  ): Promise<PermissionGrant[]> {
    const { rows } = await client.query<{
      permission_id: string;
      code: string;
      name: string;
      action: string;
      data_scope: string;
    }>(
      `SELECT rp.permission_id, p.code, p.name, p.action, rp.data_scope
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = $1 ORDER BY p.code`,
      [roleId],
    );
    return rows.map((r) => ({
      permissionId: r.permission_id,
      code: r.code,
      name: r.name,
      action: r.action,
      dataScope: r.data_scope,
    }));
  }

  // Subset guard (plan §4.1 guard 1): the caller may only grant permissions they
  // hold themselves, at a data_scope no wider than their own. Prevents an admin
  // from escalating privileges by writing them into a role.
  private async assertGrantsAssignable(
    client: PoolClient,
    actor: RequestActor,
    grants: PermissionGrantDto[],
  ): Promise<void> {
    const ids = grants.map((g) => g.permissionId);
    const { rows } = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM permissions WHERE id = ANY($1)`,
      [ids],
    );
    if (rows.length !== new Set(ids).size) throw new PermissionNotFoundException();
    const codeById = new Map(rows.map((r) => [r.id, r.code]));

    const held = await this.rbacService.listEffectivePermissions(actor.userId, actor.tenantId);
    for (const g of grants) {
      const code = codeById.get(g.permissionId)!;
      const callerScope = held.get(code);
      if (callerScope === undefined) {
        throw new PrivilegeEscalationException(`missing permission ${code}`);
      }
      if (!scopeWithin(g.dataScope, callerScope)) {
        throw new PrivilegeEscalationException(`scope ${g.dataScope} exceeds own for ${code}`);
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
        resourceType: 'role',
        resourceId: params.resourceId,
        before: params.before,
        after: params.after,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} role=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}
