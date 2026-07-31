import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import {
  AiRateLimitException,
  AiResponseParseException,
  AiTimeoutException,
} from '../ai/ai.errors';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ManualQuoteTaskDto } from './dto/manual-quote-task.dto';
import {
  InquiryNotFoundException,
  InquiryStateConflictException,
  InvalidInquiryDataException,
  QuoteTaskNotFoundException,
  SanitizedOutputInvalidException,
} from './inquiries.errors';
import {
  InquiryItemRow,
  InquiryResponse,
  InquiryRow,
  QuoteTaskResponse,
  QuoteTaskRow,
  toInquiryResponse,
  toQuoteTaskResponse,
} from './inquiries.response';
import {
  buildSanitizationPrompt,
  parseSanitizedQuoteTask,
  validateSanitizedQuoteTask,
} from './quote-task-sanitizer';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface SanitizationSource {
  taskId: string;
  attempt: number;
  customerCode: string;
  customerCountry: string;
  customerMessage: string;
  items: InquiryItemRow[];
}

const SANITIZATION_LEASE_MINUTES = 2;

const INQUIRY_COLUMNS = `id, tenant_id, owner_user_id, customer_id, customer_code, customer_country,
  customer_message, source_version, status, submitted_at, created_at, updated_at`;

const ITEM_COLUMNS = `id, inquiry_id, line_no, description, specifications,
  quantity::text AS quantity, unit, target_price_usd::text AS target_price_usd, created_at`;

const TASK_COLUMNS = `qt.id, qt.inquiry_id, i.customer_country,
  qt.sanitization_status, qt.sanitized_summary, qt.sanitized_payload,
  qt.provider_name, qt.provider_invocation_id, qt.last_error_code,
  qt.attempt_count, qt.corrected_at, qt.last_attempted_at,
  qt.completed_at, qt.created_at, qt.updated_at`;

function isZeroDecimal(value: string): boolean {
  return /^0+(?:\.0+)?$/.test(value);
}

