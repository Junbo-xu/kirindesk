import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { BusinessEventsService } from '../workbench/business-events.service';
import {
  CalculateCommissionCandidateDto,
  CreateFinanceReviewDto,
  CreateProfitSnapshotDto,
  FinanceConversionDto,
  LockCommissionCandidateDto,
  ReplaceCommissionRulesDto,
} from './dto/finance.dto';
import {
  FinanceConflictException,
  FinanceDutyException,
  FinanceNotFoundException,
  InvalidFinanceDataException,
} from './finance.errors';
import { addMoney, multiplyMoneyByBps, nonNegativeMoney, subtractMoney } from './finance-money';

export interface FinanceActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface SalesOrderRow {
  id: string;
  owner_user_id: string;
  order_number: string;
  currency: string;
  total_amount: string;
  status: string;
}

type SubjectType = 'customer_receipt' | 'purchase_cost' | 'order_expense';

interface SourceFact {
  subject_type: SubjectType;
  id: string;
  amount: string;
  currency: string;
  snapshot: Record<string, unknown>;
  expense_type?: string;
  fx_rate_to_rmb?: string | null;
  fx_source?: string | null;
  fx_captured_at?: Date | null;
  amount_rmb?: string | null;
  status?: string;
}

interface SourceFacts {
  receipts: SourceFact[];
  costs: SourceFact[];
  expenses: SourceFact[];
  missing: string[];
  fingerprint: string;
  snapshot: Record<string, unknown>;
}

interface ReviewItemInput {
  subject_type: SubjectType | 'missing_receipt' | 'missing_cost' | 'missing_freight' | 'missing_fx';
  subject_id: string | null;
  source_amount: string | null;
  source_currency: string | null;
  fx_rate_to_rmb: string | null;
  fx_source: string | null;
  fx_captured_at: Date | null;
  amount_rmb: string | null;
  source_snapshot: Record<string, unknown>;
}

interface ReviewRow {
  id: string;
  sales_order_id: string;
  version: number;
  decision: 'verified' | 'returned';
  reason: string | null;
  input_fingerprint: string;
  missing_items: string[];
  reviewed_by: string;
  reviewed_at: Date;
}

interface ReviewItemRow {
  id: string;
  subject_type: ReviewItemInput['subject_type'];
  subject_id: string | null;
  decision: 'verified' | 'returned';
  reason: string | null;
  source_amount: string | null;
  source_currency: string | null;
  fx_rate_to_rmb: string | null;
  fx_source: string | null;
  fx_captured_at: Date | null;
  amount_rmb: string | null;
  source_snapshot: Record<string, unknown>;
  reviewed_by: string;
  reviewed_at: Date;
}

interface ProfitRow {
  id: string;
  sales_order_id: string;
  version: number;
  status: 'provisional' | 'final';
  supersedes_id: string | null;
  finance_review_id: string | null;
  formula_version: string;
  input_fingerprint: string;
  input_snapshot: Record<string, unknown>;
  missing_items: string[];
  revenue_rmb: string;
  purchase_cost_rmb: string;
  freight_rmb: string;
  other_expense_rmb: string;
  refund_rmb: string;
  gross_profit_rmb: string;
  net_profit_rmb: string;
  created_by: string;
  created_at: Date;
}

interface RuleRow {
  id: string;
  role_type: 'sales' | 'procurement';
  version: number;
  supersedes_id: string | null;
  basis_type: 'sales_revenue' | 'gross_profit' | 'net_profit';
  rate_bps: number;
  created_by: string;
  created_at: Date;
}

interface CandidateRow {
  id: string;
  sales_order_id: string;
  profit_snapshot_id: string;
  version: number;
  supersedes_id: string | null;
  formula_version: string;
  calculation_snapshot: Record<string, unknown>;
  total_commission_rmb: string;
  revision_reason: string | null;
  created_by: string;
  created_at: Date;
  lock_id: string | null;
  locked_by: string | null;
  locked_at: Date | null;
  lock_comment: string | null;
}

interface CandidateLineRow {
  id: string;
  role_type: 'sales' | 'procurement';
  user_id: string;
  user_name: string;
  rule_version_id: string;
  basis_type: 'sales_revenue' | 'gross_profit' | 'net_profit';
  raw_basis_rmb: string;
  eligible_basis_rmb: string;
  share_bps: number;
  allocated_basis_rmb: string;
  rate_bps: number;
  commission_amount_rmb: string;
}

const REVIEW_COLUMNS = `id, sales_order_id, version, decision, reason, input_fingerprint,
  missing_items, reviewed_by, reviewed_at`;
const REVIEW_ITEM_COLUMNS = `id, subject_type, subject_id, decision, reason,
  source_amount::text AS source_amount, source_currency,
  fx_rate_to_rmb::text AS fx_rate_to_rmb, fx_source, fx_captured_at,
  amount_rmb::text AS amount_rmb, source_snapshot, reviewed_by, reviewed_at`;
const PROFIT_COLUMNS = `id, sales_order_id, version, status, supersedes_id, finance_review_id,
  formula_version, input_fingerprint, input_snapshot, missing_items,
  revenue_rmb::text AS revenue_rmb, purchase_cost_rmb::text AS purchase_cost_rmb,
  freight_rmb::text AS freight_rmb, other_expense_rmb::text AS other_expense_rmb,
  refund_rmb::text AS refund_rmb, gross_profit_rmb::text AS gross_profit_rmb,
  net_profit_rmb::text AS net_profit_rmb, created_by, created_at`;
const RULE_COLUMNS = `id, role_type, version, supersedes_id, basis_type, rate_bps,
  created_by, created_at`;
