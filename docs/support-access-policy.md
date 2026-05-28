# Support Access Policy

**Status: DRAFT — Phase 0**

## Purpose

Define rules and procedures for KirinDesk platform personnel accessing tenant business data, ensuring customer trust through transparency and control.

## 1. Default No-Access Principle

Platform administrators and support staff have NO access to tenant business data by default. System-level access (infrastructure, logs, metrics) does not grant visibility into customer business records.

## 2. Support Access Triggers

Access to tenant data is permitted ONLY when:
- The customer explicitly requests support that requires data access
- A confirmed security incident requires investigation
- A legal obligation compels access (with documentation)

## 3. Authorization Flow

Every support access request must follow:
1. **Customer Authorization**: Written consent from an authorized tenant admin
2. **Stated Reason**: Clear description of why access is needed
3. **Defined Scope**: Specific data, modules, or records to be accessed
4. **Time Limit**: Access expires after a defined period (default: 24 hours)
5. **Audit Record**: All actions during access are logged

## 4. Audit Log Requirements

During any support access session:
- Entry time and exit time recorded
- Every data read/write operation logged
- Accessor identity recorded
- Reason and authorization reference linked
- Logs are immutable (append-only)

## 5. Customer Visibility

Customers can:
- View a log of all platform access to their data
- See who accessed, when, why, and what was viewed
- Receive notifications when access occurs (configurable)

## 6. Violation Handling

Unauthorized access to tenant data is treated as a security incident:
- Immediate access revocation
- Internal investigation
- Customer notification
- Disciplinary action

## Phase 0 Constraints

This is a policy framework. Technical enforcement (audit logging, access control UI, customer-visible access records) is not implemented in Phase 0.

## Next Implementation Phases

- Phase 0D: Schema design for audit_logs table
- Phase 1: Basic audit logging infrastructure
- Phase 2: Support access request workflow
- Phase 3: Customer-facing access log viewer
- Future: Automated access expiration, notification system

## Prohibited Claims

This policy does not claim that support access controls are currently enforced technically. Implementation is planned and will be built progressively.
