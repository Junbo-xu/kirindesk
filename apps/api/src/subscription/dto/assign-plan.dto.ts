import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AssignPlanDto {
  @IsString()
  @IsNotEmpty()
  planId!: string;

  @IsOptional()
  @IsString()
  planExpiresAt?: string; // ISO timestamp or null for perpetual
}
