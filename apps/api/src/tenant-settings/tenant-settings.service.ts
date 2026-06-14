import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { SUPPORTED_BASE_CURRENCIES } from './dto/update-base-currency.dto';

export interface RequestActor {
  userId: string;
  tenantId: string;
}

export interface BaseCurrencyResponse {
  base_currency: string;
}

// The KV key under which the tenant base currency is stored in tenant_settings.
const BASE_CURRENCY_KEY = 'base_currency';
// Default when no row exists yet. Must match the order services' fallback so a
// tenant that never set a base currency derives FX consistently across the app.
const DEFAULT_BASE_CURRENCY = 'RMB';

@Injectable()
export class TenantSettingsService {
  private readonly logger = new Logger(TenantSettingsService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
  ) {}

  // Reads the tenant base currency from the KV tenant_settings row, falling back
  // to the default when unset. value_json holds a JSON scalar string (e.g.
  // "RMB"); `#>> '{}'` extracts it as text. RLS scopes the read to this tenant.
  async getBaseCurrency(actor: RequestActor): Promise<BaseCurrencyResponse> {
    const base_currency = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<{ base_currency: string | null }>(
          `SELECT value_json #>> '{}' AS base_currency
             FROM tenant_settings
            WHERE key = $1
            LIMIT 1`,
          [BASE_CURRENCY_KEY],
        );
        return rows[0]?.base_currency ?? DEFAULT_BASE_CURRENCY;
      },
    );
    return { base_currency };
  }

  // Upserts the tenant base currency. The value is validated against the
  // currency whitelist by the DTO before reaching here. Stores the code as a
  // JSON scalar string in value_json and stamps updated_by/updated_at. Records a
  // tenant_settings.updated audit entry (before/after) after the write commits.
  async setBaseCurrency(
    actor: RequestActor,
    next: (typeof SUPPORTED_BASE_CURRENCIES)[number],
  ): Promise<BaseCurrencyResponse> {
    const before = await this.getBaseCurrency(actor);

    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await client.query(
          `INSERT INTO tenant_settings (tenant_id, key, value_json, updated_by)
           VALUES ($1, $2, to_jsonb($3::text), $4)
           ON CONFLICT (tenant_id, key)
           DO UPDATE SET value_json = EXCLUDED.value_json,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
          [actor.tenantId, BASE_CURRENCY_KEY, next, actor.userId],
        );
      },
    );

    const after: BaseCurrencyResponse = { base_currency: next };

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'tenant_settings.updated',
      resourceId: BASE_CURRENCY_KEY,
      before,
      after,
    });

    return after;
  }

  // Audit is recorded after the business write commits (separate transaction). A
  // failure here must NOT undo the committed change; we log it so the gap is
  // visible. Append-only chain is enforced in the DB.
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
        resourceType: 'tenant_settings',
        resourceId: params.resourceId,
        before: params.before,
        after: params.after,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} tenant_settings=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}
