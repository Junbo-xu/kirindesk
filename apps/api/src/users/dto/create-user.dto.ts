import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Body for POST /api/users (plan §3.1). The admin sets an initial password
 * (email-invite flow is deferred — no real mail provider, CLAUDE.md §7).
 * `is_tenant_owner` is intentionally absent: it must never be settable through
 * this endpoint (plan §4.1 guard 9) — the DTO whitelist drops any such input.
 */
export class CreateUserDto {
  @Transform(trim)
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  // Optional initial role assignment; full replace semantics happen via
  // PUT /api/users/:id/roles. Tenant-scoped role ids, validated as UUIDs here.
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  roleIds?: string[];
}
