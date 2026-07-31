import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateCommercialSettingsDto {
  @IsInt()
  @Min(-100000)
  @Max(10000)
  minimum_margin_bps!: number;

  @IsBoolean()
  procurement_gate_enabled!: boolean;

  @IsInt()
  @Min(0)
  @Max(10000)
  required_receipt_ratio_bps!: number;

  @IsBoolean()
  receipt_proof_required!: boolean;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bypass_reason?: string;
}
