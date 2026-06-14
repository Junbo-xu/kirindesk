import { ConflictException, ForbiddenException } from '@nestjs/common';

// Phase 1F-C order approval workflow — shared state machine + guards, used by
// both the sales and purchase order services. See
// docs/phase-1f-c-approval-workflow-plan.md §2 / §5.4 / §7.2.

// The four approval transition actions (also the order_approvals.action values).
export type ApprovalAction = 'submit' | 'approve' | 'reject' | 'withdraw';

// Legal (fromStatus -> toStatus) per action. Any (action, fromStatus) pair not
// listed here is an illegal transition -> 409. Note the new states are reachable
// ONLY through these actions; the normal create/update path keeps the original
// four states (§4.3).
const TRANSITIONS: Record<ApprovalAction, { from: string; to: string }> = {
  submit: { from: 'draft', to: 'pending_approval' },
  approve: { from: 'pending_approval', to: 'approved' },
  reject: { from: 'pending_approval', to: 'rejected' },
  withdraw: { from: 'pending_approval', to: 'draft' },
};

/**
 * Thrown when an approval action is not legal from the order's current status
 * (e.g. approve on a draft, submit on an approved). The request is well-formed
 * but conflicts with current server state, so 409 — matching the duplicate
 * order_number convention from Phase 1D. 400 is reserved for malformed input.
 */
export class IllegalApprovalTransitionException extends ConflictException {
  constructor(action: ApprovalAction, currentStatus: string) {
    super(`Order is not in a state that allows '${action}' (current: ${currentStatus})`);
  }
}

/**
 * Thrown when an approve/reject is attempted with an own-scoped (not all-scoped)
 * orders:approve grant. An own-scoped approver could only ever approve their own
 * orders — exactly the self-approval the workflow prevents — so all-scope is
 * required (§D3).
 */
export class ApprovalScopeException extends ForbiddenException {
  constructor() {
    super('Approval requires all-scope permission');
  }
}

/**
 * Thrown when the approver is the same user who submitted the order. Separation
 * of duties is enforced independently of the permission/scope check, since one
 * user may legitimately hold both update and approve (§7.2).
 */
export class SelfApprovalException extends ForbiddenException {
  constructor() {
    super('Approver cannot be the submitter of the order');
  }
}

/**
 * Resolves the target status for an action given the current status, or throws
 * IllegalApprovalTransitionException (409) if the transition is not legal.
 */
export function assertTransition(action: ApprovalAction, currentStatus: string): string {
  const t = TRANSITIONS[action];
  if (!t || t.from !== currentStatus) {
    throw new IllegalApprovalTransitionException(action, currentStatus);
  }
  return t.to;
}
