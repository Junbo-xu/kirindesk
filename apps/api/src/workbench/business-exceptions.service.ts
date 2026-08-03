import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { AuditService } from '../audit/audit.service';
import { BusinessEventsService } from './business-events.service';
import { ListBusinessExceptionsQuery } from './dto/list-business-exceptions.query';
import {
  BusinessExceptionAssigneeNotFoundException,
  BusinessExceptionNotFoundException,
  BusinessExceptionStateConflictException,
} from './workbench.errors';

export type BusinessExceptionType =
  | 'price_variance'
  | 'quantity_variance'
  | 'quality_variance'
  | 'missing_expense'
  | 'duplicate_customer';

export interface ExceptionActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface OpenBusinessExceptionInput {
  contextType:
    | 'customer'
    | 'inquiry'
    | 'sales_order'
    | 'purchase_order'
    | 'shipment'
    | 'finance_review'
    | 'sample_order'
    | 'after_sales_case';
  contextId: string;
  type: BusinessExceptionType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  ownerUserId?: string | null;
}

interface ExceptionRow {
  id: string;
  tenant_id: string;
  context_type: string;
  context_id: string;
  exception_type: BusinessExceptionType;
  severity: string;
  status: string;
  summary: string;
  owner_user_id: string | null;
  assigned_to_user_id: string | null;
  assignee_name: string | null;
  resolution: string | null;
  version: number;
  detected_at: Date;
  assigned_at: Date | null;
  started_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const EXCEPTION_COLUMNS = `be.id, be.tenant_id, be.context_type, be.context_id,
  be.exception_type, be.severity, be.status, be.summary, be.owner_user_id,
  be.assigned_to_user_id, assignee.name AS assignee_name, be.resolution,
  be.version, be.detected_at, be.assigned_at, be.started_at, be.resolved_at,
  be.closed_at, be.created_at, be.updated_at`;

@Injectable()
export class BusinessExceptionsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly events: BusinessEventsService,
  ) {}

  async open(actor: ExceptionActor, input: OpenBusinessExceptionInput) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const result = await client.query<ExceptionRow>(
          `INSERT INTO business_exceptions
             (tenant_id, context_type, context_id, exception_type, severity, summary, owner_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, tenant_id, context_type, context_id, exception_type, severity,
             status, summary, owner_user_id, assigned_to_user_id, NULL::text AS assignee_name,
             resolution, version, detected_at, assigned_at, started_at, resolved_at,
             closed_at, created_at, updated_at`,
          [
            actor.tenantId,
            input.contextType,
            input.contextId,
            input.type,
            input.severity,
            input.summary.trim(),
            input.ownerUserId ?? null,
          ],
        );
        const row = result.rows[0];
        await this.auditMutation(client, actor, 'business_exception.opened', row, null);
        await this.eventMutation(client, actor, 'business_exception.opened', row);
        return this.response(row);
      },
    );
  }

  async list(actor: ExceptionActor, query: ListBusinessExceptionsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const conditions: string[] = [];
    const params: unknown[] = [];
    this.addScope(conditions, params, actor);
    if (query.type) {
      params.push(query.type);
      conditions.push(`be.exception_type = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`be.status = $${params.length}`);
    }
    if (query.assigneeUserId) {
      params.push(query.assigneeUserId);
      conditions.push(`be.assigned_to_user_id = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const total = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM business_exceptions be ${where}`,
          params,
        );
        const rows = await client.query<ExceptionRow>(
          `SELECT ${EXCEPTION_COLUMNS}
             FROM business_exceptions be
             LEFT JOIN users assignee ON assignee.id = be.assigned_to_user_id
             ${where}
            ORDER BY
              CASE be.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
              be.detected_at DESC, be.id DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: rows.rows.map((row) => this.response(row)),
          page,
          pageSize,
          total: Number(total.rows[0].count),
        };
      },
    );
  }

  async getOne(actor: ExceptionActor, id: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => this.response(await this.fetch(client, actor, id, false)),
    );
  }

  async listAssignees(actor: ExceptionActor) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<{ id: string; name: string; email: string }>(
          `SELECT id, name, email FROM users
            WHERE status = 'active' AND deleted_at IS NULL
            ORDER BY name, id`,
        );
        return rows;
      },
    );
  }

  async assign(actor: ExceptionActor, id: string, assigneeUserId: string, expectedVersion: number) {
    return this.mutate(actor, id, expectedVersion, ['open', 'assigned'], async (client, before) => {
      const assignee = await client.query(
        `SELECT id FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
        [assigneeUserId],
      );
      if (assignee.rows.length === 0) throw new BusinessExceptionAssigneeNotFoundException();
      const updated = await client.query<ExceptionRow>(
        `UPDATE business_exceptions
            SET status = 'assigned', assigned_to_user_id = $1,
                assigned_at = now(), updated_at = now(), version = version + 1
          WHERE id = $2 AND version = $3
          RETURNING id, tenant_id, context_type, context_id, exception_type, severity,
            status, summary, owner_user_id, assigned_to_user_id,
            (SELECT name FROM users WHERE id = $1) AS assignee_name,
            resolution, version, detected_at, assigned_at, started_at, resolved_at,
            closed_at, created_at, updated_at`,
        [assigneeUserId, id, expectedVersion],
      );
      if (updated.rows.length === 0) throw new BusinessExceptionStateConflictException();
      return { row: updated.rows[0], eventType: 'business_exception.assigned', before };
    });
  }

  async start(actor: ExceptionActor, id: string, expectedVersion: number) {
    return this.mutate(actor, id, expectedVersion, ['assigned'], async (client, before) => {
      const updated = await client.query<ExceptionRow>(
        `UPDATE business_exceptions
            SET status = 'in_progress', started_at = now(), updated_at = now(), version = version + 1
          WHERE id = $1 AND version = $2
          RETURNING id, tenant_id, context_type, context_id, exception_type, severity,
            status, summary, owner_user_id, assigned_to_user_id,
            (SELECT name FROM users WHERE id = assigned_to_user_id) AS assignee_name,
            resolution, version, detected_at, assigned_at, started_at, resolved_at,
            closed_at, created_at, updated_at`,
        [id, expectedVersion],
      );
      if (updated.rows.length === 0) throw new BusinessExceptionStateConflictException();
      return { row: updated.rows[0], eventType: 'business_exception.started', before };
    });
  }

  async resolve(actor: ExceptionActor, id: string, resolution: string, expectedVersion: number) {
    return this.mutate(actor, id, expectedVersion, ['in_progress'], async (client, before) => {
      const updated = await client.query<ExceptionRow>(
        `UPDATE business_exceptions
            SET status = 'resolved', resolution = $1, resolved_at = now(),
                updated_at = now(), version = version + 1
          WHERE id = $2 AND version = $3
          RETURNING id, tenant_id, context_type, context_id, exception_type, severity,
            status, summary, owner_user_id, assigned_to_user_id,
            (SELECT name FROM users WHERE id = assigned_to_user_id) AS assignee_name,
            resolution, version, detected_at, assigned_at, started_at, resolved_at,
            closed_at, created_at, updated_at`,
        [resolution.trim(), id, expectedVersion],
      );
      if (updated.rows.length === 0) throw new BusinessExceptionStateConflictException();
      return { row: updated.rows[0], eventType: 'business_exception.resolved', before };
    });
  }

  async close(actor: ExceptionActor, id: string, expectedVersion: number) {
    return this.mutate(actor, id, expectedVersion, ['resolved'], async (client, before) => {
      const updated = await client.query<ExceptionRow>(
        `UPDATE business_exceptions
            SET status = 'closed', closed_at = now(), updated_at = now(), version = version + 1
          WHERE id = $1 AND version = $2
          RETURNING id, tenant_id, context_type, context_id, exception_type, severity,
            status, summary, owner_user_id, assigned_to_user_id,
            (SELECT name FROM users WHERE id = assigned_to_user_id) AS assignee_name,
            resolution, version, detected_at, assigned_at, started_at, resolved_at,
            closed_at, created_at, updated_at`,
        [id, expectedVersion],
      );
      if (updated.rows.length === 0) throw new BusinessExceptionStateConflictException();
      return { row: updated.rows[0], eventType: 'business_exception.closed', before };
    });
  }

  private async mutate(
    actor: ExceptionActor,
    id: string,
    expectedVersion: number,
    allowedStatuses: string[],
    operation: (
      client: PoolClient,
      before: ExceptionRow,
    ) => Promise<{ row: ExceptionRow; eventType: string; before: ExceptionRow }>,
  ) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const before = await this.fetch(client, actor, id, true);
        if (before.version !== expectedVersion || !allowedStatuses.includes(before.status)) {
          throw new BusinessExceptionStateConflictException();
        }
        if (
          (actor.dataScope === 'own' || actor.dataScope === 'assigned') &&
          before.assigned_to_user_id !== actor.userId &&
          before.owner_user_id !== actor.userId
        ) {
          throw new BusinessExceptionNotFoundException();
        }
        const result = await operation(client, before);
        await this.auditMutation(client, actor, result.eventType, result.row, result.before);
        await this.eventMutation(client, actor, result.eventType, result.row);
        return this.response(result.row);
      },
    );
  }

  private async fetch(client: PoolClient, actor: ExceptionActor, id: string, lock: boolean) {
    const conditions = ['be.id = $1'];
    const params: unknown[] = [id];
    this.addScope(conditions, params, actor);
    const result = await client.query<ExceptionRow>(
      `SELECT ${EXCEPTION_COLUMNS}
         FROM business_exceptions be
         LEFT JOIN users assignee ON assignee.id = be.assigned_to_user_id
        WHERE ${conditions.join(' AND ')}${lock ? ' FOR UPDATE OF be' : ''}`,
      params,
    );
    if (result.rows.length === 0) throw new BusinessExceptionNotFoundException();
    return result.rows[0];
  }

  private addScope(conditions: string[], params: unknown[], actor: ExceptionActor) {
    if (actor.dataScope === 'own') {
      params.push(actor.userId);
      conditions.push(`be.owner_user_id = $${params.length}`);
    } else if (actor.dataScope === 'assigned') {
      params.push(actor.userId);
      conditions.push(`be.assigned_to_user_id = $${params.length}`);
    }
  }

  private async auditMutation(
    client: PoolClient,
    actor: ExceptionActor,
    action: string,
    after: ExceptionRow,
    before: ExceptionRow | null,
  ) {
    await this.audit.logInTransaction(client, {
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action,
      resourceType: 'business_exception',
      resourceId: after.id,
      before: before ? this.auditState(before) : undefined,
      after: this.auditState(after),
    });
  }

  private async eventMutation(
    client: PoolClient,
    actor: ExceptionActor,
    eventType: string,
    row: ExceptionRow,
  ) {
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType: row.context_type,
      chainId: row.context_id,
      credentialType: 'business_exception',
      credentialId: row.id,
      eventType,
      actorType: 'tenant_user',
      actorId: actor.userId,
      scopeUserId: row.assigned_to_user_id ?? row.owner_user_id,
      visibilityPermission: 'business_exceptions:view',
    });
  }

  private auditState(row: ExceptionRow) {
    return {
      status: row.status,
      severity: row.severity,
      assignedToUserId: row.assigned_to_user_id,
      version: row.version,
    };
  }

  private response(row: ExceptionRow) {
    return {
      id: row.id,
      contextType: row.context_type,
      contextId: row.context_id,
      type: row.exception_type,
      severity: row.severity,
      status: row.status,
      summary: row.summary,
      ownerUserId: row.owner_user_id,
      assignedToUserId: row.assigned_to_user_id,
      assigneeName: row.assignee_name,
      resolution: row.resolution,
      version: row.version,
      detectedAt: row.detected_at,
      assignedAt: row.assigned_at,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
      closedAt: row.closed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
