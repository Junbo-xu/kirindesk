// Commission status caliber (plan §2.4). Inherited verbatim from the 1F-D
// reports caliber so commission and reports never disagree on "what counts":
// realized = confirmed + completed; cancelled is never commissionable.
export const COMMISSION_CALIBERS = ['realized', 'approved_up', 'pipeline', 'all'] as const;
export type CommissionCaliber = (typeof COMMISSION_CALIBERS)[number];

export const CALIBER_STATUSES: Record<CommissionCaliber, readonly string[]> = {
  realized: ['confirmed', 'completed'],
  approved_up: ['approved', 'confirmed', 'completed'],
  pipeline: ['draft', 'pending_approval', 'rejected'],
  all: ['draft', 'pending_approval', 'approved', 'rejected', 'confirmed', 'completed'],
};

export const DEFAULT_CALIBER: CommissionCaliber = 'realized';

export function caliberStatuses(caliber: CommissionCaliber): readonly string[] {
  return CALIBER_STATUSES[caliber];
}
