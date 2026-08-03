import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

const EXCEPTION_TYPES = [
  'price_variance',
  'quantity_variance',
  'quality_variance',
  'missing_expense',
  'duplicate_customer',
] as const;
const EXCEPTION_STATUSES = ['open', 'assigned', 'in_progress', 'resolved', 'closed'] as const;

export class ListBusinessExceptionsQuery {
  @IsOptional()
  @IsIn(EXCEPTION_TYPES)
  type?: (typeof EXCEPTION_TYPES)[number];

  @IsOptional()
  @IsIn(EXCEPTION_STATUSES)
  status?: (typeof EXCEPTION_STATUSES)[number];

  @IsOptional()
  @IsUUID('4')
  assigneeUserId?: string;

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
}
