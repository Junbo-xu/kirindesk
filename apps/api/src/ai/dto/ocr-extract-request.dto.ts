import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Per-call OCR overrides. timeoutMs upper bound is also clamped provider-side
 *  (plan §3.5); the Max here rejects absurd values early. */
export class OcrOptionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30_000)
  timeoutMs?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(35, { each: true })
  languages?: string[];
}

/**
 * Body for POST /api/ai/ocr. Takes a tenant-scoped file id, never raw bytes
 * (plan §3.1/§7.5): the file must already be in the Files module.
 */
export class OcrExtractRequestDto {
  @IsUUID()
  fileId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  docType?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OcrOptionsDto)
  options?: OcrOptionsDto;
}
