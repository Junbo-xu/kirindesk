import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { PAYMENT_PROVIDER, PaymentProvider } from './payment-provider.interface';
import { centsToDecimal, decimalToCents } from './payment-money';

// Default plan when a tenant has no plan_id (legacy/standard), mirroring
// SubscriptionService / QuotaService.
const STANDARD_PLAN_ID = 'b0000000-0000-0000-0000-000000000002';

export type BillingPeriod = 'monthly' | 'yearly';

// The caller identity threaded through tenant-side billing operations. dataScope
// is carried for parity with other modules; billing rows bind no resource owner,
// so reads are effectively tenant-wide (RLS still isolates by tenant).
export interface BillingActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface InvoiceRow {
  id: string;
  plan_id: string;
  billing_period: string;
  amount_cents: string;
  currency: string;
  status: string;
  issued_at: string;
  due_at: string | null;
  paid_at: string | null;
  void_reason: string | null;
}

export interface InvoiceSummary {
  id: string;
  planId: string;
  billingPeriod: string;
  amount: string; // numeric(…,2) decimal string, derived from amount_cents
  amountCents: string;
  currency: string;
  status: string;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  voidReason: string | null;
}

function toInvoiceSummary(r: InvoiceRow): InvoiceSummary {
  return {
    id: r.id,
    planId: r.plan_id,
    billingPeriod: r.billing_period,
    amount: centsToDecimal(BigInt(r.amount_cents)),
    amountCents: r.amount_cents,
    currency: r.currency,
    status: r.status,
    issuedAt: r.issued_at,
    dueAt: r.due_at,
    paidAt: r.paid_at,
    voidReason: r.void_reason,
  };
}

