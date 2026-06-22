import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Thrown when a user is not visible to the caller: it does not exist, was
 * soft-deleted, or falls outside the caller's data scope. Returns 404 (not 403)
 * for out-of-scope / cross-tenant access so existence is not disclosed
 * (plan §3.5/§4.1 guard 7).
 */
export class UserNotFoundException extends NotFoundException {
  constructor() {
    super('User not found');
  }
}

/** Duplicate email within the tenant (plan §4.1 guard 6). */
export class DuplicateUserEmailException extends ConflictException {
  constructor() {
    super('A user with this email already exists');
  }
}

/** Deactivating/removing the last active tenant owner (plan §4.1 guard 2). */
export class LastOwnerException extends ConflictException {
  constructor() {
    super('Cannot deactivate the last active tenant owner');
  }
}

/** Acting destructively on one's own account (plan §4.1 guard 3). */
export class SelfLockException extends ConflictException {
  constructor() {
    super('You cannot deactivate your own account');
  }
}

/**
 * Assigning a role whose permissions exceed the caller's own permission set or
 * data scope (plan §4.1 guard 1 — no privilege escalation). 403 because the
 * resource is visible; the action is forbidden.
 */
export class PrivilegeEscalationException extends ForbiddenException {
  constructor(detail?: string) {
    super(detail ? `Privilege escalation denied: ${detail}` : 'Privilege escalation denied');
  }
}

/** A referenced role id does not exist in the tenant (plan §3.1 setRoles). */
export class RoleNotFoundException extends NotFoundException {
  constructor() {
    super('Role not found');
  }
}
