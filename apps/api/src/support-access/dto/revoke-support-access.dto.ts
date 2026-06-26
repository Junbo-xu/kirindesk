import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /api/support-access/:id/revoke (plan §3.3). A revoke must carry
 * a reason (mirrors 1K-A's suspend reason requirement); it is stored on the row
 * and audited.
 */
export class RevokeSupportAccessDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
