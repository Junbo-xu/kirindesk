import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/storage-provider.interface';
import { QuotaService } from '../subscription/quota.service';
import { ListFilesQuery } from './dto/list-files.query';
import {
  FileInUseException,
  FileNotFoundException,
  InvalidDownloadTokenException,
} from './files.errors';
import { DOWNLOAD_TOKEN_TTL_MS } from './files.constants';
import { FileRow, FileResponse, toFileResponse } from './files.response';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface UploadInput {
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  purpose?: string;
}

export interface ListResult {
  data: FileResponse[];
  page: number;
  pageSize: number;
  total: number;
}

export interface DownloadTarget {
  stream: Readable;
  fileName: string;
  mimeType: string;
  sizeBytes: string;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const FK_VIOLATION = '23503';

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly auditService: AuditService,
    private readonly quota: QuotaService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  // sha256 over the raw bytes, computed server-side (the client value, if any,
  // is never trusted).
  private hashBytes(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  async upload(actor: RequestActor, input: UploadInput): Promise<FileResponse> {
    const sha256 = this.hashBytes(input.buffer);
    // Server-generated, tenant-prefixed, opaque key. Never derived from the
    // user-supplied file name (which could contain path traversal or collide).
    const storageKey = `${actor.tenantId}/${randomUUID()}`;

    // Store bytes first; only record metadata if the object landed. If the DB
    // insert later fails, the orphaned object is harmless (no row references it)
    // and can be swept later.
    await this.storage.put(storageKey, input.buffer, input.mimeType);

    let row: FileRow;
    try {
      row = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const { rows } = await client.query<FileRow>(
            `INSERT INTO files
               (tenant_id, uploaded_by, original_name, storage_key, mime_type,
                size_bytes, sha256, purpose)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
              actor.tenantId,
              actor.userId,
              input.originalName,
              storageKey,
              input.mimeType,
              input.buffer.length,
              sha256,
              input.purpose ?? null,
            ],
          );
          return rows[0];
        },
      );
    } catch (err) {
      // Roll back the stored object so a failed insert leaves no orphan.
      await this.storage.delete(storageKey).catch((delErr) => {
        this.logger.error(
          `Failed to clean up orphaned object ${storageKey} after insert error: ${String(delErr)}`,
        );
      });
      throw err;
    }

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'file.uploaded',
      resourceId: row.id,
      after: toFileResponse(row),
    });

    void this.quota
      .addStorage(actor.tenantId, actor.userId, input.buffer.length)
      .catch(() => this.logger.warn('quota addStorage failed for file.upload'));
    return toFileResponse(row);
  }

  async list(actor: RequestActor, query: ListFilesQuery): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];

    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      conditions.push(`uploaded_by = $${params.length}`);
    }
    if (query.purpose) {
      params.push(query.purpose);
      conditions.push(`purpose = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      conditions.push(`original_name ILIKE $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const totalRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM files ${where}`,
          params,
        );
        const dataRes = await client.query<FileRow>(
          `SELECT * FROM files ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: dataRes.rows.map(toFileResponse),
          page,
          pageSize,
          total: parseInt(totalRes.rows[0].count, 10),
        };
      },
    );
  }

  private async fetchInScope(
    client: PoolClient,
    actor: RequestActor,
    id: string,
  ): Promise<FileRow> {
    const params: unknown[] = [id];
    let scopeClause = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scopeClause = ' AND uploaded_by = $2';
    }
    const { rows } = await client.query<FileRow>(
      `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL${scopeClause}`,
      params,
    );
    if (rows.length === 0) {
      throw new FileNotFoundException();
    }
    return rows[0];
  }

  async getOne(actor: RequestActor, id: string): Promise<FileResponse> {
    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      (client) => this.fetchInScope(client, actor, id),
    );
    return toFileResponse(row);
  }

  /**
   * Issues a short-lived, single-use download token for a file the caller can
   * see. Returns the raw token (shown once); only its sha256 hash is stored, so
   * a DB leak cannot reconstruct usable links.
   */
  async createDownloadToken(
    actor: RequestActor,
    id: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MS);

    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        // Confirms visibility/scope before minting a token.
        const file = await this.fetchInScope(client, actor, id);
        await client.query(
          `INSERT INTO file_access_tokens
             (tenant_id, file_id, token_hash, purpose, created_by, expires_at)
           VALUES ($1, $2, $3, 'download', $4, $5)`,
          [actor.tenantId, file.id, tokenHash, actor.userId, expiresAt],
        );
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'file.token_issued',
      resourceId: id,
    });

    return { token: rawToken, expiresAt };
  }

  /**
   * Resolves a raw download token to a streamable target. Validates the token
   * is unexpired, unused and unrevoked, marks it used (single-use), and streams
   * the object. Runs WITHOUT tenant context input from the caller — the token
   * row carries the tenant_id, which is set as the RLS context. Anonymous-safe:
   * every failure maps to one generic 404.
   */
  async resolveDownload(rawToken: string): Promise<DownloadTarget> {
    if (!rawToken || rawToken.length < 32) {
      throw new InvalidDownloadTokenException();
    }
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');

    // Look up the token with the superuser pool (no tenant context) to read its
    // tenant_id, then operate within that tenant's RLS context. The token hash
    // is the bearer credential.
    const tokenRow = await this.lookupTokenTenant(tokenHash);
    if (!tokenRow) {
      throw new InvalidDownloadTokenException();
    }

    const { file, auditActor } = await withTenantContext(
      this.pool,
      { tenantId: tokenRow.tenant_id, userId: tokenRow.created_by, actorType: 'tenant_user' },
      async (client) => {
        // Atomically claim the token: only succeeds if still valid and unused.
        const claim = await client.query<{ file_id: string; created_by: string }>(
          `UPDATE file_access_tokens
             SET used_at = now()
           WHERE token_hash = $1
             AND used_at IS NULL
             AND revoked_at IS NULL
             AND expires_at > now()
           RETURNING file_id, created_by`,
          [tokenHash],
        );
        if (claim.rows.length === 0) {
          throw new InvalidDownloadTokenException();
        }
        const fileId = claim.rows[0].file_id;
        const { rows } = await client.query<FileRow>(
          `SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`,
          [fileId],
        );
        if (rows.length === 0) {
          throw new InvalidDownloadTokenException();
        }
        return { file: rows[0], auditActor: claim.rows[0].created_by };
      },
    );

    const stream = await this.storage.get(file.storage_key);

    await this.safeAudit({
      tenantId: tokenRow.tenant_id,
      actorId: auditActor,
      action: 'file.downloaded',
      resourceId: file.id,
    });

    return {
      stream,
      fileName: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
    };
  }

  // Resolves a token hash to its tenant_id/created_by via the SECURITY DEFINER
  // helper app_lookup_file_token (migration 028), which bypasses RLS for this
  // one narrow lookup. Needed because the download caller is anonymous and the
  // tenant_id required to set the RLS context lives inside the token row itself.
  // Safe: the token hash is 32 unguessable random bytes and the function
  // returns only tenant_id + created_by. The caller re-validates and claims the
  // token under normal tenant RLS afterwards.
  private async lookupTokenTenant(
    tokenHash: string,
  ): Promise<{ tenant_id: string; created_by: string } | null> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{ tenant_id: string; created_by: string }>(
        `SELECT tenant_id, created_by FROM app_lookup_file_token($1)`,
        [tokenHash],
      );
      return res.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  async remove(actor: RequestActor, id: string): Promise<void> {
    let before: FileRow;
    let after: FileRow;
    try {
      const result = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const existing = await this.fetchInScope(client, actor, id);
          const { rows } = await client.query<FileRow>(
            `UPDATE files SET deleted_at = now()
             WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id],
          );
          return { before: existing, after: rows[0] };
        },
      );
      before = result.before;
      after = result.after;
    } catch (err) {
      if ((err as { code?: string }).code === FK_VIOLATION) {
        // Referenced by an order's pi_file_id (ON DELETE RESTRICT). Surface as a
        // conflict rather than a 500.
        throw new FileInUseException();
      }
      throw err;
    }

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'file.deleted',
      resourceId: id,
      before: toFileResponse(before),
      after: { ...toFileResponse(after), deleted: true },
    });

    void this.quota
      .subtractStorage(actor.tenantId, actor.userId, Number(before.size_bytes))
      .catch(() => this.logger.warn('quota subtractStorage failed for file.remove'));
  }

  private async safeAudit(params: {
    tenantId: string;
    actorId: string;
    action: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    try {
      await this.auditService.log({
        tenantId: params.tenantId,
        actorType: 'tenant_user',
        actorId: params.actorId,
        action: params.action,
        resourceType: 'file',
        resourceId: params.resourceId,
        before: params.before,
        after: params.after,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} file=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}
