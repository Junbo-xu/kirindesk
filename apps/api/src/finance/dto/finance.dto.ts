import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
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
const FX_RATE = /^(?!0+(?:\.0+)?$)\d{1,11}(?:\.\d{1,8})?$/;

export class FinanceConversionDto {
  @IsIn(['customer_receipt', 'purchase_cost'])
  subject_type!: 'customer_receipt' | 'purchase_cost';

  @IsUUID()
  subject_id!: string;

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

export class CreateFinanceReviewDto {
  @IsIn(['verified', 'returned'])
  decision!: 'verified' | 'returned';

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FinanceConversionDto)
  conversions!: FinanceConversionDto[];
}

export class CreateProfitSnapshotDto {
  @IsIn(['provisional', 'final'])
  status!: 'provisional' | 'final';
}

export class CommissionRuleDto {
  @IsIn(['sales', 'procurement'])
  role_type!: 'sales' | 'procurement';

  @IsIn(['sales_revenue', 'gross_profit', 'net_profit'])
  basis_type!: 'sales_revenue' | 'gross_profit' | 'net_profit';

  @IsInt()
  @Min(0)
  @Max(100000)
  rate_bps!: number;
}

export class ReplaceCommissionRulesDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => CommissionRuleDto)
  rules!: CommissionRuleDto[];
}

export class CommissionParticipantDto {
  @IsUUID()
  user_id!: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  share_bps!: number;
}

export class CommissionAllocationDto {
  @IsIn(['sales', 'procurement'])
  role_type!: 'sales' | 'procurement';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CommissionParticipantDto)
  participants!: CommissionParticipantDto[];
}

export class CalculateCommissionCandidateDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => CommissionAllocationDto)
  allocations!: CommissionAllocationDto[];

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  revision_reason?: string;
}

export class LockCommissionCandidateDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
