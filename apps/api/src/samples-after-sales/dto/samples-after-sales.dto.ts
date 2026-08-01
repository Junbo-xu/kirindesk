import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MONEY = /^(?!0+(?:\.0+)?$)\d{1,16}(?:\.\d{1,2})?$/;
const NON_NEGATIVE_MONEY = /^\d{1,16}(?:\.\d{1,2})?$/;
const QUANTITY = /^(?!0+(?:\.0+)?$)\d{1,15}(?:\.\d{1,3})?$/;
const FX_RATE = /^(?!0+(?:\.0+)?$)\d{1,11}(?:\.\d{1,8})?$/;

export class CreateSampleItemDto {
  @IsUUID()
  selection_id!: string;

  @IsString()
  @Matches(QUANTITY)
  quantity!: string;
}

export class CreateSampleOrderDto {
  @IsUUID()
  inquiry_id!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(120)
  recipient_name!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(60)
  recipient_phone!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  recipient_address!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(100)
  recipient_country!: string;

  @IsString()
  @Matches(NON_NEGATIVE_MONEY)
  shipping_fee!: string;

  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  shipping_currency!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateSampleItemDto)
  items!: CreateSampleItemDto[];
}

export class DecideDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class DispatchSampleDto {
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  carrier!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(120)
  tracking_number!: string;

  @IsISO8601({ strict: true })
  dispatched_at!: string;
}

export class DeliverSampleDto {
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  received_by!: string;

  @IsISO8601({ strict: true })
  delivered_at!: string;
}

export class ConfirmSampleDto {
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  feedback!: string;
}

export class CloseDto {
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class ConvertSampleItemDto {
  @IsUUID()
  sample_item_id!: string;

  @IsString()
  @Matches(QUANTITY)
  quantity!: string;
}

export class ConvertSampleOrderDto {
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  payment_terms!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConvertSampleItemDto)
  items!: ConvertSampleItemDto[];
}

export class ApprovalStepDto {
  @IsUUID()
  approver_user_id!: string;
}

export class ReplaceAfterSalesApprovalConfigDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ApprovalStepDto)
  steps!: ApprovalStepDto[];
}

export class CreateAfterSalesCaseDto {
  @IsOptional()
  @IsUUID()
  shipment_id?: string;

  @IsIn(['refund', 'compensation'])
  case_type!: 'refund' | 'compensation';

  @IsIn(['supplier', 'logistics', 'company', 'customer', 'undetermined'])
  responsibility!: 'supplier' | 'logistics' | 'company' | 'customer' | 'undetermined';

  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  reason!: string;

  @IsString()
  @Matches(MONEY)
  requested_amount!: string;

  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency!: string;

  @IsOptional()
  @IsUUID()
  proof_file_id?: string;
}

export class ExecuteAfterSalesDto {
  @IsString()
  @Matches(MONEY)
  amount!: string;

  @IsString()
  @Matches(FX_RATE)
  fx_rate_to_rmb!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(120)
  fx_source!: string;

  @IsISO8601({ strict: true })
  fx_captured_at!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(160)
  external_reference!: string;

  @IsOptional()
  @IsUUID()
  proof_file_id?: string;
}
