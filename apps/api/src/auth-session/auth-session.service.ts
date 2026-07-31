import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';

interface CreateSessionInput {
  sessionId: string;
  actorId: string;
  expiresAt: Date;
  ip?: string;
  userAgent?: string;
}

export interface ValidTenantSession {
  sub: string;
  type: 'tenant_user';
  tenantId: string;
  email: string;
  sid: string;
}

export interface ValidPlatformSession {
  sub: string;
  type: 'platform_admin';
  email: string;
  sid: string;
}

@Injectable()
export class AuthSessionService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async createTenantSession(tenantId: string, input: CreateSessionInput): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId, userId: input.actorId, actorType: 'tenant_user' },
      async (client) => {
        await client.query(
          `INSERT INTO auth_sessions
             (id, tenant_id, actor_type, actor_id, expires_at, ip_address, user_agent)
           VALUES ($1, $2, 'tenant_user', $3, $4, NULLIF($5, '')::inet, $6)`,
          [
            input.sessionId,
            tenantId,
            input.actorId,
            input.expiresAt,
            input.ip ?? '',
            input.userAgent ?? null,
          ],
        );
      },
    );
  }

  async createPlatformSession(input: CreateSessionInput): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId: null, userId: input.actorId, actorType: 'platform_admin' },
      async (client) => {
        await client.query(
          `INSERT INTO auth_sessions
             (id, tenant_id, actor_type, actor_id, expires_at, ip_address, user_agent)
           VALUES ($1, NULL, 'platform_admin', $2, $3, NULLIF($4, '')::inet, $5)`,
          [
            input.sessionId,
            input.actorId,
            input.expiresAt,
            input.ip ?? '',
            input.userAgent ?? null,
          ],
        );
      },
    );
  }

  async validateTenantSession(
    sessionId: string,
    tenantId: string,
    actorId: string,
  ): Promise<ValidTenantSession | null> {
    return withTenantContext(
      this.pool,
      { tenantId, userId: actorId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<ValidTenantSession>(
          `SELECT u.id AS sub, 'tenant_user' AS type,
                  u.tenant_id AS "tenantId", u.email, s.id AS sid
             FROM auth_sessions s
             JOIN users u
               ON u.id = s.actor_id
              AND u.tenant_id = s.tenant_id
             JOIN tenants t ON t.id = s.tenant_id
            WHERE s.id = $1
              AND s.actor_type = 'tenant_user'
              AND s.actor_id = $2
              AND s.tenant_id = $3
              AND s.revoked_at IS NULL
              AND s.expires_at > now()
              AND u.status = 'active'
              AND u.deleted_at IS NULL
              AND t.status = 'active'
              AND t.deleted_at IS NULL`,
          [sessionId, actorId, tenantId],
        );
        return rows[0] ?? null;
      },
    );
  }

  async validatePlatformSession(
    sessionId: string,
    actorId: string,
  ): Promise<ValidPlatformSession | null> {
    return withTenantContext(
      this.pool,
      { tenantId: null, userId: actorId, actorType: 'platform_admin' },
      async (client) => {
        const { rows } = await client.query<ValidPlatformSession>(
          `SELECT p.id AS sub, 'platform_admin' AS type, p.email, s.id AS sid
             FROM auth_sessions s
             JOIN platform_admins p ON p.id = s.actor_id
            WHERE s.id = $1
              AND s.actor_type = 'platform_admin'
              AND s.actor_id = $2
              AND s.tenant_id IS NULL
              AND s.revoked_at IS NULL
              AND s.expires_at > now()
              AND p.status = 'active'`,
          [sessionId, actorId],
        );
        return rows[0] ?? null;
      },
    );
  }

  async revokeTenantSession(sessionId: string, tenantId: string, actorId: string): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId, userId: actorId, actorType: 'tenant_user' },
      async (client) => {
        await client.query(
          `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
            WHERE id = $1 AND actor_type = 'tenant_user' AND actor_id = $2 AND tenant_id = $3`,
          [sessionId, actorId, tenantId],
        );
      },
    );
  }

  async revokePlatformSession(sessionId: string, actorId: string): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId: null, userId: actorId, actorType: 'platform_admin' },
      async (client) => {
        await client.query(
          `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
            WHERE id = $1 AND actor_type = 'platform_admin' AND actor_id = $2 AND tenant_id IS NULL`,
          [sessionId, actorId],
        );
      },
    );
  }
}
