import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationSettingsDto {
  @IsBoolean()
  @IsOptional()
  orderEvents?: boolean;

  @IsBoolean()
  @IsOptional()
  userWelcome?: boolean;

  @IsBoolean()
  @IsOptional()
  supportAccess?: boolean;
}
