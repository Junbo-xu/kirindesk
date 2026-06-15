import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

// POST /commission/payouts — create a payout from a locked settlement (plan §5.1).
// Only `settlementId` (the locked settlement to disburse) and an optional note;
// amounts are never accepted from the client — they are copied server-side from
// the settlement (plan §5.8 / §3 D7).
export class CreatePayoutDto {
  @IsUUID()
  settlementId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// GET /commission/payouts — optional filters (plan §5.2).
export class ListPayoutsQuery {
  @IsOptional()
  @IsUUID()
  settlementId?: string;

  @IsOptional()
  @IsIn(['open', 'paid', 'void'])
  status?: 'open' | 'paid' | 'void';
}

// POST /commission/payouts/:id/pay — mark the batch paid (plan §5.5).
// payoutDate is required (the run's value date); externalRef/note are optional
// bookkeeping references. No amount is accepted here.
export class PayBatchDto {
  @IsISO8601({ strict: false })
  payoutDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  externalRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// POST /commission/payouts/:id/void — reason is required for the audit trail and
// the DB CHECK (plan §5.6 / §7.2).
export class VoidPayoutDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
