import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Optional metadata supplied alongside a multipart upload. The file bytes
 * arrive via the multipart 'file' part (handled by FileInterceptor), not here.
 */
export class UploadFileDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  purpose?: string;
}