const CANDIDATE_COLUMNS = `candidate.id, candidate.sales_order_id,
  candidate.profit_snapshot_id, candidate.version, candidate.supersedes_id,
  candidate.formula_version, candidate.calculation_snapshot,
  candidate.total_commission_rmb::text AS total_commission_rmb,
  candidate.revision_reason, candidate.created_by, candidate.created_at,
  lock.id AS lock_id, lock.locked_by, lock.locked_at, lock.comment AS lock_comment`;

@Injectable()
export class FinanceService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly events: BusinessEventsService,
  ) {}

  private context(actor: FinanceActor) {
    return { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' as const };
  }

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private assertAllScope(actor: FinanceActor): void {
    if (actor.dataScope !== 'all') {
      throw new FinanceDutyException(
        'This finance action requires an all-scope permission grant',
        'FINANCE_ALL_SCOPE_REQUIRED',
      );
    }
  }

  private async salesOrder(
    client: PoolClient,
    actor: FinanceActor,
    orderId: string,
    lock = false,
  ): Promise<SalesOrderRow> {
    const params: unknown[] = [orderId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id = $${params.length}`;
    }
    const result = await client.query<SalesOrderRow>(
      `SELECT id, owner_user_id, order_number, currency,
              total_amount::text AS total_amount, status
         FROM sales_orders
        WHERE id = $1 AND source_pi_id IS NOT NULL AND deleted_at IS NULL${scope}
        ${lock ? 'FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new FinanceNotFoundException('PI-backed sales order not found');
    }
    return result.rows[0];
  }

  private assertReviewable(order: SalesOrderRow): void {
    if (!['delivered', 'finance_review', 'settled'].includes(order.status)) {
      throw new FinanceConflictException(
        'Finance review starts after delivery',
        'ORDER_NOT_READY_FOR_FINANCE',
      );
    }
  }

  private fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private async sourceFacts(client: PoolClient, order: SalesOrderRow): Promise<SourceFacts> {
    const receiptRows = await client.query<{
      id: string;
      amount: string;
      currency: string;
      received_at: string;
      method: string;
      external_reference: string;
      proof_file_id: string | null;
      decision_id: string;
      decided_at: Date;
    }>(
      `SELECT receipt.id, receipt.amount::text AS amount, receipt.currency,
              receipt.received_at::text AS received_at, receipt.method,
              receipt.external_reference, receipt.proof_file_id,
              decision.id AS decision_id, decision.created_at AS decided_at
         FROM customer_receipts receipt
         JOIN customer_receipt_decisions decision
           ON decision.tenant_id = receipt.tenant_id AND decision.receipt_id = receipt.id
          AND decision.decision = 'confirmed'
        WHERE receipt.sales_order_id = $1
        ORDER BY receipt.created_at, receipt.id`,
      [order.id],
    );
    const receipts: SourceFact[] = receiptRows.rows.map((row) => ({
      subject_type: 'customer_receipt',
      id: row.id,
      amount: row.amount,
      currency: row.currency,
      snapshot: { ...row, decided_at: row.decided_at.toISOString() },
    }));

    const costRows = await client.query<{
      id: string;
      purchase_order_id: string;
      purchase_order_item_id: string;
      order_number: string;
      currency: string;
      final_unit_price: string;
      quantity: string;
      final_line_total: string;
      finalized_by: string;
      created_at: Date;
    }>(
      `SELECT price.id, price.purchase_order_id, price.purchase_order_item_id,
              po.order_number, po.currency,
              price.final_unit_price::text AS final_unit_price,
              price.quantity::text AS quantity,
              price.final_line_total::text AS final_line_total,
              price.finalized_by, price.created_at
         FROM sales_order_purchase_orders link
         JOIN purchase_orders po
           ON po.tenant_id = link.tenant_id AND po.id = link.purchase_order_id
         JOIN purchase_price_snapshots price
           ON price.tenant_id = po.tenant_id AND price.purchase_order_id = po.id
        WHERE link.sales_order_id = $1
        ORDER BY price.created_at, price.id`,
      [order.id],
    );
    const costs: SourceFact[] = costRows.rows.map((row) => ({
      subject_type: 'purchase_cost',
      id: row.id,
      amount: row.final_line_total,
      currency: row.currency,
      snapshot: { ...row, created_at: row.created_at.toISOString() },
    }));

    const priceCoverage = await client.query<{ total: number; priced: number }>(
      `SELECT count(item.id)::integer AS total, count(price.id)::integer AS priced
         FROM sales_order_purchase_orders link
         JOIN purchase_orders po
           ON po.tenant_id = link.tenant_id AND po.id = link.purchase_order_id
         JOIN purchase_order_items item
           ON item.tenant_id = po.tenant_id AND item.order_id = po.id AND item.deleted_at IS NULL
         LEFT JOIN purchase_price_snapshots price
           ON price.tenant_id = item.tenant_id AND price.purchase_order_item_id = item.id
        WHERE link.sales_order_id = $1`,
      [order.id],
    );

    const expenseRows = await client.query<{
      id: string;
      shipment_id: string | null;
      expense_type: string;
      amount: string;
      currency: string;
      fx_rate_to_rmb: string | null;
      fx_source: string | null;
      fx_captured_at: Date | null;
      amount_rmb: string | null;
      status: string;
      recorded_by: string;
      completed_by: string | null;
      completed_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, shipment_id, expense_type, amount::text AS amount, currency,
              fx_rate_to_rmb::text AS fx_rate_to_rmb, fx_source, fx_captured_at,
              amount_rmb::text AS amount_rmb, status, recorded_by, completed_by,
              completed_at, created_at
         FROM order_expenses
        WHERE sales_order_id = $1
        ORDER BY created_at, id`,
      [order.id],
    );
    const expenses: SourceFact[] = expenseRows.rows.map((row) => ({
      subject_type: 'order_expense',
      id: row.id,
      amount: row.amount,
      currency: row.currency,
      expense_type: row.expense_type,
      fx_rate_to_rmb: row.fx_rate_to_rmb,
      fx_source: row.fx_source,
      fx_captured_at: row.fx_captured_at,
      amount_rmb: row.amount_rmb,
      status: row.status,
      snapshot: {
        ...row,
        fx_captured_at: row.fx_captured_at?.toISOString() ?? null,
        completed_at: row.completed_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
      },
    }));

    const missing: string[] = [];
    if (receipts.length === 0) missing.push('missing_receipt');
    if (
      priceCoverage.rows[0].total === 0 ||
      priceCoverage.rows[0].priced !== priceCoverage.rows[0].total
    ) {
      missing.push('missing_cost');
    }
    if (!expenses.some((expense) => expense.expense_type === 'freight')) {
      missing.push('missing_freight');
    }
    for (const expense of expenses) {
      if (expense.status !== 'complete') missing.push(`missing_fx:order_expense:${expense.id}`);
    }

    const snapshot = {
      formula_source_version: 'finance_source_facts_v1',
      order: {
        id: order.id,
        order_number: order.order_number,
        currency: order.currency,
        total_amount: order.total_amount,
      },
      receipts: receipts.map((row) => row.snapshot),
      purchase_costs: costs.map((row) => row.snapshot),
      expenses: expenses.map((row) => row.snapshot),
      missing,
    };
    return {
      receipts,
      costs,
      expenses,
      missing,
      fingerprint: this.fingerprint(snapshot),
      snapshot,
    };
  }

  private conversionKey(type: string, id: string): string {
    return `${type}:${id}`;
  }

  private conversionMap(conversions: FinanceConversionDto[]): Map<string, FinanceConversionDto> {
    const map = new Map<string, FinanceConversionDto>();
    for (const conversion of conversions) {
      const key = this.conversionKey(conversion.subject_type, conversion.subject_id);
      if (map.has(key)) {
        throw new InvalidFinanceDataException(
          'Each finance source can have only one FX conversion',
          'DUPLICATE_FINANCE_CONVERSION',
        );
      }
      map.set(key, conversion);
    }
    return map;
  }

  private async convertedAmount(client: PoolClient, amount: string, rate: string): Promise<string> {
    const result = await client.query<{ amount: string }>(
      `SELECT round($1::numeric * $2::numeric, 2)::text AS amount`,
      [amount, rate],
    );
    return result.rows[0].amount;
  }

  private async reviewItems(
    client: PoolClient,
    facts: SourceFacts,
    conversions: Map<string, FinanceConversionDto>,
  ): Promise<{ items: ReviewItemInput[]; missing: string[] }> {
    const items: ReviewItemInput[] = [];
    const missing = [...facts.missing];
    const sources = [...facts.receipts, ...facts.costs, ...facts.expenses];
    const seenConversions = new Set<string>();

    for (const source of sources) {
      if (source.subject_type === 'order_expense') {
        if (
          source.status !== 'complete' ||
          !source.fx_rate_to_rmb ||
          !source.fx_source ||
          !source.fx_captured_at ||
          !source.amount_rmb
        ) {
          continue;
        }
        items.push({
          subject_type: source.subject_type,
          subject_id: source.id,
          source_amount: source.amount,
          source_currency: source.currency,
          fx_rate_to_rmb: source.fx_rate_to_rmb,
          fx_source: source.fx_source,
          fx_captured_at: source.fx_captured_at,
          amount_rmb: source.amount_rmb,
          source_snapshot: source.snapshot,
        });
        continue;
      }

      if (source.currency === 'RMB') {
        items.push({
          subject_type: source.subject_type,
          subject_id: source.id,
          source_amount: source.amount,
          source_currency: source.currency,
          fx_rate_to_rmb: '1',
          fx_source: 'currency_identity',
          fx_captured_at: new Date(),
          amount_rmb: await this.convertedAmount(client, source.amount, '1'),
          source_snapshot: source.snapshot,
        });
        continue;
      }

      const key = this.conversionKey(source.subject_type, source.id);
      const conversion = conversions.get(key);
      if (!conversion) {
        const code = `missing_fx:${source.subject_type}:${source.id}`;
        if (!missing.includes(code)) missing.push(code);
        continue;
      }
      seenConversions.add(key);
      items.push({
        subject_type: source.subject_type,
        subject_id: source.id,
        source_amount: source.amount,
        source_currency: source.currency,
        fx_rate_to_rmb: conversion.fx_rate_to_rmb,
        fx_source: conversion.fx_source,
        fx_captured_at: new Date(conversion.fx_captured_at),
        amount_rmb: await this.convertedAmount(client, source.amount, conversion.fx_rate_to_rmb),
        source_snapshot: source.snapshot,
      });
    }

    for (const key of conversions.keys()) {
      if (!seenConversions.has(key)) {
        throw new InvalidFinanceDataException(
          `FX conversion does not match a current foreign-currency source: ${key}`,
          'UNKNOWN_FINANCE_CONVERSION',
        );
      }
    }

    for (const code of missing) {
      const subjectType = code.split(':')[0] as ReviewItemInput['subject_type'];
      items.push({
        subject_type: subjectType,
        subject_id: null,
        source_amount: null,
        source_currency: null,
        fx_rate_to_rmb: null,
        fx_source: null,
        fx_captured_at: null,
        amount_rmb: null,
        source_snapshot: { missing_code: code },
      });
    }
    return { items, missing };
  }

  async listOrders(actor: FinanceActor) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const params: unknown[] = [];
      let scope = '';
      if (this.restrictsToOwner(actor.dataScope)) {
        params.push(actor.userId);
        scope = ` AND orders.owner_user_id = $${params.length}`;
      }
      const rows = await client.query<{
        id: string;
        order_number: string;
        status: string;
        currency: string;
        total_amount: string;
        finance_decision: string | null;
        profit_status: string | null;
        commission_status: string | null;
      }>(
        `SELECT orders.id, orders.order_number, orders.status, orders.currency,
                orders.total_amount::text AS total_amount,
                review.decision AS finance_decision, profit.status AS profit_status,
                CASE WHEN candidate.id IS NULL THEN NULL
                     WHEN lock.id IS NULL THEN 'calculated' ELSE 'locked' END AS commission_status
           FROM sales_orders orders
           LEFT JOIN LATERAL (
             SELECT decision FROM finance_reviews
              WHERE sales_order_id = orders.id ORDER BY version DESC LIMIT 1
           ) review ON true
           LEFT JOIN LATERAL (
             SELECT status FROM profit_snapshots
              WHERE sales_order_id = orders.id ORDER BY version DESC LIMIT 1
           ) profit ON true
           LEFT JOIN LATERAL (
             SELECT id FROM commission_candidates_v2
              WHERE sales_order_id = orders.id ORDER BY version DESC LIMIT 1
           ) candidate ON true
           LEFT JOIN commission_candidate_locks_v2 lock ON lock.candidate_id = candidate.id
          WHERE orders.source_pi_id IS NOT NULL AND orders.deleted_at IS NULL
            AND orders.status IN ('delivered','finance_review','settled')${scope}
          ORDER BY orders.updated_at DESC, orders.id`,
        params,
      );
      return rows.rows;
    });
  }

  async getOrder(actor: FinanceActor, orderId: string) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.salesOrder(client, actor, orderId);
      const facts = await this.sourceFacts(client, order);
      return {
        order,
        source_state: {
          fingerprint: facts.fingerprint,
          missing_items: facts.missing,
          receipts: facts.receipts.map((source) => this.sourceResponse(source)),
          purchase_costs: facts.costs.map((source) => this.sourceResponse(source)),
          expenses: facts.expenses.map((source) => this.sourceResponse(source)),
        },
        finance_reviews: await this.reviewHistory(client, order.id),
        profit_snapshots: await this.profitHistory(client, order.id),
        commission_rules: await this.latestRules(client),
        commission_candidates: await this.candidateHistory(client, order.id),
        participants: (
          await client.query<{ id: string; name: string; email: string }>(
            `SELECT id, name, email FROM users
              WHERE status = 'active' AND deleted_at IS NULL ORDER BY name, id`,
          )
        ).rows,
      };
    });
  }

  private sourceResponse(source: SourceFact) {
    return {
      subject_type: source.subject_type,
      id: source.id,
      amount: source.amount,
      currency: source.currency,
      expense_type: source.expense_type ?? null,
      status: source.status ?? 'complete',
      fx_rate_to_rmb: source.fx_rate_to_rmb ?? (source.currency === 'RMB' ? '1' : null),
      fx_source: source.fx_source ?? (source.currency === 'RMB' ? 'currency_identity' : null),
      fx_captured_at: source.fx_captured_at ?? null,
      amount_rmb: source.amount_rmb ?? null,
      needs_fx:
        source.currency !== 'RMB' &&
        source.subject_type !== 'order_expense' &&
        !source.fx_rate_to_rmb,
    };
  }

  async createReview(actor: FinanceActor, orderId: string, dto: CreateFinanceReviewDto) {
    this.assertAllScope(actor);
    if (dto.decision === 'returned' && !dto.reason?.trim()) {
      throw new InvalidFinanceDataException(
        'A return reason is required',
        'FINANCE_RETURN_REASON_REQUIRED',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.salesOrder(client, actor, orderId, true);
      this.assertReviewable(order);
      const facts = await this.sourceFacts(client, order);
      const prepared = await this.reviewItems(client, facts, this.conversionMap(dto.conversions));
      if (dto.decision === 'verified' && prepared.missing.length > 0) {
        throw new FinanceConflictException(
          'Final finance verification requires receipts, purchase costs, freight, and all FX snapshots',
          'FINANCE_INPUTS_INCOMPLETE',
          { missing_items: prepared.missing },
        );
      }
      const nextVersion = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::integer + 1 AS version
           FROM finance_reviews WHERE sales_order_id = $1`,
        [order.id],
      );
      const inserted = await client.query<ReviewRow>(
        `INSERT INTO finance_reviews
           (tenant_id, sales_order_id, version, decision, reason, input_fingerprint,
            missing_items, reviewed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${REVIEW_COLUMNS}`,
        [
          actor.tenantId,
          order.id,
          nextVersion.rows[0].version,
          dto.decision,
          dto.reason?.trim() || null,
          facts.fingerprint,
          JSON.stringify(prepared.missing),
          actor.userId,
        ],
      );
      const review = inserted.rows[0];
      for (const item of prepared.items) {
        await client.query(
          `INSERT INTO finance_review_items
             (tenant_id, finance_review_id, subject_type, subject_id, decision, reason,
              source_amount, source_currency, fx_rate_to_rmb, fx_source, fx_captured_at,
              amount_rmb, source_snapshot, reviewed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            actor.tenantId,
            review.id,
            item.subject_type,
            item.subject_id,
            dto.decision,
            dto.decision === 'returned' ? dto.reason!.trim() : null,
            item.source_amount,
            item.source_currency,
            item.fx_rate_to_rmb,
            item.fx_source,
            item.fx_captured_at,
            item.amount_rmb,
            JSON.stringify(item.source_snapshot),
            actor.userId,
          ],
        );
      }
      if (dto.decision === 'verified' && order.status === 'delivered') {
        await client.query(
          `UPDATE sales_orders SET status = 'finance_review', updated_at = now() WHERE id = $1`,
          [order.id],
        );
      }
      const response = await this.reviewResponse(client, review);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: `finance_review.${dto.decision}`,
        resourceType: 'finance_review',
        resourceId: review.id,
        after: response,
        reason: dto.reason?.trim() || null,
      });
      await this.recordEvent(
        client,
        actor,
        order.id,
        'finance_review',
        review.id,
        `finance_review.${dto.decision}`,
      );
      return response;
    });
  }

  private async reviewHistory(client: PoolClient, orderId: string) {
    const rows = await client.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM finance_reviews
        WHERE sales_order_id = $1 ORDER BY version DESC`,
      [orderId],
    );
    return Promise.all(rows.rows.map((row) => this.reviewResponse(client, row)));
  }

  private async reviewResponse(client: PoolClient, row: ReviewRow) {
    const items = await client.query<ReviewItemRow>(
      `SELECT ${REVIEW_ITEM_COLUMNS} FROM finance_review_items
        WHERE finance_review_id = $1 ORDER BY created_at, id`,
      [row.id],
    );
    return { ...row, items: items.rows };
  }

  async createProfitSnapshot(actor: FinanceActor, orderId: string, dto: CreateProfitSnapshotDto) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.salesOrder(client, actor, orderId, true);
      this.assertReviewable(order);
      const facts = await this.sourceFacts(client, order);
      const latestReview = await client.query<ReviewRow>(
        `SELECT ${REVIEW_COLUMNS} FROM finance_reviews
          WHERE sales_order_id = $1 ORDER BY version DESC LIMIT 1`,
        [order.id],
      );
      const review = latestReview.rows[0] ?? null;
      if (
        dto.status === 'final' &&
        (!review ||
          review.decision !== 'verified' ||
          review.input_fingerprint !== facts.fingerprint)
      ) {
        throw new FinanceConflictException(
          'A current verified finance review is required before final profit',
          'CURRENT_FINANCE_VERIFICATION_REQUIRED',
        );
      }
      const reviewItems = review
        ? (
            await client.query<ReviewItemRow>(
              `SELECT ${REVIEW_ITEM_COLUMNS} FROM finance_review_items
                WHERE finance_review_id = $1 ORDER BY created_at, id`,
              [review.id],
            )
          ).rows
        : [];
      const missing =
        review?.input_fingerprint === facts.fingerprint
          ? review.missing_items
          : [...facts.missing, 'missing_current_finance_review'];
      if (dto.status === 'final' && missing.length > 0) {
        throw new FinanceConflictException(
          'Incomplete inputs cannot produce final profit',
          'FINAL_PROFIT_INPUTS_INCOMPLETE',
          { missing_items: missing },
        );
      }

      const actualItems = reviewItems.filter((item) => item.subject_id && item.amount_rmb !== null);
      const revenue = addMoney(
        actualItems
          .filter((item) => item.subject_type === 'customer_receipt')
          .map((item) => item.amount_rmb!),
      );
      const cost = addMoney(
        actualItems
          .filter((item) => item.subject_type === 'purchase_cost')
          .map((item) => item.amount_rmb!),
      );
      const freight = addMoney(
        actualItems
          .filter(
            (item) =>
              item.subject_type === 'order_expense' &&
              item.source_snapshot.expense_type === 'freight',
          )
          .map((item) => item.amount_rmb!),
      );
      const otherExpense = addMoney(
        actualItems
          .filter(
            (item) =>
              item.subject_type === 'order_expense' &&
              item.source_snapshot.expense_type !== 'freight',
          )
          .map((item) => item.amount_rmb!),
      );
      const refund = '0.00';
      const gross = subtractMoney(revenue, cost);
      const net = subtractMoney(gross, freight, otherExpense, refund);

      const latestProfit = await client.query<ProfitRow>(
        `SELECT ${PROFIT_COLUMNS} FROM profit_snapshots
          WHERE sales_order_id = $1 ORDER BY version DESC LIMIT 1`,
        [order.id],
      );
      if (
        dto.status === 'final' &&
        latestProfit.rows[0]?.status === 'final' &&
        latestProfit.rows[0].input_fingerprint === facts.fingerprint &&
        latestProfit.rows[0].finance_review_id === review?.id
      ) {
        throw new FinanceConflictException(
          'The current finance inputs already have a final profit snapshot',
          'FINAL_PROFIT_ALREADY_EXISTS',
        );
      }
      const previous = latestProfit.rows[0] ?? null;
      const inputSnapshot = {
        formula_version: 'order_profit_rmb_v1',
        source_facts: facts.snapshot,
        finance_review: review
          ? { id: review.id, version: review.version, decision: review.decision }
          : null,
        review_items: reviewItems,
        after_sales_adjustments: [],
      };
      const inserted = await client.query<ProfitRow>(
        `INSERT INTO profit_snapshots
           (tenant_id, sales_order_id, version, status, supersedes_id, finance_review_id,
            formula_version, input_fingerprint, input_snapshot, missing_items,
            revenue_rmb, purchase_cost_rmb, freight_rmb, other_expense_rmb, refund_rmb,
            gross_profit_rmb, net_profit_rmb, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'order_profit_rmb_v1',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${PROFIT_COLUMNS}`,
        [
          actor.tenantId,
          order.id,
          (previous?.version ?? 0) + 1,
          dto.status,
          previous?.id ?? null,
          review?.id ?? null,
          facts.fingerprint,
          JSON.stringify(inputSnapshot),
          JSON.stringify(missing),
          revenue,
          cost,
          freight,
          otherExpense,
          refund,
          gross,
          net,
          actor.userId,
        ],
      );
      const snapshot = inserted.rows[0];
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: `profit_snapshot.${dto.status}`,
        resourceType: 'profit_snapshot',
        resourceId: snapshot.id,
        after: snapshot,
      });
      await this.recordEvent(
        client,
        actor,
        order.id,
        'profit_snapshot',
        snapshot.id,
        `profit_snapshot.${dto.status}`,
      );
      return snapshot;
    });
  }

  private async profitHistory(client: PoolClient, orderId: string) {
    return (
      await client.query<ProfitRow>(
        `SELECT ${PROFIT_COLUMNS} FROM profit_snapshots
          WHERE sales_order_id = $1 ORDER BY version DESC`,
        [orderId],
      )
    ).rows;
  }

  async getCommissionRules(actor: FinanceActor) {
    return withTenantContext(this.pool, this.context(actor), (client) => this.latestRules(client));
  }

  async replaceCommissionRules(actor: FinanceActor, dto: ReplaceCommissionRulesDto) {
    this.assertAllScope(actor);
    const roles = new Set(dto.rules.map((rule) => rule.role_type));
    if (roles.size !== 2 || !roles.has('sales') || !roles.has('procurement')) {
      throw new InvalidFinanceDataException(
        'Exactly one sales rule and one procurement rule are required',
        'COMMISSION_RULE_PAIR_REQUIRED',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      await client.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [actor.tenantId]);
      const inserted: RuleRow[] = [];
      for (const rule of dto.rules) {
        const previous = await client.query<RuleRow>(
          `SELECT ${RULE_COLUMNS} FROM commission_rule_versions_v2
            WHERE role_type = $1 ORDER BY version DESC LIMIT 1`,
          [rule.role_type],
        );
        const old = previous.rows[0] ?? null;
        const next = await client.query<RuleRow>(
          `INSERT INTO commission_rule_versions_v2
             (tenant_id, role_type, version, supersedes_id, basis_type, rate_bps, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING ${RULE_COLUMNS}`,
          [
            actor.tenantId,
            rule.role_type,
            (old?.version ?? 0) + 1,
            old?.id ?? null,
            rule.basis_type,
            rule.rate_bps,
            actor.userId,
          ],
        );
        inserted.push(next.rows[0]);
      }
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'commission_rules.revised',
        resourceType: 'commission_rule_version',
        after: inserted,
      });
      return inserted;
    });
  }

  private async latestRules(client: PoolClient): Promise<RuleRow[]> {
    return (
      await client.query<RuleRow>(
        `SELECT DISTINCT ON (role_type) ${RULE_COLUMNS}
           FROM commission_rule_versions_v2
          ORDER BY role_type, version DESC`,
      )
    ).rows;
  }

  private async currentFinalProfit(
    client: PoolClient,
    order: SalesOrderRow,
    facts?: SourceFacts,
  ): Promise<ProfitRow> {
    const currentFacts = facts ?? (await this.sourceFacts(client, order));
    const latestProfit = await client.query<ProfitRow>(
      `SELECT ${PROFIT_COLUMNS} FROM profit_snapshots
        WHERE sales_order_id = $1 ORDER BY version DESC LIMIT 1`,
      [order.id],
    );
    const profit = latestProfit.rows[0];
    if (!profit || profit.status !== 'final') {
      throw new FinanceConflictException(
        'Commission candidates require the current final profit snapshot',
        'FINAL_PROFIT_REQUIRED_FOR_COMMISSION',
      );
    }
    if (profit.input_fingerprint !== currentFacts.fingerprint) {
      throw new FinanceConflictException(
        'Finance inputs changed after the final profit snapshot',
        'FINAL_PROFIT_IS_STALE',
      );
    }

    const latestReview = await client.query<ReviewRow>(
      `SELECT ${REVIEW_COLUMNS} FROM finance_reviews
        WHERE sales_order_id = $1 ORDER BY version DESC LIMIT 1`,
      [order.id],
    );
    const review = latestReview.rows[0];
    if (
      !review ||
      review.decision !== 'verified' ||
      review.input_fingerprint !== currentFacts.fingerprint ||
      profit.finance_review_id !== review.id
    ) {
      throw new FinanceConflictException(
        'A current verified finance review is required for commission',
        'CURRENT_FINANCE_VERIFICATION_REQUIRED',
      );
    }
    return profit;
  }

  async calculateCandidate(
    actor: FinanceActor,
    orderId: string,
    dto: CalculateCommissionCandidateDto,
  ) {
    this.assertAllScope(actor);
    const allocationRoles = new Set(dto.allocations.map((allocation) => allocation.role_type));
    if (
      allocationRoles.size !== 2 ||
      !allocationRoles.has('sales') ||
      !allocationRoles.has('procurement')
    ) {
      throw new InvalidFinanceDataException(
        'Exactly one sales allocation and one procurement allocation are required',
        'COMMISSION_ALLOCATION_PAIR_REQUIRED',
      );
    }
    for (const allocation of dto.allocations) {
      const users = new Set(allocation.participants.map((participant) => participant.user_id));
      const totalShare = allocation.participants.reduce(
        (total, participant) => total + participant.share_bps,
        0,
      );
      if (users.size !== allocation.participants.length || totalShare !== 10000) {
        throw new InvalidFinanceDataException(
          `${allocation.role_type} participants must be unique and total exactly 10000 bps`,
          'INVALID_COMMISSION_SHARES',
        );
      }
    }

    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.salesOrder(client, actor, orderId, true);
      const facts = await this.sourceFacts(client, order);
      const profit = await this.currentFinalProfit(client, order, facts);
      const previousRows = await client.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS}
           FROM commission_candidates_v2 candidate
           LEFT JOIN commission_candidate_locks_v2 lock ON lock.candidate_id = candidate.id
          WHERE candidate.sales_order_id = $1 ORDER BY candidate.version DESC LIMIT 1`,
        [order.id],
      );
      const previous = previousRows.rows[0] ?? null;
      if (previous && !previous.lock_id && previous.profit_snapshot_id === profit.id) {
        throw new FinanceConflictException(
          'Lock the current calculated candidate before creating a revision',
          'UNLOCKED_COMMISSION_CANDIDATE_EXISTS',
        );
      }
      if (previous && !dto.revision_reason?.trim()) {
        throw new InvalidFinanceDataException(
          'A revision reason is required after a candidate has been locked',
          'COMMISSION_REVISION_REASON_REQUIRED',
        );
      }
      if (!previous && dto.revision_reason?.trim()) {
        throw new InvalidFinanceDataException(
          'The first commission candidate is not a revision',
          'UNEXPECTED_COMMISSION_REVISION_REASON',
        );
      }
      const rules = await this.latestRules(client);
      if (rules.length !== 2) {
        throw new FinanceConflictException(
          'Both sales and procurement commission rules must be configured',
          'COMMISSION_RULES_INCOMPLETE',
        );
      }
      const allUserIds = [
        ...new Set(dto.allocations.flatMap((row) => row.participants.map((p) => p.user_id))),
      ];
      const users = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM users WHERE id = ANY($1) AND status = 'active' AND deleted_at IS NULL`,
        [allUserIds],
      );
      if (users.rows.length !== allUserIds.length) {
        throw new InvalidFinanceDataException(
          'Every commission participant must be an active tenant user',
          'COMMISSION_PARTICIPANT_NOT_FOUND',
        );
      }
      const ruleByRole = new Map(rules.map((rule) => [rule.role_type, rule]));
      const basisValue = (basis: RuleRow['basis_type']): string => {
        if (basis === 'sales_revenue') return profit.revenue_rmb;
        if (basis === 'gross_profit') return profit.gross_profit_rmb;
        return profit.net_profit_rmb;
      };
      const lineInputs = dto.allocations.flatMap((allocation) => {
        const rule = ruleByRole.get(allocation.role_type)!;
        const rawBasis = basisValue(rule.basis_type);
        const eligibleBasis = nonNegativeMoney(rawBasis);
        return allocation.participants.map((participant) => {
          const allocatedBasis = multiplyMoneyByBps(eligibleBasis, participant.share_bps);
          return {
            role_type: allocation.role_type,
            user_id: participant.user_id,
            rule,
            raw_basis_rmb: rawBasis,
            eligible_basis_rmb: eligibleBasis,
            share_bps: participant.share_bps,
            allocated_basis_rmb: allocatedBasis,
            commission_amount_rmb: multiplyMoneyByBps(allocatedBasis, rule.rate_bps),
          };
        });
      });
      const total = addMoney(lineInputs.map((line) => line.commission_amount_rmb));
      const calculationSnapshot = {
        formula_version: 'commission_candidate_rmb_v1',
        profit_snapshot: {
          id: profit.id,
          version: profit.version,
          formula_version: profit.formula_version,
          revenue_rmb: profit.revenue_rmb,
          gross_profit_rmb: profit.gross_profit_rmb,
          net_profit_rmb: profit.net_profit_rmb,
        },
        rules,
        allocations: dto.allocations,
        rounding: 'integer_cents_half_up_per_participant',
      };
      const inserted = await client.query<CandidateRow>(
        `INSERT INTO commission_candidates_v2
           (tenant_id, sales_order_id, profit_snapshot_id, version, supersedes_id,
            formula_version, calculation_snapshot, total_commission_rmb,
            revision_reason, created_by)
         VALUES ($1,$2,$3,$4,$5,'commission_candidate_rmb_v1',$6,$7,$8,$9)
         RETURNING id, sales_order_id, profit_snapshot_id, version, supersedes_id,
           formula_version, calculation_snapshot,
           total_commission_rmb::text AS total_commission_rmb,
           revision_reason, created_by, created_at,
           NULL::uuid AS lock_id, NULL::uuid AS locked_by,
           NULL::timestamptz AS locked_at, NULL::text AS lock_comment`,
        [
          actor.tenantId,
          order.id,
          profit.id,
          (previous?.version ?? 0) + 1,
          previous?.id ?? null,
          JSON.stringify(calculationSnapshot),
          total,
          dto.revision_reason?.trim() || null,
          actor.userId,
        ],
      );
      const candidate = inserted.rows[0];
      for (const line of lineInputs) {
        await client.query(
          `INSERT INTO commission_candidate_lines_v2
             (tenant_id, candidate_id, role_type, user_id, rule_version_id, basis_type,
              raw_basis_rmb, eligible_basis_rmb, share_bps, allocated_basis_rmb,
              rate_bps, commission_amount_rmb)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            actor.tenantId,
            candidate.id,
            line.role_type,
            line.user_id,
            line.rule.id,
            line.rule.basis_type,
            line.raw_basis_rmb,
            line.eligible_basis_rmb,
            line.share_bps,
            line.allocated_basis_rmb,
            line.rule.rate_bps,
            line.commission_amount_rmb,
          ],
        );
      }
      const response = await this.candidateResponse(client, candidate);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: previous ? 'commission_candidate.revised' : 'commission_candidate.calculated',
        resourceType: 'commission_candidate_v2',
        resourceId: candidate.id,
        after: response,
        reason: dto.revision_reason?.trim() || null,
      });
      await this.recordEvent(
        client,
        actor,
        order.id,
        'commission_candidate_v2',
        candidate.id,
        previous ? 'commission_candidate.revised' : 'commission_candidate.calculated',
      );
      return response;
    });
  }

  async lockCandidate(actor: FinanceActor, candidateId: string, dto: LockCommissionCandidateDto) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const target = await client.query<{ sales_order_id: string }>(
        `SELECT sales_order_id FROM commission_candidates_v2 WHERE id = $1`,
        [candidateId],
      );
      if (!target.rows[0]) throw new FinanceNotFoundException('Commission candidate not found');
      const order = await this.salesOrder(client, actor, target.rows[0].sales_order_id, true);
      const selected = await client.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS}
           FROM commission_candidates_v2 candidate
           LEFT JOIN commission_candidate_locks_v2 lock ON lock.candidate_id = candidate.id
          WHERE candidate.id = $1`,
        [candidateId],
      );
      const candidate = selected.rows[0];
      if (!candidate) throw new FinanceNotFoundException('Commission candidate not found');
      if (candidate.lock_id) {
        throw new FinanceConflictException(
          'Commission candidate is already locked',
          'COMMISSION_CANDIDATE_ALREADY_LOCKED',
        );
      }
      const latest = await client.query<{ id: string }>(
        `SELECT id FROM commission_candidates_v2
          WHERE sales_order_id = $1 ORDER BY version DESC LIMIT 1`,
        [candidate.sales_order_id],
      );
      if (latest.rows[0]?.id !== candidate.id) {
        throw new FinanceConflictException(
          'Only the latest commission candidate version can be locked',
          'COMMISSION_CANDIDATE_SUPERSEDED',
        );
      }
      const profit = await this.currentFinalProfit(client, order);
      if (candidate.profit_snapshot_id !== profit.id) {
        throw new FinanceConflictException(
          'Commission candidate is connected to an obsolete profit snapshot',
          'COMMISSION_CANDIDATE_STALE',
        );
      }
      await client.query(
        `INSERT INTO commission_candidate_locks_v2
           (tenant_id, candidate_id, locked_by, comment)
         VALUES ($1,$2,$3,$4)`,
        [actor.tenantId, candidate.id, actor.userId, dto.comment?.trim() || null],
      );
      await client.query(
        `UPDATE sales_orders SET status = 'settled', updated_at = now()
          WHERE id = $1 AND status = 'finance_review'`,
        [candidate.sales_order_id],
      );
      const response = await this.fetchCandidate(client, candidate.id);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'commission_candidate.locked',
        resourceType: 'commission_candidate_v2',
        resourceId: candidate.id,
        after: response,
        reason: dto.comment?.trim() || null,
      });
      await this.recordEvent(
        client,
        actor,
        candidate.sales_order_id,
        'commission_candidate_v2',
        candidate.id,
        'commission_candidate.locked',
      );
      return response;
    });
  }

  private async candidateHistory(client: PoolClient, orderId: string) {
    const rows = await client.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM commission_candidates_v2 candidate
         LEFT JOIN commission_candidate_locks_v2 lock ON lock.candidate_id = candidate.id
        WHERE candidate.sales_order_id = $1 ORDER BY candidate.version DESC`,
      [orderId],
    );
    return Promise.all(rows.rows.map((row) => this.candidateResponse(client, row)));
  }

  private async fetchCandidate(client: PoolClient, id: string) {
    const row = await client.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS}
         FROM commission_candidates_v2 candidate
         LEFT JOIN commission_candidate_locks_v2 lock ON lock.candidate_id = candidate.id
        WHERE candidate.id = $1`,
      [id],
    );
    if (!row.rows[0]) throw new FinanceNotFoundException('Commission candidate not found');
    return this.candidateResponse(client, row.rows[0]);
  }

  private async candidateResponse(client: PoolClient, row: CandidateRow) {
    const lines = await client.query<CandidateLineRow>(
      `SELECT line.id, line.role_type, line.user_id, users.name AS user_name,
              line.rule_version_id, line.basis_type,
              line.raw_basis_rmb::text AS raw_basis_rmb,
              line.eligible_basis_rmb::text AS eligible_basis_rmb,
              line.share_bps, line.allocated_basis_rmb::text AS allocated_basis_rmb,
              line.rate_bps, line.commission_amount_rmb::text AS commission_amount_rmb
         FROM commission_candidate_lines_v2 line
         JOIN users ON users.id = line.user_id
        WHERE line.candidate_id = $1 ORDER BY line.role_type, users.name, line.id`,
      [row.id],
    );
    return {
      ...row,
      status: row.lock_id ? 'locked' : 'calculated',
      lock: row.lock_id
        ? {
            id: row.lock_id,
            locked_by: row.locked_by,
            locked_at: row.locked_at,
            comment: row.lock_comment,
          }
        : null,
      lines: lines.rows,
    };
  }

  private async recordEvent(
    client: PoolClient,
    actor: FinanceActor,
    orderId: string,
    credentialType: string,
    credentialId: string,
    eventType: string,
  ): Promise<void> {
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType: 'sales_order',
      chainId: orderId,
      credentialType,
      credentialId,
      eventType,
      actorType: 'tenant_user',
      actorId: actor.userId,
      visibilityPermission: 'finance_reviews:view',
    });
  }
}
