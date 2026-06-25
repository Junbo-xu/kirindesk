import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const TENANT_STATUSES = ['active', 'suspended', 'deactivated'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

// Platform-side tenant list query: pagination + optional status filter.
export class ListTenantsQuery {
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
  @IsIn(TENANT_STATUSES)
  status?: TenantStatus;
}
