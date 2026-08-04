export const AFTER_SALES_CASE_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'completed',
  'closed',
] as const;

export type AfterSalesCaseStatus = (typeof AFTER_SALES_CASE_STATUSES)[number];

const knownStatuses = new Set<string>(AFTER_SALES_CASE_STATUSES);

export function normalizeAfterSalesCaseStatus(status: string): {
  status: AfterSalesCaseStatus | 'unknown';
  status_diagnostic: {
    code: 'UNKNOWN_AFTER_SALES_STATUS';
    received_status: string;
    message: string;
  } | null;
} {
  if (knownStatuses.has(status)) {
    return { status: status as AfterSalesCaseStatus, status_diagnostic: null };
  }
  return {
    status: 'unknown',
    status_diagnostic: {
      code: 'UNKNOWN_AFTER_SALES_STATUS',
      received_status: status,
      message: `Unsupported after-sales status received: ${status}`,
    },
  };
}
