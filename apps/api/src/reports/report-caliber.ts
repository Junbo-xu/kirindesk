import { Caliber } from './dto/report-summary.query';

// Maps a status caliber to the set of order statuses whose amounts feed the
// summed total (§2.3). `cancelled` is never included in any summed amount.
// The per-status breakdown returned by a report is independent of caliber;
// this mapping only governs which buckets feed the headline/subtotal line.
export const CALIBER_STATUSES: Record<Caliber, readonly string[]> = {
  realized: ['confirmed', 'completed'],
  approved_up: ['approved', 'confirmed', 'completed'],
  pipeline: ['draft', 'pending_approval', 'rejected'],
  all: ['draft', 'pending_approval', 'approved', 'rejected', 'confirmed', 'completed'],
};

export const DEFAULT_CALIBER: Caliber = 'realized';
export const DEFAULT_GROUP_BY = 'status';
export const DEFAULT_GRANULARITY = 'month';

export function caliberStatuses(caliber: Caliber): readonly string[] {
  return CALIBER_STATUSES[caliber];
}
