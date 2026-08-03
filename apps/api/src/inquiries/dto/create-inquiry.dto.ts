import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const QUANTITY_PATTERN = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,3})?$/;
export const PRICE_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;

export class InquiryItemInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  specifications?: string;

  @IsString()
  @Matches(QUANTITY_PATTERN)
  quantity!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;

  @IsOptional()
  @IsString()
  @Matches(PRICE_PATTERN)
  target_price_usd?: string;
}

export class CreateInquiryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  customer_code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  customer_country!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  customer_message!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => InquiryItemInputDto)
  items!: InquiryItemInputDto[];
}
