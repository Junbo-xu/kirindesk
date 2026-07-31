import { IsInt, IsUUID, Min } from 'class-validator';

export class CreateSelectionDto {
  @IsUUID()
  quotation_line_id!: string;

  @IsInt()
  @Min(1)
  expected_quotation_version!: number;
}
