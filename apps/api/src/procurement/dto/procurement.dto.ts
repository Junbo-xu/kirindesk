import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const QUANTITY = /^(?!0+(?:\.0+)?$)\d{1,15}(?:\.\d{1,3})?$/;
const MONEY = /^\d{1,14}(?:\.\d{1,4})?$/;

export class ProcurementApprovalStepDto {
  @IsUUID()
  approver_user_id!: string;
}

export class UpdateProcurementApprovalConfigDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ProcurementApprovalStepDto)
  steps!: ProcurementApprovalStepDto[];

  @IsInt()
  @Min(0)
  @Max(100000)
  price_variance_threshold_bps!: number;
}

export class ProcurementRequestItemDto {
  @IsUUID()
  selection_id!: string;

  @IsString()
  @Matches(QUANTITY)
  quantity!: string;
}

export class CreateProcurementRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ProcurementRequestItemDto)
  items!: ProcurementRequestItemDto[];

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class DecideProcurementRequestDto {
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class WithdrawProcurementRequestDto {
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class FinalPurchasePriceDto {
  @IsUUID()
  item_id!: string;

  @IsString()
  @Matches(MONEY)
  final_unit_price!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class PlacePurchaseOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FinalPurchasePriceDto)
  items!: FinalPurchasePriceDto[];
}
