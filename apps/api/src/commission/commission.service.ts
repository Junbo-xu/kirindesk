import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { CommissionCaliber, DEFAULT_CALIBER, caliberStatuses } from './commission-caliber';
import { CommissionQuery } from './dto/commission-query.dto';
import {
  CreateCommissionTableDto,
  ReplaceCommissionRulesDto,
  UpdateCommissionTableDto,
} from './dto/commission-table.dto';
import { CreateSettlementDto, UnlockSettlementDto } from './dto/settlement.dto';
import { centsToDecimal, commissionCents, decimalToCents } from './commission-money';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

type RateSource = 'rule' | 'default' | 'none';

export interface CommissionSummaryRow {
  salespersonId: string;
  salespersonName: string;
  basisBase: string;
  rateApplied: string;
  rateSource: RateSource;
  commissionBase: string;
  orderCount: number;
  unCostedCount: number;
}

export interface CommissionOrderRow {
  orderId: string;
  orderNumber: string;
  orderType: 'sales' | 'purchase';
  salespersonId: string;
  salespersonName: string;
  amountBase: string | null;
  rateApplied: string;
  rateSource: RateSource;
  commissionBase: string;
  status: string;
}

interface Envelope {
  caliber: CommissionCaliber;
  currency: string;
  range: { from: string; to: string };
  tableId: string | null;
  locked: boolean;
}

export interface CommissionSummary extends Envelope {
  rows: CommissionSummaryRow[];
  totals: { basisBase: string; commissionBase: string; orderCount: number; unCostedCount: number };
}

export interface CommissionOrders extends Envelope {
  rows: CommissionOrderRow[];
  totals: { basisBase: string; commissionBase: string; orderCount: number; unCostedCount: number };
}

const DEFAULT_BASE_CURRENCY = 'RMB';

interface OrderRow {
  order_id: string;
  order_number: string;
  order_type: 'sales' | 'purchase';
  owner_user_id: string;
  owner_name: string | null;
  total_amount_base: string | null;
  status: string;
}

interface ResolvedTable {
  id: string;
  default_rate: string;
}

@Injectable()
export class CommissionService {
  private readonly logger = new Logger(CommissionService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private parseDate(value: string, field: string): string {
    const d = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new BadRequestException(`\`${field}\` must be a valid YYYY-MM-DD date`);
    }
    return d;
  }

