import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { COMMISSION_CALIBERS, CommissionCaliber } from '../commission-caliber';

// POST /commission/settlements — lock (settle) a (table, period). (plan §5.3)
export class CreateSettlementDto {
  @IsUUID()
  tableId!: string;

  @IsISO8601({ strict: false })
  from!: string;

  @IsISO8601({ strict: false })
  to!: string;

  @IsOptional()
  @IsIn(COMMISSION_CALIBERS)
  caliber?: CommissionCaliber;
}

// POST /commission/settlements/:id/unlock — reason is required for the audit
// trail (plan §5.3 / §7.1).
export class UnlockSettlementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
