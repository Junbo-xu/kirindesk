import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { CreatePayoutDto, ListPayoutsQuery, PayBatchDto, VoidPayoutDto } from './dto/payout.dto';
import { RequestActor } from './commission.service';

// Row shapes -----------------------------------------------------------------

interface PayoutRow {
  id: string;
  settlement_id: string;
  status: string;
  total_payout_base: string;
  currency: string;
  payout_date: string | null;
  external_ref: string | null;
  note: string | null;
  created_at: string;
  paid_at: string | null;
  voided_at: string | null;
}

interface PayoutLineRow {
  id: string;
  salesperson_user_id: string;
  salesperson_name: string | null;
  settlement_line_id: string;
  amount_base: string;
  status: string;
  paid_at: string | null;
}

// Response shapes ------------------------------------------------------------

export interface PayoutSummary {
  id: string;
  settlementId: string;
  status: string;
  totalPayoutBase: string;
  currency: string;
  payoutDate: string | null;
  externalRef: string | null;
  createdAt: string;
}

export interface PayoutLine {
  id: string;
  salespersonUserId: string;
  salespersonName: string | null;
  settlementLineId: string;
  amountBase: string;
  status: string;
  paidAt: string | null;
}

export interface PayoutDetail extends PayoutSummary {
  note: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  lines: PayoutLine[];
}

export interface CreatePayoutResult {
  payout: PayoutDetail;
  // false when an existing live payout was returned idempotently — the
  // controller maps this to HTTP 200 instead of 201 (plan §5.1).
  created: boolean;
}

