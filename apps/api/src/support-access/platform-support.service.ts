import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { AuditQueryService } from '../audit/audit-query.service';
import { UsersService } from '../users/users.service';
import { RolesService } from '../roles/roles.service';
import { ListAuditLogsQuery } from '../audit/dto/list-audit-logs.query';
import { ListUsersQuery } from '../users/dto/list-users.query';
import { SupportGrant } from './support-access.guard';

// Summary of a grant naming the calling platform admin, returned by
// app_list_support_grants_for_admin (plan §3.6). Cross-tenant by nature; carries
// no business data.
export interface MyGrantRow {
  grant_id: string;
  tenant_id: string;
  scope: string;
  status: string;
  expires_at: Date;
}

export interface MyGrantSummary {
  grantId: string;
  tenantId: string;
  scope: string;
  status: string;
  expiresAt: Date;
}

/**
 * Platform-side authorized read access (plan §3.4/§3.6). All cross-tenant reads
 * are mediated by an active support-access grant (verified upstream by
 * SupportAccessGuard, which stashes the grant on the request). This service:
 *   - lists the calling admin's own grants (no tenant context, no audit — it
 *     touches no tenant data, plan §3.6);
 *   - performs each authorized tenant read by FIRST writing a
 *     support_access.accessed audit event into the tenant chain (fail-closed:
 *     if the audit write throws, the read never returns data — plan §3.4), THEN
 *     delegating to the existing read-only services under a platform_admin
 *     actor so the session is honestly attributed and still RLS-isolated to the
 *     one authorized tenant.
 * scope=read_only is structural: this service exposes only reads (plan §3.4).
 */
@Injectable()
export class PlatformSupportService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
    private readonly auditQueryService: AuditQueryService,
    private readonly usersService: UsersService,
    private readonly rolesService: RolesService,
  ) {}

  /** "Which tenants named me?" — no tenant context, no audit (plan §3.6). */
  async listMyGrants(adminId: string): Promise<MyGrantSummary[]> {
    const { rows } = await this.pool.query<MyGrantRow>(
      `SELECT grant_id, tenant_id, scope, status, expires_at
         FROM app_list_support_grants_for_admin($1)`,
      [adminId],
    );
    return rows.map((r) => ({
      grantId: r.grant_id,
      tenantId: r.tenant_id,
      scope: r.scope,
      status: r.status,
      expiresAt: r.expires_at,
    }));
  }

  // Records the cross-boundary access BEFORE the read returns (fail-closed). The
  // grant (from the guard) supplies the tenant + grant id; resourceType/route
  // describe what was read. Identifiers only — no business data in metadata.
  private async auditAccess(
    adminId: string,
    grant: SupportGrant,
    resourceType: string,
    route: string,
  ): Promise<void> {
    await this.auditService.log({
      tenantId: grant.tenantId,
      actorType: 'platform_admin',
      actorId: adminId,
      action: 'support_access.accessed',
      resourceType: 'support_access_grant',
      resourceId: grant.grantId,
      metadata: { scope: grant.scope, resourceType, route },
    });
  }

  private actor(adminId: string, grant: SupportGrant) {
    return {
      userId: adminId,
      tenantId: grant.tenantId,
      dataScope: 'all',
      actorType: 'platform_admin' as const,
    };
  }

  async listAuditLogs(adminId: string, grant: SupportGrant, query: ListAuditLogsQuery) {
    await this.auditAccess(adminId, grant, 'audit_log', 'audit-logs');
    return this.auditQueryService.list(this.actor(adminId, grant), query);
  }

  async getAuditLog(adminId: string, grant: SupportGrant, id: string) {
    await this.auditAccess(adminId, grant, 'audit_log', 'audit-logs/:id');
    return this.auditQueryService.getOne(this.actor(adminId, grant), id);
  }

  async verifyAuditChain(adminId: string, grant: SupportGrant) {
    await this.auditAccess(adminId, grant, 'audit_chain', 'audit-logs/chain/verify');
    return this.auditQueryService.verifyTenantChain(this.actor(adminId, grant));
  }

  async listUsers(adminId: string, grant: SupportGrant, query: ListUsersQuery) {
    await this.auditAccess(adminId, grant, 'user', 'users');
    return this.usersService.list(this.actor(adminId, grant), query);
  }

  async listRoles(adminId: string, grant: SupportGrant) {
    await this.auditAccess(adminId, grant, 'role', 'roles');
    return this.rolesService.list(this.actor(adminId, grant));
  }
}
