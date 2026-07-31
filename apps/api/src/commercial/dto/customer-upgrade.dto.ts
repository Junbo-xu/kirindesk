import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpgradeInquiryCustomerDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  company_name!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  contact_name?: string;

  @Transform(trim)
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}

export class LinkInquiryCustomerDto {
  @IsUUID()
  customer_id!: string;
}
