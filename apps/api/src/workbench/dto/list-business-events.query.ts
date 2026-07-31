import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListBusinessEventsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  chainType?: string;

  @IsOptional()
  @IsUUID('4')
  chainId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
