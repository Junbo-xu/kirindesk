import { IsIn, IsISO8601, IsOptional } from 'class-validator';

// Status calibers (§2.3 of the plan). A caliber maps to the set of order
// statuses that feed the summed amount. `cancelled` is never summed.
export const CALIBERS = ['realized', 'approved_up', 'pipeline', 'all'] as const;
export type Caliber = (typeof CALIBERS)[number];

export const GROUP_BY = ['status', 'customer', 'supplier', 'period'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export const GRANULARITY = ['month', 'day'] as const;
export type Granularity = (typeof GRANULARITY)[number];

// Shared query for both sales-summary and purchase-summary. The `customer`
// vs `supplier` group key is validated per-endpoint in the service (sales
// rejects `supplier`, purchase rejects `customer`).
export class ReportSummaryQuery {
  // Inclusive start of the time range (filters on created_at), date-only.
  @IsISO8601({ strict: false })
  from!: string;

  // Inclusive end of the time range, date-only.
  @IsISO8601({ strict: false })
  to!: string;

  @IsOptional()
  @IsIn(GROUP_BY)
  groupBy?: GroupBy;

  @IsOptional()
  @IsIn(GRANULARITY)
  granularity?: Granularity;

  @IsOptional()
  @IsIn(CALIBERS)
  caliber?: Caliber;
}
