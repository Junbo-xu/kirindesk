import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { EMAIL_PROVIDER, EmailProvider } from './email-provider.interface';

export interface NotificationSettings {
  tenantId: string;
  orderEvents: boolean;
  userWelcome: boolean;
  supportAccess: boolean;
}

export type NotificationEvent = 'order_events' | 'user_welcome' | 'support_access';

// Maps event name to the settings column name.
const EVENT_COLUMN: Record<NotificationEvent, keyof NotificationSettings> = {
  order_events: 'orderEvents',
  user_welcome: 'userWelcome',
  support_access: 'supportAccess',
};

/**
 * Notification service (Phase 1N). @Global so any module can inject it without
 * importing NotificationModule. send() is fire-and-forget safe; callers do:
 *   void this.notification.send(...).catch(warn)
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Send an email if the tenant has the given event enabled.
   * Audits notification.sent on success, notification.failed on provider error.
   */
  async send(
    tenantId: string,
    actorId: string,
    event: NotificationEvent,
    to: string,
    subject: string,
    text: string,
  ): Promise<void> {
    const enabled = await this._isEnabled(tenantId, actorId, event);
    if (!enabled) return;

    try {
      await this.emailProvider.send({ to, subject, text });
      await this.auditService.log({
        tenantId,
        actorType: 'tenant_user',
        actorId,
        action: 'notification.sent',
        resourceType: 'notification',
        metadata: { event, to },
      });
    } catch (err) {
      this.logger.warn(
        `Notification send failed for event=${event} tenant=${tenantId}: ${String(err)}`,
      );
      await this.auditService
        .log({
          tenantId,
          actorType: 'tenant_user',
          actorId,
          action: 'notification.failed',
          resourceType: 'notification',
          metadata: { event, to, error: String(err) },
        })
        .catch(() => {});
      throw err;
    }
  }

  async getSettings(tenantId: string, userId: string): Promise<NotificationSettings> {
    return withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<{
          order_events: boolean;
          user_welcome: boolean;
          support_access: boolean;
        }>(
          `SELECT order_events, user_welcome, support_access
             FROM tenant_notification_settings
            WHERE tenant_id = $1`,
          [tenantId],
        );
        const row = rows[0];
        return {
          tenantId,
          orderEvents: row?.order_events ?? true,
          userWelcome: row?.user_welcome ?? true,
          supportAccess: row?.support_access ?? true,
        };
      },
    );
  }

  async updateSettings(
    tenantId: string,
    userId: string,
    patch: Partial<{ orderEvents: boolean; userWelcome: boolean; supportAccess: boolean }>,
  ): Promise<NotificationSettings> {
    await withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        await client.query(
          `INSERT INTO tenant_notification_settings
             (tenant_id, order_events, user_welcome, support_access, updated_at)
           VALUES ($1, COALESCE($2, true), COALESCE($3, true), COALESCE($4, true), now())
           ON CONFLICT (tenant_id) DO UPDATE
             SET order_events   = COALESCE($2, tenant_notification_settings.order_events),
                 user_welcome   = COALESCE($3, tenant_notification_settings.user_welcome),
                 support_access = COALESCE($4, tenant_notification_settings.support_access),
                 updated_at     = now()`,
          [
            tenantId,
            patch.orderEvents ?? null,
            patch.userWelcome ?? null,
            patch.supportAccess ?? null,
          ],
        );
      },
    );
    return this.getSettings(tenantId, userId);
  }

  // Inserts the genesis row for a new tenant. Called by TenantOnboardingService.
  async insertInitialRow(client: import('pg').PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `INSERT INTO tenant_notification_settings (tenant_id, updated_at)
       VALUES ($1, now())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  }

  // Reads the setting for a given event without a full tenant context (uses pool
  // directly, bypassing RLS). Intended only for internal service calls (platform
  // suspend notifications, etc.) where we don't have a full actor context.
  private async _isEnabled(
    tenantId: string,
    actorId: string,
    event: NotificationEvent,
  ): Promise<boolean> {
    const col = EVENT_COLUMN[event];
    const dbCol =
      col === 'orderEvents'
        ? 'order_events'
        : col === 'userWelcome'
          ? 'user_welcome'
          : 'support_access';
    try {
      return await withTenantContext(
        this.pool,
        { tenantId, userId: actorId, actorType: 'tenant_user' },
        async (client) => {
          const { rows } = await client.query<{ val: boolean }>(
            `SELECT ${dbCol} AS val FROM tenant_notification_settings WHERE tenant_id = $1`,
            [tenantId],
          );
          // Default true when no row exists (row provisioned at onboarding but
          // safe to default on for legacy/test tenants with no settings row).
          return rows[0]?.val ?? true;
        },
      );
    } catch {
      return true; // fail-open: if we can't read settings, send anyway
    }
  }
}
