import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const POSITIVE_AMOUNT = /^(?!0+(?:\.0+)?$)\d{1,16}(?:\.\d{1,2})?$/;

export class RecordCustomerReceiptDto {
  @IsString()
  @Matches(POSITIVE_AMOUNT)
  amount!: string;

  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency!: string;

  @IsDateString({ strict: true })
  received_at!: string;

  @IsIn(['bank_transfer', 'cash', 'card_external', 'other_external'])
  method!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  external_reference!: string;

  @IsOptional()
  @IsUUID()
  proof_file_id?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ReviewCustomerReceiptDto {
  @IsIn(['confirmed', 'rejected'])
  decision!: 'confirmed' | 'rejected';

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
