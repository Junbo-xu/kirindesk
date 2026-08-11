import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsHexColor,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const QUANTITY = /^\d{1,15}(\.\d{1,3})?$/;
const MONEY = /^\d{1,14}(\.\d{1,4})?$/;
const MONEY_2 = /^\d{1,16}(\.\d{1,2})?$/;
const RATE = /^(?!0+(\.0+)?$)\d{1,10}(\.\d{1,10})?$/;
const WEIGHT = /^\d{1,14}(\.\d{1,4})?$/;
const VOLUME = /^\d{1,12}(\.\d{1,6})?$/;

export class DocumentLineInputDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsString()
  @Matches(QUANTITY)
  quantity!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  @IsString()
  @Matches(MONEY)
  unit_price!: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY)
  cost_unit_price?: string;

  @IsOptional()
  @IsString()
  @Matches(WEIGHT)
  weight_kg?: string;

  @IsOptional()
  @IsString()
  @Matches(VOLUME)
  volume_cbm?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  package_no?: string;

  @IsOptional()
  @IsUUID()
  thumbnail_file_id?: string;

  @IsOptional()
  @IsObject()
  custom_values?: Record<string, unknown>;
}

export class CreateDocumentSetDto {
  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  sales_order_id?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  quote_number!: string;

  @IsOptional()
  @IsIn(['final_price', 'cost_profit'])
  pricing_mode?: 'final_price' | 'cost_profit';

  @IsOptional()
  @IsIn(['zh', 'en', 'ru', 'es', 'de', 'ar'])
  language?: 'zh' | 'en' | 'ru' | 'es' | 'de' | 'ar';

  @IsOptional()
  @IsIn(['FOB', 'CIF', 'EXW'])
  incoterm?: 'FOB' | 'CIF' | 'EXW';

  @Transform(trim)
  @Matches(/^[A-Z]{3}$/)
  pricing_currency!: string;

  @Transform(trim)
  @Matches(/^[A-Z]{3}$/)
  settlement_currency!: string;

  @IsString()
  @Matches(RATE)
  exchange_rate!: string;

  @IsOptional()
  @IsIn(['none', 'percent', 'amount'])
  discount_type?: 'none' | 'percent' | 'amount';

  @IsOptional()
  @IsString()
  @Matches(MONEY)
  discount_value?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_2)
  freight_amount?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_2)
  insurance_amount?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_2)
  tax_amount?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY_2)
  internal_expenses?: string;

  @IsOptional()
  @IsIn(['equal', 'value', 'weight', 'volume'])
  allocation_method?: 'equal' | 'value' | 'weight' | 'volume';

  @IsOptional()
  @IsIn(['normal', 'combined'])
  packing_mode?: 'normal' | 'combined';

  @IsOptional()
  @IsHexColor()
  theme_color?: string;

  @IsOptional()
  @IsObject()
  visible_fields?: Record<string, boolean>;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  terms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  bank_info?: string;

  @IsOptional()
  @IsUUID()
  logo_file_id?: string;

  @IsOptional()
  @IsUUID()
  signature_file_id?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DocumentLineInputDto)
  lines!: DocumentLineInputDto[];
}

export class UpdateDocumentSetDto extends CreateDocumentSetDto {
  @IsInt()
  @Min(1)
  expected_version!: number;
}

export class ConvertDocumentSetToSalesOrderDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  order_number!: string;

  @IsUUID()
  idempotency_key!: string;
}

export class ListDocumentSetsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsIn(['draft', 'locked'])
  status?: 'draft' | 'locked';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class CreateShareLinkDto {
  @IsUUID()
  export_id!: string;
}
