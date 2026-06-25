import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

// suspend / deactivate require a reason (recorded on the tenant row + audited).
export class TenantReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

// activate may carry an optional note; reason is cleared from the row on activate.
export class ActivateTenantDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
