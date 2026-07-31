import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateProformaInvoiceDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  selection_ids!: string[];

  @IsString()
  @MaxLength(2000)
  payment_terms!: string;
}

export class ReviseProformaInvoiceDto {
  @IsString()
  @MaxLength(2000)
  payment_terms!: string;
}

export class ApproveLowMarginDto {
  @IsString()
  @MaxLength(1000)
  reason!: string;
}
