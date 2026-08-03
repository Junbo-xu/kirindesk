import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { RbacService } from '../rbac/rbac.service';
import { ListBusinessEventsQuery } from './dto/list-business-events.query';

export interface BusinessEventActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface RecordBusinessEventInput {
  tenantId: string;
  chainType: string;
  chainId: string;
  credentialType: string;
  credentialId: string;
  eventType: string;
  actorType: 'tenant_user' | 'platform_admin' | 'system';
  actorId?: string | null;
  scopeUserId?: string | null;
  visibilityPermission: string;
  occurredAt?: Date;
}

interface BusinessEventRow {
  id: string;
  chain_type: string;
  chain_id: string;
  credential_type: string;
  credential_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  occurred_at: Date;
}

const AUDIT_VISIBILITY_SQL = `CASE
  WHEN al.resource_type = 'customer' THEN 'customers:view'
  WHEN al.resource_type IN ('inquiry', 'quote_selection') THEN 'inquiries:view'
  WHEN al.resource_type IN ('sales_order', 'sales_order_approval') THEN 'orders:view'
  WHEN al.resource_type = 'supplier' THEN 'suppliers:view'
  WHEN al.resource_type IN ('purchase_order', 'purchase_order_approval') THEN 'procurement:view'
  WHEN al.resource_type = 'quote_task' THEN 'quotations:view'
  WHEN al.resource_type = 'file' THEN 'files:view'
  WHEN al.resource_type = 'report' THEN 'reports:view'
  WHEN al.resource_type IN (
    'finance_review', 'profit_snapshot', 'commission_rule_version', 'commission_candidate_v2'
  ) THEN 'finance_reviews:view'
  WHEN al.resource_type LIKE 'commission%' THEN 'commission_tables:view'
  WHEN al.resource_type = 'business_exception' THEN 'business_exceptions:view'
  ELSE NULL
END`;

@Injectable()
export class BusinessEventsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly rbac: RbacService,
  ) {}

  async recordInTransaction(client: PoolClient, input: RecordBusinessEventInput): Promise<void> {
    await client.query(
      `INSERT INTO business_events
         (tenant_id, chain_type, chain_id, credential_type, credential_id, event_type,
          actor_type, actor_id, scope_user_id, visibility_permission, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.tenantId,
        input.chainType,
        input.chainId,
        input.credentialType,
        input.credentialId,
        input.eventType,
        input.actorType,
        input.actorId ?? null,
        input.scopeUserId ?? null,
        input.visibilityPermission,
        input.occurredAt ?? new Date(),
      ],
    );
  }

  async list(actor: BusinessEventActor, query: ListBusinessEventsQuery) {
    if (Boolean(query.chainType) !== Boolean(query.chainId)) {
      throw new BadRequestException('chainType and chainId must be provided together');
    }

    const permissions = await this.rbac.listEffectivePermissions(actor.userId, actor.tenantId);
    const timelineScope = permissions.get('business_events:view') ?? 'none';
    const allPermissions: string[] = [];
    const narrowedPermissions: string[] = [];
    for (const [code, scope] of permissions) {
      if (scope === 'all' && timelineScope === 'all') allPermissions.push(code);
      else if (scope === 'own' || scope === 'assigned') narrowedPermissions.push(code);
      else if (scope === 'all' && (timelineScope === 'own' || timelineScope === 'assigned')) {
        narrowedPermissions.push(code);
      }
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 30;
    const offset = (page - 1) * pageSize;

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [allPermissions, narrowedPermissions, actor.userId];
        let relatedChainCtes = '';
        let chainFilter = '';
        if (query.chainType && query.chainId) {
          params.push(query.chainType, query.chainId);
          relatedChainCtes = `
            visible_chain_edges(from_type, from_id, to_type, to_id) AS (
              SELECT be.chain_type, be.chain_id, be.credential_type, be.credential_id
                FROM business_events be
               WHERE be.visibility_permission = ANY($1::text[])
                  OR (
                    be.visibility_permission = ANY($2::text[])
                    AND be.scope_user_id = $3
                  )
              UNION
              SELECT be.credential_type, be.credential_id, be.chain_type, be.chain_id
                FROM business_events be
               WHERE be.visibility_permission = ANY($1::text[])
                  OR (
                    be.visibility_permission = ANY($2::text[])
                    AND be.scope_user_id = $3
                  )
            ),
            related_chains(chain_type, chain_id) AS (
              SELECT $4::text, $5::uuid
              UNION
              SELECT edges.to_type, edges.to_id
                FROM related_chains related
                JOIN visible_chain_edges edges
                  ON edges.from_type = related.chain_type
                 AND edges.from_id = related.chain_id
            ),
          `;
          chainFilter = `AND EXISTS (
            SELECT 1
              FROM related_chains related
             WHERE related.chain_type = projected.chain_type
               AND related.chain_id = projected.chain_id
          )`;
        }

        const projection = `
          WITH RECURSIVE ${relatedChainCtes} projected AS (
            SELECT 'event:' || be.id::text AS id,
                   be.chain_type, be.chain_id,
                   be.credential_type, be.credential_id,
                   be.event_type, be.actor_type, be.actor_id,
                   u.name AS actor_name, be.occurred_at,
                   be.visibility_permission,
                   be.scope_user_id
              FROM business_events be
              LEFT JOIN users u ON u.id = be.actor_id AND be.actor_type = 'tenant_user'
            UNION ALL
            SELECT 'audit:' || al.id::text AS id,
                   al.resource_type AS chain_type,
                   al.resource_id::uuid AS chain_id,
                   al.resource_type AS credential_type,
                   al.resource_id::uuid AS credential_id,
                   al.action AS event_type,
                   al.actor_type, al.actor_id,
                   au.name AS actor_name, al.created_at AS occurred_at,
                   ${AUDIT_VISIBILITY_SQL} AS visibility_permission,
                   al.actor_id AS scope_user_id
              FROM audit_logs al
              LEFT JOIN users au ON au.id = al.actor_id AND al.actor_type = 'tenant_user'
             WHERE al.tenant_id = current_setting('app.current_tenant_id')::uuid
               AND al.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               AND al.resource_type <> 'supplier_quotation'
          )
        `;
        const visibility = `(
          visibility_permission = ANY($1::text[])
          OR (visibility_permission = ANY($2::text[]) AND scope_user_id = $3)
        )`;
        const where = `WHERE visibility_permission IS NOT NULL AND ${visibility} ${chainFilter}`;

        const totalResult = await client.query<{ count: string }>(
          `${projection} SELECT COUNT(*)::text AS count FROM projected ${where}`,
          params,
        );
        const dataParams = [...params, pageSize, offset];
        const dataResult = await client.query<BusinessEventRow>(
          `${projection}
           SELECT id, chain_type, chain_id::text AS chain_id,
                  credential_type, credential_id::text AS credential_id,
                  event_type, actor_type, actor_id, actor_name, occurred_at
             FROM projected
             ${where}
            ORDER BY occurred_at DESC, id DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          dataParams,
        );

        return {
          data: dataResult.rows.map((row) => ({
            id: row.id,
            chainType: row.chain_type,
            chainId: row.chain_id,
            credentialType: row.credential_type,
            credentialId: row.credential_id,
            eventType: row.event_type,
            actorType: row.actor_type,
            actorId: row.actor_id,
            actorName: row.actor_name,
            occurredAt: row.occurred_at,
          })),
          page,
          pageSize,
          total: Number(totalResult.rows[0].count),
        };
      },
    );
  }
}
