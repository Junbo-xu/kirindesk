import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DECIMAL_4 = /^\d{1,12}(?:\.\d{1,4})?$/;
const USCC = /^[0-9A-HJ-NPQRTUWXY]{18}$/;

class CustomsDeclarationDetailsDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  port!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  trade_mode!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  package_type!: string;

  @Transform(trim)
  @Matches(DECIMAL_4)
  gross_weight_kg!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  consignor_name!: string;

  @Transform(trim)
  @Matches(USCC)
  consignor_uscc!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  consignor_contact!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  consignor_phone!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  customs_broker_name!: string;

  @Transform(trim)
  @Matches(USCC)
  customs_broker_uscc!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  customs_broker_contact!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  customs_broker_phone!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((item) => (typeof item === 'string' ? item.trim() : item))
      : value,
  )
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(200, { each: true })
  authorization_matters!: string[];
}

export class CreateCustomsDeclarationDto extends CustomsDeclarationDetailsDto {
  @Transform(trim)
  @Matches(IDEMPOTENCY_KEY)
  idempotency_key!: string;
}

export class RefreshCustomsDeclarationDto extends CustomsDeclarationDetailsDto {
  @Transform(trim)
  @Matches(IDEMPOTENCY_KEY)
  idempotency_key!: string;
}

export class CustomsIdempotencyDto {
  @Transform(trim)
  @Matches(IDEMPOTENCY_KEY)
  idempotency_key!: string;
}
