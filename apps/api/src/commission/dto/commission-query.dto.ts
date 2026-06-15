import { IsIn, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { COMMISSION_CALIBERS, CommissionCaliber } from '../commission-caliber';

// Shared query for GET /commission/summary and /commission/orders (plan §5.1).
// The caliber is passed by name so it matches the 1F-D reports caliber exactly.
export class CommissionQuery {
  // Inclusive period start (filters order created_at), date-only.
  @IsISO8601({ strict: false })
  from!: string;

  // Inclusive period end, date-only.
  @IsISO8601({ strict: false })
  to!: string;

  @IsOptional()
  @IsIn(COMMISSION_CALIBERS)
  caliber?: CommissionCaliber;

  // Which commission table's rates to apply; defaults to the tenant's active table.
  @IsOptional()
  @IsUUID()
  tableId?: string;

  // Optional filter to one salesperson (order owner_user_id).
  @IsOptional()
  @IsUUID()
  salespersonId?: string;
}
