import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { OCR_PROVIDER, OcrProvider } from './ocr-provider.interface';
import { AI_PROVIDER, AiProvider } from './ai-provider.interface';
import { QuotaService } from '../subscription/quota.service';
import { FileNotInScopeException } from './ai.errors';
import { InvocationRow, InvocationSummary, toInvocationSummary } from './ai-invocation.response';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface OcrExtractRequest {
  fileId: string;
  docType?: string;
  timeoutMs?: number;
  languages?: string[];
}

export interface AiCompleteRequest {
  task: string;
  input: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface ListInvocationsQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  fileId?: string;
}

export interface ListResult {
  data: InvocationSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** OCR result returned live to the caller. The full text/fields are NOT
 *  persisted (plan §5.3); only the summary in `invocation` is stored. */
export interface OcrExtractResponse {
  invocation: InvocationSummary;
  text: string;
  fields: { key: string; value: string; confidence: number }[];
  confidence: number;
}

/** AI result returned live to the caller. The full output is NOT persisted. */
export interface AiCompleteResponse {
  invocation: InvocationSummary;
  output: string;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const STATUS_SUCCESS = 'success';
const STATUS_ERROR = 'error';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(OCR_PROVIDER) private readonly ocr: OcrProvider,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly auditService: AuditService,
    private readonly quota: QuotaService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  // Confirms the file is visible to the caller (tenant + dataScope) before we
  // spend a provider call on it. An out-of-scope / missing file is opaque: it
  // surfaces as the same not-in-scope error, never revealing existence.
  private async assertFileInScope(actor: RequestActor, fileId: string): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [fileId];
        let scopeClause = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scopeClause = ' AND uploaded_by = $2';
        }
        const { rows } = await client.query(
          `SELECT id FROM files WHERE id = $1 AND deleted_at IS NULL${scopeClause}`,
          params,
        );
        if (rows.length === 0) {
          throw new FileNotInScopeException();
        }
      },
    );
  }

  /**
   * Triggers an OCR extraction over a file the caller can see, then records the
   * invocation in both layers (plan §5): one provider_invocations row plus one
   * audit_logs event, on success AND on failure. The provider exception is
   * re-thrown after recording — the call is never silently swallowed.
   */
  async ocrExtract(actor: RequestActor, req: OcrExtractRequest): Promise<OcrExtractResponse> {
    await this.assertFileInScope(actor, req.fileId);

    let result: Awaited<ReturnType<OcrProvider['extract']>> | undefined;
    let providerError: unknown;
    try {
      result = await this.ocr.extract({
        fileId: req.fileId,
        docType: req.docType,
        options: { timeoutMs: req.timeoutMs, languages: req.languages },
      });
    } catch (err) {
      providerError = err;
    }

    const status = providerError ? STATUS_ERROR : STATUS_SUCCESS;
    // Summaries only — never the raw OCR text or file content (plan §5.3/§5.6).
    const requestSummary = { fileId: req.fileId, docType: req.docType ?? null };
    const responseSummary = result
      ? {
          fieldCount: result.fields.length,
          confidence: result.confidence,
          textLength: result.text.length,
        }
      : { reason: this.failureReason(providerError) };

    const row = await this.recordInvocation({
      actor,
      providerType: 'ocr',
      providerName: this.ocr.name,
      action: 'ocr.extract',
      status,
      durationMs: result?.durationMs ?? null,
      tokensUsed: null,
      sourceFileId: req.fileId,
      requestSummary,
      responseSummary,
    });

    await this.safeAudit({
      actor,
      action: providerError ? 'provider.ocr.failed' : 'provider.ocr.invoked',
      resourceId: row.id,
      metadata: {
        providerType: 'ocr',
        providerName: this.ocr.name,
        action: 'ocr.extract',
        status,
        durationMs: row.duration_ms,
        fileId: req.fileId,
      },
    });

    if (providerError) {
      throw providerError;
    }
    // result is defined when there is no providerError.
    void this.quota
      .incrementAi(actor.tenantId, actor.userId)
      .catch(() => this.logger.warn('quota incrementAi failed for ocr.extract'));
    const ok = result as NonNullable<typeof result>;
    return {
      invocation: toInvocationSummary(row),
      text: ok.text,
      fields: ok.fields,
      confidence: ok.confidence,
    };
  }

  /**
   * Triggers an AI completion over already-minimized text, recording both audit
   * layers exactly as ocrExtract does. Callers must not pass raw files (plan
   * §3.3/§5.6); only the input length is summarized, never the text itself.
   */
  async aiComplete(actor: RequestActor, req: AiCompleteRequest): Promise<AiCompleteResponse> {
    let result: Awaited<ReturnType<AiProvider['complete']>> | undefined;
    let providerError: unknown;
    try {
      result = await this.ai.complete({
        task: req.task,
        input: req.input,
        options: { timeoutMs: req.timeoutMs, maxOutputTokens: req.maxOutputTokens },
      });
    } catch (err) {
      providerError = err;
    }

    const status = providerError ? STATUS_ERROR : STATUS_SUCCESS;
    const requestSummary = { task: req.task, inputLength: req.input.length };
    const responseSummary = result
      ? { outputLength: result.output.length, tokensUsed: result.tokensUsed }
      : { reason: this.failureReason(providerError) };

    const row = await this.recordInvocation({
      actor,
      providerType: 'ai',
      providerName: this.ai.name,
      action: 'ai.complete',
      status,
      durationMs: result?.durationMs ?? null,
      tokensUsed: result?.tokensUsed ?? null,
      sourceFileId: null,
      requestSummary,
      responseSummary,
    });

    await this.safeAudit({
      actor,
      action: providerError ? 'provider.ai.failed' : 'provider.ai.invoked',
      resourceId: row.id,
      metadata: {
        providerType: 'ai',
        providerName: this.ai.name,
        action: 'ai.complete',
        status,
        durationMs: row.duration_ms,
      },
    });

    if (providerError) {
      throw providerError;
    }
    void this.quota
      .incrementAi(actor.tenantId, actor.userId)
      .catch(() => this.logger.warn('quota incrementAi failed for ai.complete'));
    const ok = result as NonNullable<typeof result>;
    return { invocation: toInvocationSummary(row), output: ok.output };
  }

  async list(
    actor: RequestActor,
    providerType: 'ocr' | 'ai',
    query: ListInvocationsQuery,
  ): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['provider_type = $1'];
    const params: unknown[] = [providerType];

    // dataScope pushed into the WHERE, on top of RLS tenant isolation: an
    // own-scoped caller can only ever see their own invocations (plan §6.4).
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      conditions.push(`invoked_by = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.fileId) {
      params.push(query.fileId);
      conditions.push(`source_file_id = $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const totalRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM provider_invocations ${where}`,
          params,
        );
        const dataRes = await client.query<InvocationRow>(
          `SELECT id, tenant_id, provider_type, provider_name, action, status,
                  duration_ms, tokens_used, source_file_id, invoked_by, created_at
             FROM provider_invocations ${where}
            ORDER BY created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: dataRes.rows.map(toInvocationSummary),
          page,
          pageSize,
          total: parseInt(totalRes.rows[0].count, 10),
        };
      },
    );
  }

  async getOne(
    actor: RequestActor,
    providerType: 'ocr' | 'ai',
    id: string,
  ): Promise<InvocationSummary> {
    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [id, providerType];
        let scopeClause = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scopeClause = ' AND invoked_by = $3';
        }
        const { rows } = await client.query<InvocationRow>(
          `SELECT id, tenant_id, provider_type, provider_name, action, status,
                  duration_ms, tokens_used, source_file_id, invoked_by, created_at
             FROM provider_invocations
            WHERE id = $1 AND provider_type = $2${scopeClause}`,
          params,
        );
        if (rows.length === 0) {
          throw new FileNotInScopeException();
        }
        return rows[0];
      },
    );
    return toInvocationSummary(row);
  }

  // Maps a provider error to a short, vendor-neutral reason tag for the
  // response_json summary. Never stores the raw error (plan §5.6).
  private failureReason(err: unknown): string {
    const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? '';
    if (name.includes('Timeout')) return 'timeout';
    return 'provider_error';
  }

  private async recordInvocation(params: {
    actor: RequestActor;
    providerType: string;
    providerName: string;
    action: string;
    status: string;
    durationMs: number | null;
    tokensUsed: number | null;
    sourceFileId: string | null;
    requestSummary: unknown;
    responseSummary: unknown;
  }): Promise<InvocationRow> {
    return withTenantContext(
      this.pool,
      {
        tenantId: params.actor.tenantId,
        userId: params.actor.userId,
        actorType: 'tenant_user',
      },
      async (client: PoolClient) => {
        const { rows } = await client.query<InvocationRow>(
          `INSERT INTO provider_invocations
             (tenant_id, provider_type, provider_name, action, request_json,
              response_json, status, duration_ms, tokens_used, source_file_id,
              invoked_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id, tenant_id, provider_type, provider_name, action, status,
                     duration_ms, tokens_used, source_file_id, invoked_by, created_at`,
          [
            params.actor.tenantId,
            params.providerType,
            params.providerName,
            params.action,
            JSON.stringify(params.requestSummary),
            JSON.stringify(params.responseSummary),
            params.status,
            params.durationMs,
            params.tokensUsed,
            params.sourceFileId,
            params.actor.userId,
          ],
        );
        return rows[0];
      },
    );
  }

  // Audit failures are logged but never block the call: the provider_invocations
  // row is the durable operational record, and the audit chain is best-effort
  // at the boundary (same posture as FilesService.safeAudit).
  private async safeAudit(params: {
    actor: RequestActor;
    action: string;
    resourceId: string;
    metadata: unknown;
  }): Promise<void> {
    try {
      await this.auditService.log({
        tenantId: params.actor.tenantId,
        actorType: 'tenant_user',
        actorId: params.actor.userId,
        action: params.action,
        resourceType: 'provider_invocation',
        resourceId: params.resourceId,
        metadata: params.metadata,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} invocation=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}
