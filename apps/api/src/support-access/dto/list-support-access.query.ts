import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

// Grant statuses as stored in support_access_grants.status (037 CHECK). The
// tenant list may filter by any of them; validity is still DERIVED (active +
// not-expired), but the raw status filter is exposed for the management view.
export const GRANT_STATUSES = ['pending', 'active', 'revoked', 'expired'] as const;
export type GrantStatusFilter = (typeof GRANT_STATUSES)[number];

/** Query for GET /api/support-access (plan §3.3): pagination + optional status. */
export class ListSupportAccessQuery {
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

  @IsOptional()
  @IsIn(GRANT_STATUSES)
  status?: GrantStatusFilter;
}
