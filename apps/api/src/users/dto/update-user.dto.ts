import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Body for PATCH /api/users/:id (plan §3.1). Email and password are not
 * changeable here (password reset is deferred). `is_tenant_owner` is absent by
 * design (plan §4.1 guard 9). Deactivation is expressed via status.
 */
export class UpdateUserDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: string;
}
