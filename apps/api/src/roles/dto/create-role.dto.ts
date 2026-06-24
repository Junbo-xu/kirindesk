import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Body for POST /api/roles (plan §3.2). Creates a custom role; `is_system` is
 * intentionally absent — it must never be settable through the API (plan §4.1
 * guard 4), so the DTO whitelist drops any such input and the service forces
 * is_system=false.
 */
export class CreateRoleDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}
