import { IsEmail, IsIn, IsISO8601, IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Scopes a support-access grant may take. Enumerated (not free text) so a new
// scope is an explicit, reviewed add (plan §3.8) — never a config flag. Only
// read_only exists this phase; the DB CHECK mirrors this exact set (037).
export const SUPPORT_ACCESS_SCOPES = ['read_only'] as const;
export type SupportAccessScope = (typeof SUPPORT_ACCESS_SCOPES)[number];

/**
 * Body for POST /api/support-access (plan §3.3). The tenant names a specific
 * platform admin by email; the service resolves it to an id (unknown/inactive
 * → opaque 404, plan §3.3). whitelist + forbidNonWhitelisted reject unknown
 * fields. expiresAt must parse to a future instant — the service re-checks
 * `> now()` and rejects past timestamps with 400.
 */
export class CreateSupportAccessDto {
  @IsEmail()
  platformAdminEmail!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @IsIn(SUPPORT_ACCESS_SCOPES)
  scope!: SupportAccessScope;

  @IsISO8601({ strict: false })
  expiresAt!: string;
}