const INVOICE_COLS = `id, plan_id, billing_period, amount_cents::text AS amount_cents,
  currency, status, issued_at, due_at, paid_at, void_reason`;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
  ) {}

  // ---- Issue (platform-side, idempotent per open period) ---------------------

  // Issues an invoice for the tenant's current plan at the given period price.
  // Amount + currency are derived server-side from the plan; never client-set.
  // Idempotent: if a pending invoice for the same (plan, period) already exists,
  // it is returned rather than creating a duplicate (no double-billing).
  // Runs under the TENANT's context (RLS) with actorType=platform_admin so the
  // audit lands in the tenant's own chain.
  async issueForTenant(
    adminId: string,
    tenantId: string,
    period: BillingPeriod,
  ): Promise<{ invoice: InvoiceSummary; created: boolean }> {
    const { invoiceId, created } = await withTenantContext(
      this.pool,
      { tenantId, userId: adminId, actorType: 'platform_admin' },
      async (client) => {
        const planRes = await client.query<{
          plan_id: string;
          price_monthly: string;
          price_yearly: string;
          currency: string;
        }>(
          `SELECT p.id AS plan_id,
                  p.price_monthly::text AS price_monthly,
                  p.price_yearly::text  AS price_yearly,
                  p.currency
             FROM tenants t
             JOIN plans p ON p.id = COALESCE(t.plan_id, $2)
            WHERE t.id = $1`,
          [tenantId, STANDARD_PLAN_ID],
        );
        if (planRes.rows.length === 0) throw new NotFoundException('Tenant not found');
        const plan = planRes.rows[0];
        const priceDecimal = period === 'yearly' ? plan.price_yearly : plan.price_monthly;
        const amountCents = decimalToCents(priceDecimal);

        // Idempotent: reuse an existing pending invoice for the same plan+period.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM billing_invoices
            WHERE plan_id = $1 AND billing_period = $2 AND status = 'pending'
            ORDER BY issued_at DESC LIMIT 1`,
          [plan.plan_id, period],
        );
        if (existing.rows.length > 0) {
          return { invoiceId: existing.rows[0].id, created: false };
        }

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO billing_invoices
             (tenant_id, plan_id, billing_period, amount_cents, currency, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           RETURNING id`,
          [tenantId, plan.plan_id, period, amountCents.toString(), plan.currency],
        );
        return { invoiceId: inserted.rows[0].id, created: true };
      },
    );

    const invoice = await this.getByIdAsPlatform(adminId, tenantId, invoiceId);
    if (created) {
      await this.safeAudit({
        tenantId,
        actorId: adminId,
        actorType: 'platform_admin',
        action: 'billing.invoice_issued',
        resourceId: invoiceId,
        metadata: {
          planId: invoice.planId,
          billingPeriod: invoice.billingPeriod,
          amount: invoice.amount,
          currency: invoice.currency,
        },
      });
    }
    return { invoice, created };
  }

  // ---- Tenant-side reads -----------------------------------------------------

  async list(
    actor: BillingActor,
    opts: { status?: string; page?: number; pageSize?: number },
  ): Promise<{ data: InvoiceSummary[]; page: number; pageSize: number; total: number }> {
    const page = opts.page && opts.page > 0 ? opts.page : 1;
    const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 100) : 20;
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const where: string[] = [];
        const params: unknown[] = [];
        if (opts.status) {
          params.push(opts.status);
          where.push(`status = $${params.length}`);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const countRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM billing_invoices ${whereSql}`,
          params,
        );
        const total = parseInt(countRes.rows[0].count, 10);
        params.push(pageSize, (page - 1) * pageSize);
        const rows = await client.query<InvoiceRow>(
          `SELECT ${INVOICE_COLS} FROM billing_invoices ${whereSql}
            ORDER BY issued_at DESC, id DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return { data: rows.rows.map(toInvoiceSummary), page, pageSize, total };
      },
    );
  }

  async getOne(actor: BillingActor, id: string): Promise<InvoiceSummary> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const res = await client.query<InvoiceRow>(
          `SELECT ${INVOICE_COLS} FROM billing_invoices WHERE id = $1`,
          [id],
        );
        if (res.rows.length === 0) throw new NotFoundException('Invoice not found');
        return toInvoiceSummary(res.rows[0]);
      },
    );
  }

  // ---- Pay (tenant-side; provider charge; immutable payment row) -------------

  // Pays a pending invoice. Under a row lock: validates state (409 if not
  // pending), calls the provider, then — on success — writes an immutable
  // payment row and flips the invoice to paid in the same transaction; the
  // partial unique index is the DB backstop against a double succeeded payment.
  // On provider failure: a `failed` payment row is committed for the audit trail
  // and the invoice is LEFT pending (unpolluted); a 502 is thrown to the caller.
  async pay(actor: BillingActor, id: string): Promise<InvoiceSummary> {
    const outcome = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client): Promise<PayOutcome> => {
        const locked = await client.query<{
          id: string;
          status: string;
          amount_cents: string;
          currency: string;
        }>(
          `SELECT id, status, amount_cents::text AS amount_cents, currency
             FROM billing_invoices WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (locked.rows.length === 0) throw new NotFoundException('Invoice not found');
        const inv = locked.rows[0];
        if (inv.status !== 'pending') {
          throw new ConflictException(`Invoice is ${inv.status}, not payable`);
        }

        const amountCents = BigInt(inv.amount_cents);
        try {
          const result = await this.payment.charge({
            tenantId: actor.tenantId,
            invoiceId: id,
            amountCents,
            currency: inv.currency,
          });
          await client.query(
            `INSERT INTO billing_payments
               (tenant_id, invoice_id, provider, provider_ref, amount_cents, currency, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'succeeded')`,
            [
              actor.tenantId,
              id,
              this.payment.name,
              result.providerRef,
              inv.amount_cents,
              inv.currency,
            ],
          );
          await client.query(
            `UPDATE billing_invoices
                SET status = 'paid', paid_at = now(), updated_at = now()
              WHERE id = $1`,
            [id],
          );
          return { kind: 'succeeded', providerRef: result.providerRef };
        } catch (err) {
          // Record the failed attempt for the audit trail, but DO NOT touch the
          // invoice — it stays pending so it remains payable on retry. The
          // failed-payment INSERT is committed by this same withTenantContext tx.
          await client.query(
            `INSERT INTO billing_payments
               (tenant_id, invoice_id, provider, provider_ref, amount_cents, currency, status)
             VALUES ($1, $2, $3, NULL, $4, $5, 'failed')`,
            [actor.tenantId, id, this.payment.name, inv.amount_cents, inv.currency],
          );
          return { kind: 'failed', error: String(err) };
        }
      },
    );

    if (outcome.kind === 'failed') {
      await this.safeAudit({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        actorType: 'tenant_user',
        action: 'billing.payment_failed',
        resourceId: id,
        metadata: { provider: this.payment.name, error: outcome.error },
      });
      throw new HttpException('Payment failed at provider', HttpStatus.BAD_GATEWAY);
    }

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      actorType: 'tenant_user',
      action: 'billing.invoice_paid',
      resourceId: id,
      metadata: { provider: this.payment.name, providerRef: outcome.providerRef },
    });
    return this.getOne(actor, id);
  }

  // ---- internals -------------------------------------------------------------

  // Reads an invoice back under the tenant context as a platform admin (used by
  // issueForTenant to build the response/audit payload after commit).
  private getByIdAsPlatform(
    adminId: string,
    tenantId: string,
    id: string,
  ): Promise<InvoiceSummary> {
    return withTenantContext(
      this.pool,
      { tenantId, userId: adminId, actorType: 'platform_admin' },
      async (client) => {
        const res = await client.query<InvoiceRow>(
          `SELECT ${INVOICE_COLS} FROM billing_invoices WHERE id = $1`,
          [id],
        );
        if (res.rows.length === 0) throw new NotFoundException('Invoice not found');
        return toInvoiceSummary(res.rows[0]);
      },
    );
  }

  private async safeAudit(params: {
    tenantId: string;
    actorId: string;
    actorType: 'tenant_user' | 'platform_admin';
    action: string;
    resourceId: string;
    metadata: unknown;
  }): Promise<void> {
    try {
      await this.auditService.log({
        tenantId: params.tenantId,
        actorType: params.actorType,
        actorId: params.actorId,
        action: params.action,
        resourceType: 'billing_invoice',
        resourceId: params.resourceId,
        metadata: params.metadata,
      });
    } catch (e) {
      this.logger.warn(`Audit failed for ${params.action} (${params.resourceId}): ${String(e)}`);
    }
  }
}

type PayOutcome = { kind: 'succeeded'; providerRef: string } | { kind: 'failed'; error: string };