  private async getBaseCurrency(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ base_currency: string | null }>(
      `SELECT value_json #>> '{}' AS base_currency
         FROM tenant_settings WHERE key = 'base_currency' LIMIT 1`,
    );
    return rows[0]?.base_currency ?? DEFAULT_BASE_CURRENCY;
  }

  // Resolves the commission table to apply: an explicit tableId (404 if missing),
  // else the tenant's single active table, else null (rate 0 fallback, §2.3).
  private async resolveTable(client: PoolClient, tableId?: string): Promise<ResolvedTable | null> {
    if (tableId) {
      const { rows } = await client.query<ResolvedTable>(
        `SELECT id, default_rate::text AS default_rate FROM commission_tables WHERE id = $1`,
        [tableId],
      );
      if (rows.length === 0) throw new NotFoundException('Commission table not found');
      return rows[0];
    }
    const { rows } = await client.query<ResolvedTable>(
      `SELECT id, default_rate::text AS default_rate FROM commission_tables
        WHERE status = 'active' ORDER BY created_at ASC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  // Per-salesperson rate overrides for a table.
  private async loadRules(client: PoolClient, tableId: string): Promise<Map<string, string>> {
    const { rows } = await client.query<{ salesperson_user_id: string; rate: string }>(
      `SELECT salesperson_user_id, rate::text AS rate
         FROM commission_rate_rules WHERE commission_table_id = $1`,
      [tableId],
    );
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.salesperson_user_id, r.rate);
    return map;
  }

  // Loads in-caliber orders across both order types for the period + scope.
  private async loadOrders(
    client: PoolClient,
    actor: RequestActor,
    statuses: readonly string[],
    from: string,
    to: string,
    salespersonId?: string,
  ): Promise<OrderRow[]> {
    const params: unknown[] = [statuses, from, to];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND o.owner_user_id = $${params.length}`;
    } else if (salespersonId) {
      params.push(salespersonId);
      scope = ` AND o.owner_user_id = $${params.length}`;
    }
    const sel = (table: string, type: string) => `
      SELECT o.id AS order_id, o.order_number, '${type}' AS order_type,
             o.owner_user_id, u.name AS owner_name,
             o.total_amount_base::text AS total_amount_base, o.status
        FROM ${table} o
        LEFT JOIN users u ON u.id = o.owner_user_id
       WHERE o.deleted_at IS NULL
         AND o.status = ANY($1::text[])
         AND o.created_at >= $2::date
         AND o.created_at < ($3::date + INTERVAL '1 day')${scope}`;
    const sql = `${sel('sales_orders', 'sales')} UNION ALL ${sel('purchase_orders', 'purchase')}`;
    const { rows } = await client.query<OrderRow>(sql, params);
    return rows;
  }

  private rateFor(
    ownerId: string,
    rules: Map<string, string>,
    table: ResolvedTable | null,
  ): { rate: string; source: RateSource } {
    const rule = rules.get(ownerId);
    if (rule !== undefined) return { rate: rule, source: 'rule' };
    if (table && table.default_rate !== undefined) {
      // default_rate 0 still counts as a configured default (source 'default'),
      // but when there is no table at all we fall to 'none' below.
      return { rate: table.default_rate, source: 'default' };
    }
    return { rate: '0', source: 'none' };
  }

  async summary(actor: RequestActor, query: CommissionQuery): Promise<CommissionSummary> {
    const caliber = query.caliber ?? DEFAULT_CALIBER;
    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (from > to) throw new BadRequestException('`from` must be on or before `to`');

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const currency = await this.getBaseCurrency(client);
        const table = await this.resolveTable(client, query.tableId);

        const locked = table
          ? await this.findCurrentSettlement(client, table.id, from, to, caliber)
          : null;
        if (locked) {
          return this.summaryFromSettlement(client, locked, caliber, currency, from, to);
        }

        const rules = table ? await this.loadRules(client, table.id) : new Map<string, string>();
        const statuses = caliberStatuses(caliber);
        const orders = await this.loadOrders(
          client,
          actor,
          statuses,
          from,
          to,
          query.salespersonId,
        );

        // Aggregate per salesperson, computing each order's commission in cents
        // (round per order, then sum — §2.2).
        const agg = new Map<
          string,
          {
            name: string;
            rate: string;
            source: RateSource;
            basis: bigint;
            commission: bigint;
            orders: number;
            uncosted: number;
          }
        >();
        for (const o of orders) {
          const { rate, source } = this.rateFor(o.owner_user_id, rules, table);
          let e = agg.get(o.owner_user_id);
          if (!e) {
            e = {
              name: o.owner_name ?? o.owner_user_id,
              rate,
              source,
              basis: 0n,
              commission: 0n,
              orders: 0,
              uncosted: 0,
            };
            agg.set(o.owner_user_id, e);
          }
          e.orders += 1;
          if (o.total_amount_base === null) {
            e.uncosted += 1;
            continue;
          }
          e.basis += decimalToCents(o.total_amount_base);
          e.commission += commissionCents(o.total_amount_base, rate);
        }

        const rows: CommissionSummaryRow[] = [];
        let tBasis = 0n;
        let tComm = 0n;
        let tOrders = 0;
        let tUncosted = 0;
        for (const [salespersonId, e] of agg) {
          rows.push({
            salespersonId,
            salespersonName: e.name,
            basisBase: centsToDecimal(e.basis),
            rateApplied: e.rate,
            rateSource: e.source,
            commissionBase: centsToDecimal(e.commission),
            orderCount: e.orders,
            unCostedCount: e.uncosted,
          });
          tBasis += e.basis;
          tComm += e.commission;
          tOrders += e.orders;
          tUncosted += e.uncosted;
        }
        rows.sort((a, b) => a.salespersonName.localeCompare(b.salespersonName));

        return {
          caliber,
          currency,
          range: { from, to },
          tableId: table?.id ?? null,
          locked: false,
          rows,
          totals: {
            basisBase: centsToDecimal(tBasis),
            commissionBase: centsToDecimal(tComm),
            orderCount: tOrders,
            unCostedCount: tUncosted,
          },
        };
      },
    );
  }

  // The current (non-superseded) locked settlement for a (table, period, caliber),
  // or null. "Current" = the row that no other row supersedes (plan §4.2).
  private async findCurrentSettlement(
    client: PoolClient,
    tableId: string,
    from: string,
    to: string,
    caliber: CommissionCaliber,
  ): Promise<SettlementRow | null> {
    const { rows } = await client.query<SettlementRow>(
      `SELECT s.* FROM commission_settlements s
        WHERE s.commission_table_id = $1 AND s.period_start = $2::date
          AND s.period_end = $3::date AND s.caliber = $4
          AND NOT EXISTS (
            SELECT 1 FROM commission_settlements x WHERE x.supersedes = s.id
          )
        ORDER BY s.locked_at DESC LIMIT 1`,
      [tableId, from, to, caliber],
    );
    const cur = rows[0];
    if (!cur || cur.status !== 'locked') return null;
    return cur;
  }

  private async summaryFromSettlement(
    client: PoolClient,
    s: SettlementRow,
    caliber: CommissionCaliber,
    currency: string,
    from: string,
    to: string,
  ): Promise<CommissionSummary> {
    const { rows } = await client.query<SettlementLineRow>(
      `SELECT l.*, u.name AS salesperson_name
         FROM commission_settlement_lines l
         LEFT JOIN users u ON u.id = l.salesperson_user_id
        WHERE l.settlement_id = $1`,
      [s.id],
    );
    const summaryRows: CommissionSummaryRow[] = rows.map((l) => ({
      salespersonId: l.salesperson_user_id,
      salespersonName: l.salesperson_name ?? l.salesperson_user_id,
      basisBase: l.basis_base,
      rateApplied: l.rate_applied,
      rateSource: 'rule',
      commissionBase: l.commission_base,
      orderCount: l.order_count,
      unCostedCount: l.uncosted_count,
    }));
    summaryRows.sort((a, b) => a.salespersonName.localeCompare(b.salespersonName));
    const uncosted = rows.reduce((n, l) => n + l.uncosted_count, 0);
    const orderCount = rows.reduce((n, l) => n + l.order_count, 0);
    return {
      caliber,
      currency,
      range: { from, to },
      tableId: s.commission_table_id,
      locked: true,
      rows: summaryRows,
      totals: {
        basisBase: s.total_basis_base,
        commissionBase: s.total_commission_base,
        orderCount,
        unCostedCount: uncosted,
      },
    };
  }

  async orders(actor: RequestActor, query: CommissionQuery): Promise<CommissionOrders> {
    const caliber = query.caliber ?? DEFAULT_CALIBER;
    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (from > to) throw new BadRequestException('`from` must be on or before `to`');

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const currency = await this.getBaseCurrency(client);
        const table = await this.resolveTable(client, query.tableId);
        const rules = table ? await this.loadRules(client, table.id) : new Map<string, string>();
        const statuses = caliberStatuses(caliber);
        const orderRows = await this.loadOrders(
          client,
          actor,
          statuses,
          from,
          to,
          query.salespersonId,
        );

        const rows: CommissionOrderRow[] = [];
        let tBasis = 0n;
        let tComm = 0n;
        let tUncosted = 0;
        for (const o of orderRows) {
          const { rate, source } = this.rateFor(o.owner_user_id, rules, table);
          const uncosted = o.total_amount_base === null;
          const commission = uncosted ? 0n : commissionCents(o.total_amount_base as string, rate);
          rows.push({
            orderId: o.order_id,
            orderNumber: o.order_number,
            orderType: o.order_type,
            salespersonId: o.owner_user_id,
            salespersonName: o.owner_name ?? o.owner_user_id,
            amountBase: o.total_amount_base,
            rateApplied: rate,
            rateSource: source,
            commissionBase: centsToDecimal(commission),
            status: o.status,
          });
          if (uncosted) {
            tUncosted += 1;
          } else {
            tBasis += decimalToCents(o.total_amount_base as string);
            tComm += commission;
          }
        }
        rows.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));

        return {
          caliber,
          currency,
          range: { from, to },
          tableId: table?.id ?? null,
          locked: false,
          rows,
          totals: {
            basisBase: centsToDecimal(tBasis),
            commissionBase: centsToDecimal(tComm),
            orderCount: rows.length,
            unCostedCount: tUncosted,
          },
        };
      },
    );
  }

  // ---- Rate table management (writes, audited) -------------------------------

  async listTables(actor: RequestActor): Promise<CommissionTableRow[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<CommissionTableRow>(
          `SELECT id, name, default_rate::text AS default_rate, status,
                  created_by, created_at, updated_at
             FROM commission_tables ORDER BY created_at ASC`,
        );
        return rows;
      },
    );
  }

  async getTable(actor: RequestActor, id: string): Promise<CommissionTableDetail> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<CommissionTableRow>(
          `SELECT id, name, default_rate::text AS default_rate, status,
                  created_by, created_at, updated_at
             FROM commission_tables WHERE id = $1`,
          [id],
        );
        if (rows.length === 0) throw new NotFoundException('Commission table not found');
        const rules = await this.loadRules(client, id);
        return {
          ...rows[0],
          rules: [...rules.entries()].map(([salespersonId, rate]) => ({ salespersonId, rate })),
        };
      },
    );
  }

  async createTable(
    actor: RequestActor,
    dto: CreateCommissionTableDto,
  ): Promise<CommissionTableDetail> {
    const created = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<CommissionTableRow>(
          `INSERT INTO commission_tables (tenant_id, name, default_rate, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, default_rate::text AS default_rate, status,
                     created_by, created_at, updated_at`,
          [actor.tenantId, dto.name, dto.defaultRate ?? '0', actor.userId],
        );
        const table = rows[0];
        for (const rule of dto.rules ?? []) {
          await client.query(
            `INSERT INTO commission_rate_rules
               (tenant_id, commission_table_id, salesperson_user_id, rate)
             VALUES ($1, $2, $3, $4)`,
            [actor.tenantId, table.id, rule.salespersonId, rule.rate],
          );
        }
        return table;
      },
    );
    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'commission_table.created',
      resourceId: created.id,
      after: { name: created.name, default_rate: created.default_rate },
    });
    return this.getTable(actor, created.id);
  }

  async updateTable(
    actor: RequestActor,
    id: string,
    dto: UpdateCommissionTableDto,
  ): Promise<CommissionTableDetail> {
    const { before, after } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.lockTableOrThrow(client, id);
        await this.assertNotLocked(client, id);
        const next = {
          name: dto.name ?? existing.name,
          default_rate: dto.defaultRate ?? existing.default_rate,
          status: dto.status ?? existing.status,
        };
        const { rows } = await client.query<CommissionTableRow>(
          `UPDATE commission_tables
              SET name = $1, default_rate = $2, status = $3, updated_at = now()
            WHERE id = $4
            RETURNING id, name, default_rate::text AS default_rate, status,
                      created_by, created_at, updated_at`,
          [next.name, next.default_rate, next.status, id],
        );
        return { before: existing, after: rows[0] };
      },
    );
    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'commission_table.updated',
      resourceId: id,
      before: { name: before.name, default_rate: before.default_rate, status: before.status },
      after: { name: after.name, default_rate: after.default_rate, status: after.status },
    });
    return this.getTable(actor, id);
  }

  async replaceRules(
    actor: RequestActor,
    id: string,
    dto: ReplaceCommissionRulesDto,
  ): Promise<CommissionTableDetail> {
    const before = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.lockTableOrThrow(client, id);
        await this.assertNotLocked(client, id);
        const prior = await this.loadRules(client, id);
        await client.query(`DELETE FROM commission_rate_rules WHERE commission_table_id = $1`, [
          id,
        ]);
        for (const rule of dto.rules) {
          await client.query(
            `INSERT INTO commission_rate_rules
               (tenant_id, commission_table_id, salesperson_user_id, rate)
             VALUES ($1, $2, $3, $4)`,
            [actor.tenantId, id, rule.salespersonId, rule.rate],
          );
        }
        return [...prior.entries()].map(([salespersonId, rate]) => ({ salespersonId, rate }));
      },
    );
    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'commission_rules.replaced',
      resourceId: id,
      before: { rules: before },
      after: { rules: dto.rules },
    });
    return this.getTable(actor, id);
  }

  // Locks the table row FOR UPDATE (serialises edits + lock, §3 D3), 404 if absent.
  private async lockTableOrThrow(client: PoolClient, id: string): Promise<CommissionTableRow> {
    const { rows } = await client.query<CommissionTableRow>(
      `SELECT id, name, default_rate::text AS default_rate, status,
              created_by, created_at, updated_at
         FROM commission_tables WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException('Commission table not found');
    return rows[0];
  }

  // Editing a table whose rates back a current locked settlement is a 409 (§5.2).
  private async assertNotLocked(client: PoolClient, tableId: string): Promise<void> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT s.id FROM commission_settlements s
        WHERE s.commission_table_id = $1 AND s.status = 'locked'
          AND NOT EXISTS (SELECT 1 FROM commission_settlements x WHERE x.supersedes = s.id)
        LIMIT 1`,
      [tableId],
    );
    if (rows.length > 0) {
      throw new ConflictException('Commission table is locked for a settled period');
    }
  }

  // ---- Lock / settle (privileged, audited) -----------------------------------

  // Locks (settles) a (table, period): derives the period figures under the table
  // row lock and writes one immutable settlement header + per-salesperson lines
  // capturing the rate set + realized order ids into `snapshot` (plan §3 D5 / §5.3).
  // Idempotent: re-locking a current locked period returns the existing snapshot.
  async createSettlement(actor: RequestActor, dto: CreateSettlementDto): Promise<SettlementDetail> {
    const caliber = dto.caliber ?? DEFAULT_CALIBER;
    const from = this.parseDate(dto.from, 'from');
    const to = this.parseDate(dto.to, 'to');
    if (from > to) throw new BadRequestException('`from` must be on or before `to`');

    const { settlementId, idempotent } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.lockTableOrThrow(client, dto.tableId);
        const existing = await this.findCurrentSettlement(client, dto.tableId, from, to, caliber);
        if (existing) return { settlementId: existing.id, idempotent: true };

        const table = await this.resolveTable(client, dto.tableId);
        const rules = table ? await this.loadRules(client, dto.tableId) : new Map<string, string>();
        const statuses = caliberStatuses(caliber);
        // Lock/settle is a tenant-wide payout fact, so it always settles the full
        // tenant (all-scope), independent of the caller's read dataScope.
        const orders = await this.loadOrders(
          client,
          { ...actor, dataScope: 'all' },
          statuses,
          from,
          to,
        );

        const lines = new Map<
          string,
          {
            rate: string;
            basis: bigint;
            commission: bigint;
            orders: number;
            uncosted: number;
            orderIds: string[];
          }
        >();
        for (const o of orders) {
          const { rate } = this.rateFor(o.owner_user_id, rules, table);
          let l = lines.get(o.owner_user_id);
          if (!l) {
            l = { rate, basis: 0n, commission: 0n, orders: 0, uncosted: 0, orderIds: [] };
            lines.set(o.owner_user_id, l);
          }
          l.orders += 1;
          l.orderIds.push(o.order_id);
          if (o.total_amount_base === null) {
            l.uncosted += 1;
            continue;
          }
          l.basis += decimalToCents(o.total_amount_base);
          l.commission += commissionCents(o.total_amount_base, rate);
        }

        let tBasis = 0n;
        let tComm = 0n;
        let tUncosted = 0;
        const snapshotLines: unknown[] = [];
        for (const [salespersonId, l] of lines) {
          tBasis += l.basis;
          tComm += l.commission;
          tUncosted += l.uncosted;
          snapshotLines.push({
            salespersonId,
            rate: l.rate,
            basisBase: centsToDecimal(l.basis),
            commissionBase: centsToDecimal(l.commission),
            orderCount: l.orders,
            unCostedCount: l.uncosted,
            orderIds: l.orderIds,
          });
        }
        const snapshot = {
          period: { from, to },
          caliber,
          defaultRate: table?.default_rate ?? null,
          rules: [...rules.entries()].map(([salespersonId, rate]) => ({ salespersonId, rate })),
          lines: snapshotLines,
        };

        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO commission_settlements
             (tenant_id, commission_table_id, period_start, period_end, caliber, status,
              snapshot, total_commission_base, total_basis_base, uncosted_count, locked_by)
           VALUES ($1, $2, $3::date, $4::date, $5, 'locked', $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            actor.tenantId,
            dto.tableId,
            from,
            to,
            caliber,
            JSON.stringify(snapshot),
            centsToDecimal(tComm),
            centsToDecimal(tBasis),
            tUncosted,
            actor.userId,
          ],
        );
        const id = rows[0].id;
        for (const [salespersonId, l] of lines) {
          await client.query(
            `INSERT INTO commission_settlement_lines
               (tenant_id, settlement_id, salesperson_user_id, basis_base, rate_applied,
                commission_base, order_count, uncosted_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              actor.tenantId,
              id,
              salespersonId,
              centsToDecimal(l.basis),
              l.rate,
              centsToDecimal(l.commission),
              l.orders,
              l.uncosted,
            ],
          );
        }
        return { settlementId: id, idempotent: false };
      },
    );

    if (!idempotent) {
      await this.safeAudit({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: 'commission.locked',
        resourceId: settlementId,
        after: { tableId: dto.tableId, period: { from, to }, caliber },
      });
    }
    return this.getSettlement(actor, settlementId);
  }

  async listSettlements(actor: RequestActor): Promise<SettlementRow[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<SettlementRow>(
          `SELECT id, commission_table_id, period_start::text AS period_start,
                  period_end::text AS period_end, caliber, status,
                  total_commission_base::text AS total_commission_base,
                  total_basis_base::text AS total_basis_base, uncosted_count
             FROM commission_settlements ORDER BY locked_at DESC`,
        );
        return rows;
      },
    );
  }

  async getSettlement(actor: RequestActor, id: string): Promise<SettlementDetail> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<SettlementRow & { snapshot: unknown }>(
          `SELECT id, commission_table_id, period_start::text AS period_start,
                  period_end::text AS period_end, caliber, status,
                  total_commission_base::text AS total_commission_base,
                  total_basis_base::text AS total_basis_base, uncosted_count, snapshot
             FROM commission_settlements WHERE id = $1`,
          [id],
        );
        if (rows.length === 0) throw new NotFoundException('Settlement not found');
        const { rows: lineRows } = await client.query<SettlementLineRow>(
          `SELECT l.salesperson_user_id, u.name AS salesperson_name,
                  l.basis_base::text AS basis_base, l.rate_applied::text AS rate_applied,
                  l.commission_base::text AS commission_base, l.order_count, l.uncosted_count
             FROM commission_settlement_lines l
             LEFT JOIN users u ON u.id = l.salesperson_user_id
            WHERE l.settlement_id = $1`,
          [id],
        );
        return { ...rows[0], lines: lineRows };
      },
    );
  }

  // Unlock = superseding append (plan §4.2): insert a new `unlocked` settlement
  // whose `supersedes` back-points at the current locked row. Never an in-place
  // UPDATE, so the immutable rows stay intact. Audited with the required reason.
  async unlockSettlement(
    actor: RequestActor,
    id: string,
    dto: UnlockSettlementDto,
  ): Promise<SettlementDetail> {
    const newId = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<SettlementRow>(
          `SELECT id, commission_table_id, period_start::text AS period_start,
                  period_end::text AS period_end, caliber, status,
                  total_commission_base::text AS total_commission_base,
                  total_basis_base::text AS total_basis_base, uncosted_count
             FROM commission_settlements WHERE id = $1`,
          [id],
        );
        if (rows.length === 0) throw new NotFoundException('Settlement not found');
        const target = rows[0];
        // Lock the underlying table row so concurrent lock/unlock serialise.
        await this.lockTableOrThrow(client, target.commission_table_id);

        const superseded = await client.query<{ id: string }>(
          `SELECT id FROM commission_settlements WHERE supersedes = $1 LIMIT 1`,
          [id],
        );
        if (target.status !== 'locked' || superseded.rows.length > 0) {
          throw new ConflictException('Settlement is not currently locked');
        }

        const { rows: inserted } = await client.query<{ id: string }>(
          `INSERT INTO commission_settlements
             (tenant_id, commission_table_id, period_start, period_end, caliber, status,
              snapshot, total_commission_base, total_basis_base, uncosted_count,
              locked_by, unlocked_by, unlocked_at, supersedes)
           SELECT tenant_id, commission_table_id, period_start, period_end, caliber, 'unlocked',
                  snapshot, total_commission_base, total_basis_base, uncosted_count,
                  locked_by, $2, now(), id
             FROM commission_settlements WHERE id = $1
           RETURNING id`,
          [id, actor.userId],
        );
        return inserted[0].id;
      },
    );
    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'commission.unlocked',
      resourceId: newId,
      before: { supersededSettlementId: id },
      after: { settlementId: newId },
      reason: dto.reason,
    });
    return this.getSettlement(actor, newId);
  }

  private async safeAudit(params: {
    tenantId: string;
    actorId: string;
    action: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
  }): Promise<void> {
    try {
      await this.auditService.log({
        tenantId: params.tenantId,
        actorType: 'tenant_user',
        actorId: params.actorId,
        action: params.action,
        resourceType: 'commission_table',
        resourceId: params.resourceId,
        before: params.before,
        after: params.after,
        reason: params.reason ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} ${params.resourceId}: ${String(err)}`,
      );
    }
  }
}

export interface CommissionTableRow {
  id: string;
  name: string;
  default_rate: string;
  status: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface CommissionTableDetail extends CommissionTableRow {
  rules: { salespersonId: string; rate: string }[];
}

export interface SettlementRow {
  id: string;
  commission_table_id: string;
  period_start: string;
  period_end: string;
  caliber: CommissionCaliber;
  status: string;
  total_commission_base: string;
  total_basis_base: string;
  uncosted_count: number;
}

export interface SettlementLineRow {
  salesperson_user_id: string;
  salesperson_name: string | null;
  basis_base: string;
  rate_applied: string;
  commission_base: string;
  order_count: number;
  uncosted_count: number;
}

export interface SettlementDetail extends SettlementRow {
  snapshot?: unknown;
  lines: SettlementLineRow[];
}
