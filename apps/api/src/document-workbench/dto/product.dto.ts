import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MONEY = /^\d{1,14}(\.\d{1,4})?$/;
const WEIGHT = /^\d{1,14}(\.\d{1,4})?$/;
const VOLUME = /^\d{1,12}(\.\d{1,6})?$/;

export class CreateProductDto {
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

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  hs_code?: string;

  @Transform(trim)
  @Matches(/^[A-Z]{3}$/)
  default_currency!: string;

  @IsString()
  @Matches(MONEY)
  default_unit_price!: string;

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
  @IsUUID()
  thumbnail_file_id?: string;

  @IsOptional()
  @IsObject()
  custom_values?: Record<string, unknown>;
}

export class UpdateProductDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(32)
  hs_code?: string;

  @IsOptional()
  @Transform(trim)
  @Matches(/^[A-Z]{3}$/)
  default_currency?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY)
  default_unit_price?: string;

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
  @IsUUID()
  thumbnail_file_id?: string;

  @IsOptional()
  @IsObject()
  custom_values?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListProductsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class CreateProductFieldDto {
  @Transform(trim)
  @Matches(/^[a-z][a-z0-9_]{1,63}$/)
  field_key!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsIn(['text', 'number', 'boolean', 'date'])
  data_type!: 'text' | 'number' | 'boolean' | 'date';

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsIn(['quote', 'pi', 'sc', 'ci', 'pl'], { each: true })
  document_types?: string[];
}

export class UpdateProductFieldDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsIn(['text', 'number', 'boolean', 'date'])
  data_type?: 'text' | 'number' | 'boolean' | 'date';

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsIn(['quote', 'pi', 'sc', 'ci', 'pl'], { each: true })
  document_types?: string[];
}
