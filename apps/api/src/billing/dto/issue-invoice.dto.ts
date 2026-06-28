import { IsIn, IsOptional } from 'class-validator';

// Platform-side: issue an invoice for a tenant's current plan. The billing
// period selects which plan price (monthly vs yearly) is charged; defaults to
// 'monthly'. Amount and currency are derived server-side from the plan — never
// accepted from the client.
export class IssueInvoiceDto {
  @IsOptional()
  @IsIn(['monthly', 'yearly'])
  billingPeriod?: 'monthly' | 'yearly';
}
