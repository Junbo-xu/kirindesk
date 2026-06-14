import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Phase 1F-C approval-workflow DTOs, shared by both the sales and purchase order
// controllers (the approval record is structurally identical on both sides; see
// docs/phase-1f-c-approval-workflow-plan.md §D1).
//
// reason is user free-text, length-bounded (§5.2 recommendation: 1000 chars) and
// stored/rendered as data — never interpolated into SQL or shell.
const REASON_MAX = 1000;

/**
 * Body for POST /:id/approve. reason is optional context for the approval.
 */
export class ApproveOrderDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(REASON_MAX)
  reason?: string;
}

/**
 * Body for POST /:id/reject. reason is REQUIRED so the submitter learns why the
 * order was declined (§5.2). An empty/missing reason is a 400 (DTO validation).
 */
export class RejectOrderDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(REASON_MAX)
  reason!: string;
}

/**
 * Body for POST /:id/withdraw. reason is optional.
 */
export class WithdrawOrderDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(REASON_MAX)
  reason?: string;
}
