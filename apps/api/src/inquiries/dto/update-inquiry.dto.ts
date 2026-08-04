import { IsInt, IsOptional, Min } from 'class-validator';
import { CreateInquiryDto } from './create-inquiry.dto';

export class UpdateInquiryDto extends CreateInquiryDto {
  @IsInt()
  @Min(1)
  expected_version!: number;
}

export class SubmitInquiryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  expected_version?: number;
}
