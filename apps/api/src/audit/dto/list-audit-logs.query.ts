import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// Actor types as stored in audit_logs.actor_type. This stage reads tenant-scoped
// events only (mostly tenant_user / system), but the filter accepts the full set.
export const ACTOR_TYPES = ['tenant_user', 'platform_admin', 'system'] as const;
export type ActorTypeFilter = (typeof ACTOR_TYPES)[number];

/**
 * List query for the audit-log viewer (plan §3.2). Every filter is pushed into
 * the SQL WHERE as a parameterized predicate — correctness never depends on an
 * index, and there is no free-text search (before/after are jsonb, out of scope).
 */
export class ListAuditLogsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  // Inclusive time range on created_at. Both optional; the controller/service
  // applies a default trailing window when neither is given (plan §3.2/§5.3).
  @IsOptional()
  @IsISO8601({ strict: false })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  to?: string;

  // Any UUID version — seeded / historical actor ids may be non-v4 synthetic
  // UUIDs; locking to '4' would wrongly reject legitimate filter values (1H lesson).
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsIn(ACTOR_TYPES)
  actorType?: ActorTypeFilter;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceType?: string;

  // resource_id is a varchar, not necessarily a UUID — do not lock to UUID.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  requestId?: string;
}
