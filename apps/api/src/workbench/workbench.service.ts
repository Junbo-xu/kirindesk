import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { RbacService } from '../rbac/rbac.service';

interface WorkbenchActor {
  userId: string;
  tenantId: string;
}

interface CountRow {
  count: string;
  amount?: string | null;
}

@Injectable()
export class WorkbenchService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly rbac: RbacService,
  ) {}

  async get(actor: WorkbenchActor) {
    const permissions = await this.rbac.listEffectivePermissions(actor.userId, actor.tenantId);
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const tasks: Array<Record<string, unknown>> = [];
        const summaries: Array<Record<string, unknown>> = [];
        const capabilities: string[] = [];

        if (permissions.has('inquiries:view') || permissions.has('orders:view')) {
          capabilities.push('business');
        }
        if (permissions.has('quotations:view') || permissions.has('procurement:view')) {
          capabilities.push('procurement');
        }
        if (
          permissions.has('finance:view') ||
          permissions.has('reports:view') ||
          permissions.has('commission_tables:view')
        ) {
          capabilities.push('finance');
        }
        if (permissions.has('orders:approve') || permissions.has('procurement:approve')) {
          capabilities.push('approver');
        }
        if (
          permissions.has('users:view') ||
          permissions.has('roles:view') ||
          permissions.has('audit_logs:view')
        ) {
          capabilities.push('admin');
        }

        if (permissions.has('inquiries:view')) {
          const row = await this.scopedCount(
            client,
            'owner_user_id',
            permissions.get('inquiries:view')!,
            actor.userId,
            `status = 'draft'`,
          );
          tasks.push({
            key: 'inquiries.draft',
            label: '待提交询盘',
            count: Number(row.count),
            href: '/inquiries',
            urgency: 'normal',
          });
        }

        if (permissions.get('quotations:view') === 'all') {
          const result = await client.query<CountRow>(
            `SELECT COUNT(*)::text AS count FROM quote_tasks
              WHERE sanitization_status IN ('pending','timeout','rate_limited','parse_failed','provider_failed')`,
          );
          tasks.push({
            key: 'quotations.pending',
            label: '待处理报价任务',
            count: Number(result.rows[0].count),
            href: '/quote-tasks',
            urgency: 'high',
          });
        }

        await this.addApprovalTask(
          client,
          permissions,
          tasks,
          'orders:approve',
          'sales_orders',
          'approvals.sales',
          '待审销售订单',
          '/orders',
        );
        await this.addApprovalTask(
          client,
          permissions,
          tasks,
          'procurement:approve',
          'purchase_orders',
          'approvals.purchase',
          '待审采购订单',
          '/purchase-orders',
        );

        if (permissions.has('business_exceptions:view')) {
          const scope = permissions.get('business_exceptions:view')!;
          const result = await this.scopedExceptionCount(client, scope, actor.userId);
          tasks.push({
            key: 'exceptions.open',
            label: '未关闭异常',
            count: Number(result.count),
            href: '/exceptions',
            urgency: Number(result.critical_count) > 0 ? 'critical' : 'high',
          });
          summaries.push({
            key: 'exceptions.critical',
            label: '严重异常',
            value: result.critical_count,
            href: '/exceptions?status=open',
          });
        }

        if (permissions.has('orders:view')) {
          const row = await this.scopedOrderSummary(
            client,
            'sales_orders',
            permissions.get('orders:view')!,
            actor.userId,
          );
          summaries.push({
            key: 'sales.pipeline',
            label: '销售在途',
            value: row.count,
            amount: row.amount ?? '0.00',
            currency: await this.baseCurrency(client),
            href: '/orders',
          });
        }

        if (permissions.has('procurement:view')) {
          const row = await this.scopedOrderSummary(
            client,
            'purchase_orders',
            permissions.get('procurement:view')!,
            actor.userId,
          );
          summaries.push({
            key: 'procurement.pipeline',
            label: '采购在途',
            value: row.count,
            amount: row.amount ?? '0.00',
            currency: await this.baseCurrency(client),
            href: '/purchase-orders',
          });
        }

        if (permissions.get('finance:view') === 'all') {
          const result = await client.query<CountRow>(
            `SELECT COUNT(*)::text AS count FROM (
               SELECT id FROM sales_orders
                WHERE deleted_at IS NULL AND status NOT IN ('draft','cancelled') AND total_amount_base IS NULL
               UNION ALL
               SELECT id FROM purchase_orders
                WHERE deleted_at IS NULL AND status NOT IN ('draft','cancelled') AND total_amount_base IS NULL
             ) missing_fx`,
          );
          tasks.push({
            key: 'finance.missing_fx',
            label: '待补汇率金额',
            count: Number(result.rows[0].count),
            href: '/reports',
            urgency: 'high',
          });
        }

        if (permissions.get('users:view') === 'all') {
          const result = await client.query<CountRow>(
            `SELECT COUNT(*)::text AS count FROM users WHERE status = 'active' AND deleted_at IS NULL`,
          );
          summaries.push({
            key: 'admin.active_users',
            label: '启用用户',
            value: result.rows[0].count,
            href: '/users',
          });
        }

        return {
          generatedAt: new Date(),
          capabilities,
          tasks,
          summaries,
        };
      },
    );
  }

  private async addApprovalTask(
    client: PoolClient,
    permissions: Map<string, string>,
    tasks: Array<Record<string, unknown>>,
    permission: string,
    table: string,
    key: string,
    label: string,
    href: string,
  ) {
    if (permissions.get(permission) !== 'all') return;
    const result = await client.query<CountRow>(
      `SELECT COUNT(*)::text AS count FROM ${table}
        WHERE deleted_at IS NULL AND status = 'pending_approval'`,
    );
    tasks.push({ key, label, count: Number(result.rows[0].count), href, urgency: 'high' });
  }

  private async scopedCount(
    client: PoolClient,
    ownerColumn: string,
    scope: string,
    userId: string,
    baseCondition: string,
  ) {
    const params: unknown[] = [];
    let ownerCondition = '';
    if (scope === 'own' || scope === 'assigned') {
      params.push(userId);
      ownerCondition = ` AND ${ownerColumn} = $1`;
    }
    const result = await client.query<CountRow>(
      `SELECT COUNT(*)::text AS count FROM inquiries WHERE ${baseCondition}${ownerCondition}`,
      params,
    );
    return result.rows[0];
  }

  private async scopedOrderSummary(
    client: PoolClient,
    table: string,
    scope: string,
    userId: string,
  ) {
    const params: unknown[] = [];
    let ownerCondition = '';
    if (scope === 'own' || scope === 'assigned') {
      params.push(userId);
      ownerCondition = ` AND owner_user_id = $1`;
    }
    const result = await client.query<CountRow>(
      `SELECT COUNT(*)::text AS count,
              COALESCE(SUM(total_amount_base), 0)::text AS amount
         FROM ${table}
        WHERE deleted_at IS NULL AND status IN ('pending_approval','approved','confirmed')${ownerCondition}`,
      params,
    );
    return result.rows[0];
  }

  private async scopedExceptionCount(client: PoolClient, scope: string, userId: string) {
    const params: unknown[] = [];
    let scopeCondition = '';
    if (scope === 'own') {
      params.push(userId);
      scopeCondition = ` AND owner_user_id = $1`;
    } else if (scope === 'assigned') {
      params.push(userId);
      scopeCondition = ` AND assigned_to_user_id = $1`;
    }
    const result = await client.query<{ count: string; critical_count: string }>(
      `SELECT COUNT(*)::text AS count,
              COUNT(*) FILTER (WHERE severity = 'critical')::text AS critical_count
         FROM business_exceptions
        WHERE status <> 'closed'${scopeCondition}`,
      params,
    );
    return result.rows[0];
  }

  private async baseCurrency(client: PoolClient) {
    const result = await client.query<{ currency: string | null }>(
      `SELECT value_json #>> '{}' AS currency
         FROM tenant_settings WHERE key = 'base_currency' LIMIT 1`,
    );
    return result.rows[0]?.currency ?? 'RMB';
  }
}