@Injectable()
export class CommissionPayoutService {
  private readonly logger = new Logger(CommissionPayoutService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  // ---- Create (copy from a locked settlement; idempotent; only-locked) -------

  async create(actor: RequestActor, dto: CreatePayoutDto): Promise<CreatePayoutResult> {
    const { payoutId, created } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        // Lock the settlement row so concurrent creates serialise (§3 D5/D6).
        // 404 if the settlement isn't in the caller's tenant (RLS) or absent.
        const settlement = await client.query<{
          id: string;
          status: string;
          total_commission_base: string;
        }>(
          `SELECT id, status, total_commission_base::text AS total_commission_base
             FROM commission_settlements WHERE id = $1 FOR UPDATE`,
          [dto.settlementId],
        );
        if (settlement.rows.length === 0) throw new NotFoundException('Settlement not found');

        // Only the *current locked* row is payable: locked AND not superseded
        // (§3 D1), mirroring the read path in CommissionService.
        const superseded = await client.query<{ id: string }>(
          `SELECT id FROM commission_settlements WHERE supersedes = $1 LIMIT 1`,
          [dto.settlementId],
        );
        const payable = settlement.rows[0].status === 'locked' && superseded.rows.length === 0;

        // Idempotent return: if a live (non-void) payout already exists, return
        // it rather than creating a second. Checked under the settlement lock so
        // a retried create is safe; the partial unique index is the backstop.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM commission_payouts
            WHERE settlement_id = $1 AND status <> 'void' LIMIT 1`,
          [dto.settlementId],
        );
        if (existing.rows.length > 0) {
          return { payoutId: existing.rows[0].id, created: false };
        }

        // No live payout — now the settlement must be payable to create one.
        if (!payable) throw new ConflictException('Settlement is not currently locked');

        const currency = await this.getBaseCurrency(client);
        const total = settlement.rows[0].total_commission_base;

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO commission_payouts
             (tenant_id, settlement_id, status, total_payout_base, currency, note, created_by)
           VALUES ($1, $2, 'open', $3, $4, $5, $6)
           RETURNING id`,
          [actor.tenantId, dto.settlementId, total, currency, dto.note ?? null, actor.userId],
        );
        const id = inserted.rows[0].id;

        // One payout line per settlement line, amount COPIED from the locked
        // settlement line's commission_base (§3 D1). Amounts are frozen by the
        // DB trigger thereafter (§3 D7).
        await client.query(
          `INSERT INTO commission_payout_lines
             (tenant_id, payout_id, settlement_line_id, salesperson_user_id, amount_base, status)
           SELECT $1, $2, l.id, l.salesperson_user_id, l.commission_base, 'pending'
             FROM commission_settlement_lines l
            WHERE l.settlement_id = $3`,
          [actor.tenantId, id, dto.settlementId],
        );
        return { payoutId: id, created: true };
      },
    );

    if (created) {
      const detail = await this.getDetailUnscoped(actor, payoutId);
      await this.safeAudit({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: 'commission.payout.created',
        resourceId: payoutId,
        after: {
          settlementId: detail.settlementId,
          totalPayoutBase: detail.totalPayoutBase,
          currency: detail.currency,
          lineCount: detail.lines.length,
        },
      });
    }
    return { payout: await this.getDetail(actor, payoutId), created };
  }

  // ---- Reads (dataScope-aware) ----------------------------------------------

  async list(actor: RequestActor, query: ListPayoutsQuery): Promise<PayoutSummary[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [];
        const where: string[] = [];
        if (query.settlementId) {
          params.push(query.settlementId);
          where.push(`p.settlement_id = $${params.length}`);
        }
        if (query.status) {
          params.push(query.status);
          where.push(`p.status = $${params.length}`);
        }
        // Narrow scope: only batches that contain a line for the caller (§5.2).
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          where.push(
            `EXISTS (SELECT 1 FROM commission_payout_lines l
                      WHERE l.payout_id = p.id AND l.salesperson_user_id = $${params.length})`,
          );
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const { rows } = await client.query<PayoutRow>(
          `SELECT p.id, p.settlement_id, p.status,
                  p.total_payout_base::text AS total_payout_base, p.currency,
                  p.payout_date::text AS payout_date, p.external_ref,
                  p.created_at::text AS created_at
             FROM commission_payouts p
             ${whereSql}
            ORDER BY p.created_at DESC`,
          params,
        );
        return rows.map((r) => this.toSummary(r));
      },
    );
  }

  async getDetail(actor: RequestActor, id: string): Promise<PayoutDetail> {
    return this.loadDetail(actor, id, this.restrictsToOwner(actor.dataScope));
  }

  // Unscoped detail for audit snapshots (never returned to a scoped caller).
  private async getDetailUnscoped(actor: RequestActor, id: string): Promise<PayoutDetail> {
    return this.loadDetail(actor, id, false);
  }

  private async loadDetail(
    actor: RequestActor,
    id: string,
    scopeToOwner: boolean,
  ): Promise<PayoutDetail> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<PayoutRow>(
          `SELECT p.id, p.settlement_id, p.status,
                  p.total_payout_base::text AS total_payout_base, p.currency,
                  p.payout_date::text AS payout_date, p.external_ref, p.note,
                  p.created_at::text AS created_at,
                  p.paid_at::text AS paid_at, p.voided_at::text AS voided_at
             FROM commission_payouts p WHERE p.id = $1`,
          [id],
        );
        if (rows.length === 0) throw new NotFoundException('Payout not found');

        const lineParams: unknown[] = [id];
        let lineScope = '';
        if (scopeToOwner) {
          lineParams.push(actor.userId);
          lineScope = ` AND l.salesperson_user_id = $${lineParams.length}`;
        }
        const { rows: lineRows } = await client.query<PayoutLineRow>(
          `SELECT l.id, l.salesperson_user_id, u.name AS salesperson_name,
                  l.settlement_line_id, l.amount_base::text AS amount_base, l.status,
                  l.paid_at::text AS paid_at
             FROM commission_payout_lines l
             LEFT JOIN users u ON u.id = l.salesperson_user_id
            WHERE l.payout_id = $1${lineScope}
            ORDER BY u.name NULLS LAST, l.salesperson_user_id`,
          lineParams,
        );
        // A scoped caller with no line in the batch cannot see it (§5.3).
        if (scopeToOwner && lineRows.length === 0) throw new NotFoundException('Payout not found');

        return this.toDetail(rows[0], lineRows);
      },
    );
  }

  // ---- Writes (privileged; row-locked status machine) ------------------------

  // Lock the batch row FOR UPDATE so concurrent transitions serialise (§3 D6).
  private async lockPayoutOrThrow(client: PoolClient, id: string): Promise<PayoutRow> {
    const { rows } = await client.query<PayoutRow>(
      `SELECT id, settlement_id, status, total_payout_base::text AS total_payout_base,
              currency, payout_date::text AS payout_date, external_ref, note,
              created_at::text AS created_at, paid_at::text AS paid_at,
              voided_at::text AS voided_at
         FROM commission_payouts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException('Payout not found');
    return rows[0];
  }

  async payLine(actor: RequestActor, id: string, lineId: string): Promise<PayoutDetail> {
    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const batch = await this.lockPayoutOrThrow(client, id);
        if (batch.status !== 'open') {
          throw new ConflictException('Payout is not open');
        }
        const line = await client.query<{ status: string; amount_base: string }>(
          `SELECT status, amount_base::text AS amount_base
             FROM commission_payout_lines WHERE id = $1 AND payout_id = $2`,
          [lineId, id],
        );
        if (line.rows.length === 0) throw new NotFoundException('Payout line not found');
        if (line.rows[0].status !== 'pending') {
          throw new ConflictException('Payout line is not pending');
        }
        await client.query(
          `UPDATE commission_payout_lines SET status = 'paid', paid_at = now()
            WHERE id = $1`,
          [lineId],
        );
        await this.safeAudit({
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'commission.payout.line_paid',
          resourceId: id,
          before: { lineId, status: 'pending' },
          after: { lineId, status: 'paid', amountBase: line.rows[0].amount_base },
        });
      },
    );
    return this.getDetailUnscoped(actor, id);
  }

  async payBatch(actor: RequestActor, id: string, dto: PayBatchDto): Promise<PayoutDetail> {
    const payoutDate = dto.payoutDate.slice(0, 10);
    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const batch = await this.lockPayoutOrThrow(client, id);
        if (batch.status !== 'open') {
          throw new ConflictException('Payout is not open');
        }
        // Close the batch and sweep any still-pending lines to paid (§5.5).
        await client.query(
          `UPDATE commission_payouts
              SET status = 'paid', payout_date = $2::date, external_ref = $3,
                  note = COALESCE($4, note), paid_by = $5, paid_at = now()
            WHERE id = $1`,
          [id, payoutDate, dto.externalRef ?? null, dto.note ?? null, actor.userId],
        );
        await client.query(
          `UPDATE commission_payout_lines SET status = 'paid', paid_at = now()
            WHERE payout_id = $1 AND status = 'pending'`,
          [id],
        );
        await this.safeAudit({
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'commission.payout.paid',
          resourceId: id,
          before: { status: 'open' },
          after: { status: 'paid', payoutDate, externalRef: dto.externalRef ?? null },
        });
      },
    );
    return this.getDetailUnscoped(actor, id);
  }

  async void(actor: RequestActor, id: string, dto: VoidPayoutDto): Promise<PayoutDetail> {
    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const batch = await this.lockPayoutOrThrow(client, id);
        // Voidable from open OR paid (a mis-entered paid run can be reversed,
        // §3 D4); voiding an already-void batch is a conflict.
        if (batch.status === 'void') {
          throw new ConflictException('Payout is already void');
        }
        await client.query(
          `UPDATE commission_payouts
              SET status = 'void', voided_by = $2, voided_at = now(), void_reason = $3
            WHERE id = $1`,
          [id, actor.userId, dto.reason],
        );
        await client.query(
          `UPDATE commission_payout_lines SET status = 'void' WHERE payout_id = $1`,
          [id],
        );
        await this.safeAudit({
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: 'commission.payout.voided',
          resourceId: id,
          before: { status: batch.status },
          after: { status: 'void' },
          reason: dto.reason,
        });
      },
    );
    return this.getDetailUnscoped(actor, id);
  }

  // ---- Helpers ---------------------------------------------------------------

  private async getBaseCurrency(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ base_currency: string | null }>(
      `SELECT value_json #>> '{}' AS base_currency
         FROM tenant_settings WHERE key = 'base_currency' LIMIT 1`,
    );
    return rows[0]?.base_currency ?? 'RMB';
  }

  private toSummary(r: PayoutRow): PayoutSummary {
    return {
      id: r.id,
      settlementId: r.settlement_id,
      status: r.status,
      totalPayoutBase: r.total_payout_base,
      currency: r.currency,
      payoutDate: r.payout_date,
      externalRef: r.external_ref,
      createdAt: r.created_at,
    };
  }

  private toDetail(r: PayoutRow, lines: PayoutLineRow[]): PayoutDetail {
    return {
      ...this.toSummary(r),
      note: r.note,
      paidAt: r.paid_at,
      voidedAt: r.voided_at,
      lines: lines.map((l) => ({
        id: l.id,
        salespersonUserId: l.salesperson_user_id,
        salespersonName: l.salesperson_name,
        settlementLineId: l.settlement_line_id,
        amountBase: l.amount_base,
        status: l.status,
        paidAt: l.paid_at,
      })),
    };
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
        resourceType: 'commission_payout',
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
