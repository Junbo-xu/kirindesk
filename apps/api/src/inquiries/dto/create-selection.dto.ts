import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';

const POSITIVE_PRICE = /^(?!0+(?:\.0+)?$)\d{1,14}(?:\.\d{1,4})?$/;
const POSITIVE_FX_RATE = /^(?!0+(?:\.0+)?$)\d{1,10}(?:\.\d{1,8})?$/;

export class CreateSelectionDto {
  @IsUUID()
  quotation_line_id!: string;

  @IsInt()
  @Min(1)
  expected_quotation_version!: number;

  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  sales_currency!: string;

  @IsString()
  @Matches(POSITIVE_PRICE)
  sales_unit_price!: string;

  @IsOptional()
  @IsString()
  @Matches(POSITIVE_FX_RATE)
  purchase_to_sales_fx_rate?: string;
}
