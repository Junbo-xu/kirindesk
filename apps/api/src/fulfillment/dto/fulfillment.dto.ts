import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
const QUANTITY = /^(?!0+(?:\.0+)?$)\d{1,15}(?:\.\d{1,3})?$/;
const MONEY = /^(?!0+(?:\.0+)?$)\d{1,14}(?:\.\d{1,4})?$/;
const FX_RATE = /^(?!0+(?:\.0+)?$)\d{1,11}(?:\.\d{1,8})?$/;

export class UpdateFulfillmentSettingsDto {
  @IsBoolean()
  require_sales_receipt_confirmation!: boolean;
}

export class CreateGoodsReceiptItemDto {
  @IsUUID()
  purchase_order_item_id!: string;

  @IsString()
  @Matches(QUANTITY)
  received_quantity!: string;
}

export class CreateGoodsReceiptDto {
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  batch_number!: string;

  @IsBoolean()
  is_final_batch!: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateGoodsReceiptItemDto)
  items!: CreateGoodsReceiptItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  file_ids?: string[];

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class InspectGoodsReceiptItemDto {
  @IsUUID()
  item_id!: string;

  @IsString()
  @Matches(/^(?:0|\d{1,15})(?:\.\d{1,3})?$/)
  accepted_quantity!: string;

  @IsString()
  @Matches(/^(?:0|\d{1,15})(?:\.\d{1,3})?$/)
  rejected_quantity!: string;
}

export class InspectGoodsReceiptDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => InspectGoodsReceiptItemDto)
  items!: InspectGoodsReceiptItemDto[];

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ConfirmGoodsReceiptDto {
  @IsIn(['accepted', 'rejected'])
  decision!: 'accepted' | 'rejected';

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class CreateShipmentItemDto {
  @IsUUID()
  sales_order_item_id!: string;

  @IsString()
  @Matches(QUANTITY)
  quantity!: string;
}

export class CreateShipmentDto {
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  batch_number!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(120)
  carrier!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(160)
  tracking_number!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateShipmentItemDto)
  items!: CreateShipmentItemDto[];
}

export class AddLogisticsEventDto {
  @IsIn(['in_transit', 'customs', 'exception'])
  event_type!: 'in_transit' | 'customs' | 'exception';

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsISO8601({ strict: true })
  occurred_at!: string;
}

export class DeliverShipmentDto {
  @IsISO8601({ strict: true })
  delivered_at!: string;

  @IsUUID()
  proof_file_id!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RecordOrderExpenseDto {
  @IsOptional()
  @IsUUID()
  shipment_id?: string;

  @IsIn(['freight', 'insurance', 'customs', 'other'])
  expense_type!: 'freight' | 'insurance' | 'customs' | 'other';

  @IsString()
  @Matches(MONEY)
  amount!: string;

  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency!: 'RMB' | 'USD' | 'HKD' | 'EUR';

  @IsOptional()
  @IsString()
  @Matches(FX_RATE)
  fx_rate_to_rmb?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fx_source?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  fx_captured_at?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CompleteExpenseFxDto {
  @IsString()
  @Matches(FX_RATE)
  fx_rate_to_rmb!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(120)
  fx_source!: string;

  @IsISO8601({ strict: true })
  fx_captured_at!: string;
}

export class LinkShipmentReceiptDto {
  @IsUUID()
  customer_receipt_id!: string;
}
