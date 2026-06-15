import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Rate is a numeric(7,4) percent (e.g. "5.0000" = 5%). Validate as a bounded
// non-negative decimal string so it never reaches BigInt math as a float.
const RATE_REGEX = /^\d{1,3}(\.\d{1,4})?$/;

export class CommissionRateRuleInput {
  @IsUUID()
  salespersonId!: string;

  @Matches(RATE_REGEX, { message: 'rate must be a non-negative decimal with up to 4 places' })
  rate!: string;
}

export class CreateCommissionTableDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsOptional()
  @Matches(RATE_REGEX, {
    message: 'defaultRate must be a non-negative decimal with up to 4 places',
  })
  defaultRate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CommissionRateRuleInput)
  rules?: CommissionRateRuleInput[];
}

export class UpdateCommissionTableDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @Matches(RATE_REGEX, {
    message: 'defaultRate must be a non-negative decimal with up to 4 places',
  })
  defaultRate?: string;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
}

export class ReplaceCommissionRulesDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CommissionRateRuleInput)
  rules!: CommissionRateRuleInput[];
}
