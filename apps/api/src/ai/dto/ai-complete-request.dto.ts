import { IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** Per-call AI overrides. timeoutMs is also clamped provider-side (plan §3.5). */
export class AiOptionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30_000)
  timeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8192)
  maxOutputTokens?: number;
}

/**
 * Body for POST /api/ai/complete. `input` must be already-minimized text, never
 * raw customer files (plan §3.3/§5.6). The length cap bounds what can be sent.
 */
export class AiCompleteRequestDto {
  @IsString()
  @MaxLength(100)
  task!: string;

  @IsString()
  @MaxLength(100_000)
  input!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AiOptionsDto)
  options?: AiOptionsDto;
}
