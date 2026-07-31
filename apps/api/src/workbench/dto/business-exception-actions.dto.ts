import { IsInt, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class VersionedExceptionActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class AssignBusinessExceptionDto extends VersionedExceptionActionDto {
  @IsUUID('4')
  assigneeUserId!: string;
}

export class ResolveBusinessExceptionDto extends VersionedExceptionActionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  resolution!: string;
}
