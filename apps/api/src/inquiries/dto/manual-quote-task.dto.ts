import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { QUANTITY_PATTERN } from './create-inquiry.dto';

export class SanitizedInquiryItemDto {
  @IsUUID()
  inquiry_item_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  specifications?: string | null;

  @IsString()
  @Matches(QUANTITY_PATTERN)
  quantity!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  unit!: string;
}

export class ManualQuoteTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  summary!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SanitizedInquiryItemDto)
  items!: SanitizedInquiryItemDto[];
}
