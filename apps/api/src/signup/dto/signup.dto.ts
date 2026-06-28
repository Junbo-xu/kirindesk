import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Phase 2B: anonymous self-service registration payload.
 * Email is validated for FORMAT only here; uniqueness is enforced by the DB
 * (tenants.slug UNIQUE, users(tenant_id,email) UNIQUE) and surfaced as 409.
 * No email-verification step in this phase (per approved scope).
 */
export class SignupDto {
  @IsString()
  @MaxLength(200)
  tenantName!: string;

  // URL-safe slug: lowercase alphanum + hyphens, must start/end with alphanum.
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'slug 只允许小写字母、数字和连字符，且不能以连字符开头或结尾',
  })
  slug!: string;

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  ownerPassword!: string;

  @IsString()
  @MaxLength(100)
  ownerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;
}
