import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

// Tenant-side invoice list filters. Amount/currency are never client-supplied;
// these only narrow which invoices are returned.
export class ListInvoicesQuery {
  @IsOptional()
  @IsIn(['pending', 'paid', 'void'])
  status?: 'pending' | 'paid' | 'void';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}
