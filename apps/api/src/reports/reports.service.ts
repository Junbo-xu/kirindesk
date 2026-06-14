import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { Caliber, Granularity, GroupBy, ReportSummaryQuery } from './dto/report-summary.query';
import {
  caliberStatuses,
  DEFAULT_CALIBER,
  DEFAULT_GRANULARITY,
  DEFAULT_GROUP_BY,
} from './report-caliber';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

// One grouped row of an aggregate.
export interface ReportRow {
  key: string; // status code | customer/supplier id | period bucket
  label: string; // zh-CN status label | entity name | period bucket
  orderCount: number;
  amountBase: string; // SUM(total_amount_base) over in-caliber rows, decimal string
  unCostedCount: number; // in-caliber rows with NULL base (§2.2)
}

export interface ReportSummary {
  caliber: Caliber;
  currency: string; // tenant base currency the amounts are in
  range: { from: string; to: string; granularity: Granularity };
  groupBy: GroupBy;
  rows: ReportRow[];
  totals: { orderCount: number; amountBase: string; unCostedCount: number };
}

type Side = 'sales' | 'purchase';

const DEFAULT_BASE_CURRENCY = 'RMB';

// zh-CN status labels, shared with the order lifecycle (1F-C).
const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  confirmed: '已确认',
  completed: '已完成',
  cancelled: '已取消',
};

interface SideConfig {
  table: string;
  entityGroup: GroupBy; // the entity grouping this side allows
  entityTable: string;
  entityFk: string;
}

const SIDE: Record<Side, SideConfig> = {
  sales: {
    table: 'sales_orders',
    entityGroup: 'customer',
    entityTable: 'customers',
    entityFk: 'customer_id',
  },
  purchase: {
    table: 'purchase_orders',
    entityGroup: 'supplier',
    entityTable: 'suppliers',
    entityFk: 'supplier_id',
  },
};

interface AggRow {
  key: string;
  label: string | null;
  order_count: string;
  amount_base: string | null;
  uncosted_count: string;
}

