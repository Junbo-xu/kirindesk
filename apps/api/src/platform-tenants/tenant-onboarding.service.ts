import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { TenantSummary, toTenantSummary, TenantRow } from './platform-tenants.service';

const BCRYPT_COST = 12;
const UNIQUE_VIOLATION = '23505';

export interface OwnerSummary {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  status: string;
  isOwner: boolean;
  createdAt: Date;
}

export interface TenantOnboardingResult {
  tenant: TenantSummary;
  owner: OwnerSummary;
}

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  status: string;
  is_tenant_owner: boolean;
  created_at: Date;
}

const META_COLS = `id, name, slug, status, suspended_at, suspended_reason,
       contact_email, contact_phone, created_at, updated_at`;

/**
 * Tenant onboarding service (plan §3.3). Atomically creates the tenants row,
 * the first owner user, and the audit_log_chains genesis row in a single
 * transaction — so the new tenant is audit-ready from its very first event.
 * bcrypt is computed BEFORE the transaction to avoid holding a connection
 * during CPU-intensive work.
 */
@Injectable()
export class TenantOnboardingService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
  ) {}

  async provision(adminId: string, dto: CreateTenantDto): Promise<TenantOnboardingResult> {
    // ① bcrypt outside the transaction — CPU-intensive, must not hold a
    //    connection while hashing (same pattern as 1H UsersService.create).
    const passwordHash = await bcrypt.hash(dto.ownerPassword, BCRYPT_COST);

    const client = await this.pool.connect();
    let tenant: TenantSummary;
    let owner: OwnerSummary;
    try {
      await client.query('BEGIN');

      // ② INSERT tenants (owner_user_id NULL initially; backfilled in step ⑤).
      let tenantRow: TenantRow;
      try {
        const res = await client.query<TenantRow>(
          `INSERT INTO tenants
              (name, slug, status, contact_email, contact_phone, timezone, locale)
           VALUES ($1, $2, 'active', $3, $4, $5, $6)
           RETURNING ${META_COLS}`,
          [
            dto.name,
            dto.slug,
            dto.contactEmail ?? null,
            dto.contactPhone ?? null,
            dto.timezone ?? 'Asia/Shanghai',
            dto.locale ?? 'zh-CN',
          ],
        );
        tenantRow = res.rows[0];
      } catch (err) {
        await client.query('ROLLBACK');
        const code = (err as { code?: string }).code;
        const constraint = (err as { constraint?: string }).constraint ?? '';
        if (code === UNIQUE_VIOLATION && constraint.includes('slug')) {
          throw new ConflictException('slug 已存在');
        }
        throw err;
      }
      const tenantId = tenantRow.id;

      // ③ SET LOCAL so users FORCE RLS allows the INSERT (system actor).
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      await client.query(`SELECT set_config('app.current_actor_type', 'system', true)`);

      // ④ INSERT owner user.
      let userRow: UserRow;
      try {
        const res = await client.query<UserRow>(
          `INSERT INTO users
              (tenant_id, email, password_hash, name, status, is_tenant_owner)
           VALUES ($1, $2, $3, $4, 'active', true)
           RETURNING id, tenant_id, email, name, status, is_tenant_owner, created_at`,
          [tenantId, dto.ownerEmail, passwordHash, dto.ownerName],
        );
        userRow = res.rows[0];
      } catch (err) {
        await client.query('ROLLBACK');
        const code = (err as { code?: string }).code;
        if (code === UNIQUE_VIOLATION) {
          throw new ConflictException('owner 邮箱已存在');
        }
        throw err;
      }

      // ⑤ Backfill owner_user_id (bare uuid column, no FK — see plan §2.5).
      await client.query(
        `UPDATE tenants SET owner_user_id = $1, updated_at = now() WHERE id = $2`,
        [userRow.id, tenantId],
      );
      // Fetch the updated row so tenant summary has correct updated_at.
      const updated = await client.query<TenantRow>(
        `SELECT ${META_COLS} FROM tenants WHERE id = $1`,
        [tenantId],
      );
      tenantRow = updated.rows[0];

      // ⑥ ★ genesis audit_log_chains row — the critical step (plan §1.1/§2.4).
      //   Without this, AuditService silently no-ops for this tenant forever.
      try {
        await client.query(
          `INSERT INTO audit_log_chains (chain_key, tenant_id, last_hash)
           VALUES ($1, $2, repeat('0', 64))`,
          [`tenant:${tenantId}`, tenantId],
        );
      } catch {
        await client.query('ROLLBACK');
        // chain_key UNIQUE collision should never happen (uuid is unique), but
        // fail hard rather than silently committing a tenant without a chain.
        throw new InternalServerErrorException('Failed to initialise audit chain');
      }

      await client.query('COMMIT');

      tenant = toTenantSummary(tenantRow);
      owner = {
        id: userRow.id,
        tenantId: userRow.tenant_id,
        email: userRow.email,
        name: userRow.name,
        status: userRow.status,
        isOwner: userRow.is_tenant_owner,
        createdAt: userRow.created_at,
      };
    } catch (e) {
      // ConflictException / InternalServerErrorException already issued ROLLBACK above.
      // Guard remaining unexpected throws.
      if (!(e instanceof ConflictException) && !(e instanceof InternalServerErrorException)) {
        await client.query('ROLLBACK').catch(() => {});
      }
      throw e;
    } finally {
      client.release();
    }

    // ⑦ Post-commit audit (plan §4.2). Genesis row exists; chain can receive events.
    //   Best-effort: if audit throws, the tenant is already provisioned. Same
    //   trade-off as 1K-A transition(). Metadata must NOT contain any password.
    await this.auditService.log({
      tenantId: tenant.id,
      actorType: 'platform_admin',
      actorId: adminId,
      action: 'tenant.created',
      resourceType: 'tenant',
      resourceId: tenant.id,
      metadata: {
        tenantSlug: tenant.slug,
        ownerEmail: owner.email,
        ownerUserId: owner.id,
      },
    });

    return { tenant, owner };
  }
}
