import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * Thrown when a role is not visible to the caller: it does not exist or belongs
 * to another tenant. Returns 404 (not 403) so existence is not disclosed across
 * tenants (plan §3.5/§4.1 guard 7).
 */
export class RoleNotFoundException extends NotFoundException {
  constructor() {
    super('Role not found');
  }
}

/** Duplicate role name within the tenant (plan §4.1 guard 6). */
export class DuplicateRoleNameException extends ConflictException {
  constructor() {
    super('A role with this name already exists');
  }
}

/**
 * Attempting to edit / delete / re-permission a system role (is_system=true).
 * System roles are read-only (plan §4.1 guard 4).
 */
export class SystemRoleReadOnlyException extends ForbiddenException {
  constructor() {
    super('System roles cannot be modified or deleted');
  }
}

/**
 * Deleting a role still referenced by user_roles (plan §4.1 guard 5). Requires
 * unbinding the role from all users first.
 */
export class RoleInUseException extends ConflictException {
  constructor() {
    super('Role is still assigned to users and cannot be deleted');
  }
}

/** A referenced permission id does not exist (plan §3.2 setPermissions). */
export class PermissionNotFoundException extends NotFoundException {
  constructor() {
    super('Permission not found');
  }
}

/**
 * Granting a permission the caller does not hold, or at a wider data scope than
 * the caller's own (plan §4.1 guard 1 — no privilege escalation). 403 because
 * the resource is visible; the grant is forbidden.
 */
export class PrivilegeEscalationException extends ForbiddenException {
  constructor(detail?: string) {
    super(detail ? `Privilege escalation denied: ${detail}` : 'Privilege escalation denied');
  }
}