@Injectable()
export class ReportsService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  // Reads the tenant base currency from tenant_settings (same source/fallback
  // as the order services), inside the caller's tenant-context transaction.
  private async getBaseCurrency(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ base_currency: string | null }>(
      `SELECT value_json #>> '{}' AS base_currency
         FROM tenant_settings
        WHERE key = 'base_currency'
        LIMIT 1`,
    );
    return rows[0]?.base_currency ?? DEFAULT_BASE_CURRENCY;
  }

  async salesSummary(actor: RequestActor, query: ReportSummaryQuery): Promise<ReportSummary> {
    return this.summary('sales', actor, query);
  }

  async purchaseSummary(actor: RequestActor, query: ReportSummaryQuery): Promise<ReportSummary> {
    return this.summary('purchase', actor, query);
  }

  private async summary(
    side: Side,
    actor: RequestActor,
    query: ReportSummaryQuery,
  ): Promise<ReportSummary> {
    const cfg = SIDE[side];
    const caliber: Caliber = query.caliber ?? DEFAULT_CALIBER;
    const groupBy: GroupBy = query.groupBy ?? DEFAULT_GROUP_BY;
    const granularity: Granularity = query.granularity ?? DEFAULT_GRANULARITY;

    // The entity grouping is side-specific: sales groups by customer, purchase
    // by supplier. Reject the wrong one rather than silently accepting it.
    if (
      (groupBy === 'customer' && side !== 'sales') ||
      (groupBy === 'supplier' && side !== 'purchase')
    ) {
      throw new BadRequestException(`groupBy '${groupBy}' is not valid for ${side} reports`);
    }

    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (from > to) {
      throw new BadRequestException('`from` must be on or before `to`');
    }

    const statuses = caliberStatuses(caliber);

    const o = 'o'; // base table alias

    // Build the scoped WHERE. dataScope narrowing is part of the aggregation
    // predicate (applied BEFORE GROUP BY), never a post-aggregation mask, so an
    // own-scoped caller's totals can only ever cover their own rows (§D3).
    const params: unknown[] = [];
    const conditions: string[] = [`${o}.deleted_at IS NULL`];

    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      conditions.push(`${o}.owner_user_id = $${params.length}`);
    }

    // Inclusive date range on created_at: [from 00:00, to+1day).
    params.push(from);
    conditions.push(`${o}.created_at >= $${params.length}::date`);
    params.push(to);
    conditions.push(`${o}.created_at < ($${params.length}::date + INTERVAL '1 day')`);

    // Caliber status set drives which rows feed the summed amount. We include
    // the status filter in the aggregation so the totals reflect the caliber;
    // the per-status breakdown (groupBy=status) still shows each in-caliber
    // bucket. `cancelled` is excluded by construction (never in any caliber set).
    params.push(statuses);
    conditions.push(`${o}.status = ANY($${params.length}::text[])`);

    const where = `WHERE ${conditions.join(' AND ')}`;

    // Group key + label expressions per dimension.
    let keyExpr: string;
    let labelExpr: string;
    let joinClause = '';
    let orderExpr: string;

    if (groupBy === 'status') {
      keyExpr = `${o}.status`;
      labelExpr = `${o}.status`; // mapped to zh-CN in JS
      orderExpr = `${o}.status`;
    } else if (groupBy === 'period') {
      const fmt = granularity === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
      keyExpr = `to_char(${o}.created_at, '${fmt}')`;
      labelExpr = keyExpr;
      orderExpr = keyExpr;
    } else {
      // customer / supplier
      keyExpr = `${o}.${cfg.entityFk}::text`;
      labelExpr = `e.company_name`;
      joinClause = `LEFT JOIN ${cfg.entityTable} e ON e.id = ${o}.${cfg.entityFk}`;
      orderExpr = `e.company_name`;
    }

    const sql = `
      SELECT
        ${keyExpr} AS key,
        ${labelExpr} AS label,
        COUNT(*)::text AS order_count,
        COALESCE(SUM(${o}.total_amount_base), 0)::text AS amount_base,
        COUNT(*) FILTER (WHERE ${o}.total_amount_base IS NULL)::text AS uncosted_count
      FROM ${cfg.table} ${o}
      ${joinClause}
      ${where}
      GROUP BY ${keyExpr}${groupBy === 'customer' || groupBy === 'supplier' ? `, ${labelExpr}` : ''}
      ORDER BY ${orderExpr}
    `;

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const baseCurrency = await this.getBaseCurrency(client);
        const res = await client.query<AggRow>(sql, params);

        const rows: ReportRow[] = res.rows.map((r) => ({
          key: r.key,
          label: this.labelFor(groupBy, r.key, r.label),
          orderCount: parseInt(r.order_count, 10),
          amountBase: r.amount_base ?? '0',
          unCostedCount: parseInt(r.uncosted_count, 10),
        }));

        const totals = rows.reduce(
          (acc, row) => {
            acc.orderCount += row.orderCount;
            acc.amountBase += BigInt(row.amountBase.replace('.', '')); // cents-safe add
            acc.unCostedCount += row.unCostedCount;
            return acc;
          },
          { orderCount: 0, amountBase: 0n, unCostedCount: 0 },
        );

        return {
          caliber,
          currency: baseCurrency,
          range: { from: query.from, to: query.to, granularity },
          groupBy,
          rows,
          totals: {
            orderCount: totals.orderCount,
            amountBase: this.centsToDecimal(totals.amountBase),
            unCostedCount: totals.unCostedCount,
          },
        };
      },
    );
  }

  private labelFor(groupBy: GroupBy, key: string, dbLabel: string | null): string {
    if (groupBy === 'status') return STATUS_LABELS[key] ?? key;
    return dbLabel ?? key;
  }

  // total_amount_base is numeric(18,2); each row's amountBase string has exactly
  // 2 decimals. Sum in integer cents (BigInt) to avoid float drift, then format.
  private centsToDecimal(cents: bigint): string {
    const neg = cents < 0n;
    const abs = neg ? -cents : cents;
    const s = abs.toString().padStart(3, '0');
    const whole = s.slice(0, -2);
    const frac = s.slice(-2);
    return `${neg ? '-' : ''}${whole}.${frac}`;
  }

  private parseDate(value: string, field: string): string {
    // class-validator already enforced ISO8601; normalize to a date-only string.
    const d = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new BadRequestException(`\`${field}\` must be a valid YYYY-MM-DD date`);
    }
    return d;
  }
}
