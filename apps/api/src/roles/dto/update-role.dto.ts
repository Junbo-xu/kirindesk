import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Body for PATCH /api/roles/:id (plan §3.2). Only name/description are editable,
 * and only for custom roles — the service rejects system roles (plan §4.1
 * guard 4). `is_system` is absent by design.
 */
export class UpdateRoleDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;
}
