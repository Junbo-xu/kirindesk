import { IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignPlanDto {
  @IsUUID()
  planId!: string;

  @IsOptional()
  @IsString()
  planExpiresAt?: string; // ISO timestamp or null for perpetual
}