@Injectable()
export class InquiriesService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly ai: AiService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private async items(client: PoolClient, inquiryId: string): Promise<InquiryItemRow[]> {
    const result = await client.query<InquiryItemRow>(
      `SELECT ${ITEM_COLUMNS}
         FROM inquiry_items
        WHERE inquiry_id = $1
        ORDER BY line_no ASC`,
      [inquiryId],
    );
    return result.rows;
  }

  private async inquiry(
    client: PoolClient,
    actor: RequestActor,
    inquiryId: string,
    lock = false,
  ): Promise<InquiryRow> {
    const params: unknown[] = [inquiryId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id = $${params.length}`;
    }
    const result = await client.query<InquiryRow>(
      `SELECT ${INQUIRY_COLUMNS}
         FROM inquiries
        WHERE id = $1${scope}${lock ? ' FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) throw new InquiryNotFoundException();
    return result.rows[0];
  }

  async create(actor: RequestActor, dto: CreateInquiryDto): Promise<InquiryResponse> {
    const customerCode = dto.customer_code.trim();
    const customerCountry = dto.customer_country.trim();
    const customerMessage = dto.customer_message.trim();
    if (
      !customerCode ||
      !customerCountry ||
      !customerMessage ||
      dto.items.some(
        (item) => isZeroDecimal(item.quantity) || !item.description.trim() || !item.unit.trim(),
      )
    ) {
      throw new InvalidInquiryDataException('Inquiry item quantity must be greater than zero');
    }

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const created = await client.query<InquiryRow>(
          `INSERT INTO inquiries
             (tenant_id, owner_user_id, customer_code, customer_country, customer_message)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${INQUIRY_COLUMNS}`,
          [actor.tenantId, actor.userId, customerCode, customerCountry, customerMessage],
        );
        const row = created.rows[0];
        for (const [index, item] of dto.items.entries()) {
          await client.query(
            `INSERT INTO inquiry_items
               (tenant_id, inquiry_id, line_no, description, specifications,
                quantity, unit, target_price_usd)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              actor.tenantId,
              row.id,
              index + 1,
              item.description.trim(),
              item.specifications?.trim() || null,
              item.quantity,
              item.unit.trim(),
              item.target_price_usd ?? null,
            ],
          );
        }
        const inquiryItems = await this.items(client, row.id);
        const response = toInquiryResponse(row, inquiryItems);
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'inquiry.created',
          resourceType: 'inquiry',
          resourceId: row.id,
          after: response,
        });
        return response;
      },
    );
  }

  async list(actor: RequestActor): Promise<InquiryResponse[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = `WHERE owner_user_id = $${params.length}`;
        }
        const result = await client.query<InquiryRow>(
          `SELECT ${INQUIRY_COLUMNS}
             FROM inquiries ${scope}
            ORDER BY created_at DESC, id DESC`,
          params,
        );
        return Promise.all(
          result.rows.map(async (row) => toInquiryResponse(row, await this.items(client, row.id))),
        );
      },
    );
  }

  async getOne(actor: RequestActor, inquiryId: string): Promise<InquiryResponse> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.inquiry(client, actor, inquiryId);
        return toInquiryResponse(row, await this.items(client, row.id));
      },
    );
  }

  async submit(
    actor: RequestActor,
    inquiryId: string,
  ): Promise<{ inquiry: InquiryResponse; quote_task: QuoteTaskResponse }> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const before = await this.inquiry(client, actor, inquiryId, true);
        if (before.status !== 'draft') {
          throw new InquiryStateConflictException('Only a draft inquiry can be submitted');
        }
        const updated = await client.query<InquiryRow>(
          `UPDATE inquiries
              SET status = 'submitted', submitted_at = now(), updated_at = now()
            WHERE id = $1
          RETURNING ${INQUIRY_COLUMNS}`,
          [inquiryId],
        );
        await client.query(
          `INSERT INTO quote_tasks (tenant_id, inquiry_id)
           VALUES ($1, $2)`,
          [actor.tenantId, inquiryId],
        );
        const inquiryItems = await this.items(client, inquiryId);
        const response = toInquiryResponse(updated.rows[0], inquiryItems);
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'inquiry.submitted',
          resourceType: 'inquiry',
          resourceId: inquiryId,
          before: { status: before.status },
          after: { status: updated.rows[0].status, submitted_at: updated.rows[0].submitted_at },
        });
        const task = await this.taskByInquiry(client, inquiryId);
        return { inquiry: response, quote_task: toQuoteTaskResponse(task) };
      },
    );
  }

  private async taskByInquiry(client: PoolClient, inquiryId: string): Promise<QuoteTaskRow> {
    const result = await client.query<QuoteTaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM quote_tasks qt
         JOIN inquiries i ON i.id = qt.inquiry_id AND i.tenant_id = qt.tenant_id
        WHERE qt.inquiry_id = $1`,
      [inquiryId],
    );
    if (result.rows.length === 0) throw new QuoteTaskNotFoundException();
    return result.rows[0];
  }

  private async taskById(client: PoolClient, taskId: string): Promise<QuoteTaskRow> {
    const result = await client.query<QuoteTaskRow>(
      `SELECT ${TASK_COLUMNS}
         FROM quote_tasks qt
         JOIN inquiries i ON i.id = qt.inquiry_id AND i.tenant_id = qt.tenant_id
        WHERE qt.id = $1`,
      [taskId],
    );
    if (result.rows.length === 0) throw new QuoteTaskNotFoundException();
    return result.rows[0];
  }

  async listQuoteTasks(actor: RequestActor): Promise<QuoteTaskResponse[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const result = await client.query<QuoteTaskRow>(
          `SELECT ${TASK_COLUMNS}
             FROM quote_tasks qt
             JOIN inquiries i ON i.id = qt.inquiry_id AND i.tenant_id = qt.tenant_id
            ORDER BY qt.created_at DESC, qt.id DESC`,
        );
        return result.rows.map(toQuoteTaskResponse);
      },
    );
  }

  async getQuoteTask(actor: RequestActor, taskId: string): Promise<QuoteTaskResponse> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => toQuoteTaskResponse(await this.taskById(client, taskId)),
    );
  }

  async manuallyCorrect(
    actor: RequestActor,
    taskId: string,
    dto: ManualQuoteTaskDto,
  ): Promise<QuoteTaskResponse> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const source = await client.query<{
          inquiry_id: string;
          customer_code: string;
          customer_message: string;
        }>(
          `SELECT qt.inquiry_id, i.customer_code, i.customer_message
             FROM quote_tasks qt
             JOIN inquiries i ON i.id = qt.inquiry_id AND i.tenant_id = qt.tenant_id
            WHERE qt.id = $1
            FOR UPDATE OF qt`,
          [taskId],
        );
        if (source.rows.length === 0) throw new QuoteTaskNotFoundException();
        const inquiryItems = await this.items(client, source.rows[0].inquiry_id);
        const sanitized = validateSanitizedQuoteTask(
          {
            summary: dto.summary,
            items: dto.items.map((item) => ({
              ...item,
              specifications: item.specifications ?? null,
            })),
          },
          inquiryItems,
          source.rows[0].customer_code,
          source.rows[0].customer_message,
        );
        await client.query(
          `UPDATE quote_tasks
              SET sanitization_status = 'manually_corrected',
                  sanitized_summary = $2,
                  sanitized_payload = $3,
                  provider_name = 'manual',
                  provider_invocation_id = NULL,
                  last_error_code = NULL,
                  corrected_by = $4,
                  corrected_at = now(),
                  completed_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [taskId, sanitized.summary, JSON.stringify(sanitized.payload), actor.userId],
        );
        await client.query(
          `UPDATE inquiries SET status = 'quoting', updated_at = now()
            WHERE id = $1 AND status = 'submitted'`,
          [source.rows[0].inquiry_id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'quote_task.manually_corrected',
          resourceType: 'quote_task',
          resourceId: taskId,
          after: { sanitization_status: 'manually_corrected' },
        });
        return toQuoteTaskResponse(await this.taskById(client, taskId));
      },
    );
  }

  private async beginSanitization(
    actor: RequestActor,
    inquiryId: string,
  ): Promise<SanitizationSource> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const inquiry = await this.inquiry(client, actor, inquiryId, true);
        if (inquiry.status === 'draft') {
          throw new InquiryStateConflictException('Submit the inquiry before sanitization');
        }
        const taskResult = await client.query<{
          id: string;
          sanitization_status: string;
          attempt_count: number;
          last_attempted_at: Date | null;
        }>(
          `SELECT id, sanitization_status, attempt_count, last_attempted_at
             FROM quote_tasks
            WHERE inquiry_id = $1
            FOR UPDATE`,
          [inquiryId],
        );
        if (taskResult.rows.length === 0) throw new QuoteTaskNotFoundException();
        const task = taskResult.rows[0];
        if (
          task.sanitization_status === 'processing' &&
          task.last_attempted_at !== null &&
          task.last_attempted_at.getTime() > Date.now() - SANITIZATION_LEASE_MINUTES * 60 * 1000
        ) {
          throw new InquiryStateConflictException('Sanitization is already in progress');
        }
        if (['ready', 'manually_corrected'].includes(task.sanitization_status)) {
          throw new InquiryStateConflictException('Quote task is already ready');
        }
        const attempt = task.attempt_count + 1;
        await client.query(
          `UPDATE quote_tasks
              SET sanitization_status = 'processing',
                  sanitized_summary = NULL,
                  sanitized_payload = NULL,
                  provider_invocation_id = NULL,
                  last_error_code = NULL,
                  attempt_count = $2,
                  last_attempted_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [task.id, attempt],
        );
        return {
          taskId: task.id,
          attempt,
          customerCode: inquiry.customer_code,
          customerCountry: inquiry.customer_country,
          customerMessage: inquiry.customer_message,
          items: await this.items(client, inquiry.id),
        };
      },
    );
  }

  private async finishSanitization(
    actor: RequestActor,
    source: SanitizationSource,
    result: {
      status: 'ready' | 'timeout' | 'rate_limited' | 'parse_failed' | 'provider_failed';
      summary?: string;
      payload?: unknown;
      providerName?: string | null;
      invocationId?: string | null;
      errorCode?: string | null;
    },
  ): Promise<QuoteTaskResponse> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const updated = await client.query<{ inquiry_id: string }>(
          `UPDATE quote_tasks
              SET sanitization_status = $3::varchar(24),
                  sanitized_summary = $4,
                  sanitized_payload = $5,
                  provider_name = $6,
                  provider_invocation_id = $7,
                  last_error_code = $8,
                  completed_at = CASE WHEN $3::varchar(24) = 'ready' THEN now() ELSE NULL END,
                  updated_at = now()
            WHERE id = $1
              AND attempt_count = $2
              AND sanitization_status = 'processing'
          RETURNING inquiry_id`,
          [
            source.taskId,
            source.attempt,
            result.status,
            result.summary ?? null,
            result.payload === undefined ? null : JSON.stringify(result.payload),
            result.providerName ?? null,
            result.invocationId ?? null,
            result.errorCode ?? null,
          ],
        );
        if (updated.rows.length > 0 && result.status === 'ready') {
          await client.query(
            `UPDATE inquiries SET status = 'quoting', updated_at = now()
              WHERE id = $1 AND status = 'submitted'`,
            [updated.rows[0].inquiry_id],
          );
        }
        if (updated.rows.length > 0) {
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action:
              result.status === 'ready' ? 'quote_task.sanitized' : 'quote_task.sanitize_failed',
            resourceType: 'quote_task',
            resourceId: source.taskId,
            after: {
              sanitization_status: result.status,
              provider_name: result.providerName ?? null,
              provider_invocation_id: result.invocationId ?? null,
              error_code: result.errorCode ?? null,
              attempt: source.attempt,
            },
          });
        }
        return toQuoteTaskResponse(await this.taskById(client, source.taskId));
      },
    );
  }

  async sanitize(actor: RequestActor, inquiryId: string): Promise<QuoteTaskResponse> {
    const source = await this.beginSanitization(actor, inquiryId);
    const prompt = buildSanitizationPrompt(
      source.customerCountry,
      source.customerMessage,
      source.items,
    );

    const outcome = await this.ai.aiCompleteOutcome(actor, {
      task: 'sanitize-inquiry-for-supplier',
      input: prompt,
      timeoutMs: 15_000,
      maxOutputTokens: 4000,
    });

    if (!outcome.ok) {
      const status =
        outcome.error instanceof AiTimeoutException
          ? 'timeout'
          : outcome.error instanceof AiRateLimitException
            ? 'rate_limited'
            : outcome.error instanceof AiResponseParseException
              ? 'parse_failed'
              : 'provider_failed';
      return this.finishSanitization(actor, source, {
        status,
        providerName: outcome.invocation.providerName,
        invocationId: outcome.invocation.id,
        errorCode: status,
      });
    }

    try {
      const sanitized = parseSanitizedQuoteTask(
        outcome.response.output,
        source.items,
        source.customerCode,
        source.customerMessage,
      );
      return this.finishSanitization(actor, source, {
        status: 'ready',
        summary: sanitized.summary,
        payload: sanitized.payload,
        providerName: outcome.response.invocation.providerName,
        invocationId: outcome.response.invocation.id,
      });
    } catch (error) {
      if (!(error instanceof SanitizedOutputInvalidException)) throw error;
      return this.finishSanitization(actor, source, {
        status: 'parse_failed',
        providerName: outcome.response.invocation.providerName,
        invocationId: outcome.response.invocation.id,
        errorCode: 'invalid_structured_output',
      });
    }
  }
}
