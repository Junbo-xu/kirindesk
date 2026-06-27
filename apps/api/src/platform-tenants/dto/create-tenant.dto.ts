import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

// Plan §3.2. Used by POST /api/platform/tenants (PlatformAuthGuard).
export class CreateTenantDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  // URL-safe: lowercase alphanum + hyphens; must start and end with alphanum.
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
  ownerPassword!: string;

  @IsString()
  @MaxLength(100)
  ownerName!: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string;
}
