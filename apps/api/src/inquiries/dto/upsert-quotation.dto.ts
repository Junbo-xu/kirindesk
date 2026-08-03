import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PRICE_PATTERN, QUANTITY_PATTERN } from './create-inquiry.dto';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class QuotationLineInputDto {
  @IsUUID()
  inquiry_item_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  variant_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  variant_value?: string;

  @IsString()
  @Matches(QUANTITY_PATTERN)
  quantity!: string;

  @IsString()
  @Matches(PRICE_PATTERN)
  unit_price!: string;

  @IsOptional()
  @IsString()
  @Matches(QUANTITY_PATTERN)
  minimum_quantity?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  lead_time_days?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  terms?: string;
}

export class UpsertQuotationDto {
  @IsUUID()
  supplier_id!: string;

  @IsInt()
  @Min(0)
  expected_version!: number;

  @IsString()
  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency!: string;

  @IsString()
  @Matches(DATE_PATTERN)
  @IsDateString({ strict: true })
  valid_until!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  source_text?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => QuotationLineInputDto)
  lines!: QuotationLineInputDto[];
}
