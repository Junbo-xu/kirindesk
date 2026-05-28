# KirinDesk Working Principles

## 1. Phase-Based Execution

KirinDesk must be developed phase by phase.

Do not make large, cross-cutting changes without approval.

Before any code change, always provide:

- implementation scope
- files to be added or modified
- database changes
- risks
- rollback plan
- validation commands
- acceptance criteria

Do not proceed until the user confirms.

## 2. Karpathy-Style Working Principles

Follow a simple, incremental, evidence-driven engineering style.

Core rules:

- Make the simplest thing work first.
- Prefer boring, explicit, debuggable solutions over clever abstractions.
- Avoid premature architecture unless the next phase clearly needs it.
- Build in small steps.
- Verify each step with commands, tests, logs, or direct inspection.
- Keep the system understandable to a small team.
- Do not hide complexity behind vague "magic".
- Do not claim something works unless it has been verified.
- Prefer readable code and clear data flow over over-engineered patterns.
- When uncertain, inspect the current files and state before editing.
- When a test fails, explain the cause before changing more code.
- Never fix unrelated problems silently.
- Never widen the scope without explicit approval.

## 3. Safety and Trust First

KirinDesk handles sensitive business data, including customers, orders, suppliers, pricing, profit, commission, files, and internal workflows.

The product must be designed around customer trust.

Rules:

- Customer data belongs to the customer.
- KirinDesk must not use customer business data for its own sales, resale, customer poaching, or public AI training.
- Platform admins must not have unrestricted default access to tenant business data.
- Future support access must require customer authorization, reason, scope, time limit, and audit logs.
- Sensitive actions must be server-side controlled, not only hidden in the UI.
- File access, downloads, exports, permission changes, and platform access must be auditable.
- Do not use exaggerated claims such as "absolute security", "bank-level security", "military-grade security", or "ISO/SOC certified" unless actually certified.

Preferred external wording:

- controllable
- auditable
- exportable
- removable
- private-deployment-ready
- built with mature security principles over time

## 4. SaaS Architecture Rules

KirinDesk must be designed as a multi-tenant SaaS from day one.

Rules:

- LETPCBA is only the first tenant. Never hardcode LETPCBA into system logic.
- All tenant business tables must include tenant_id.
- Tenant isolation must be enforced at both application and database design levels.
- PostgreSQL RLS must be planned before implementing tenant business tables.
- RBAC, data scope, and field-level response filtering are required.
- Role-based UI hiding is not enough; backend DTO/API responses must not leak fields.
- Platform admin identity must be separated from tenant user identity.

## 5. Database and Migration Rules

Before creating or changing database schema:

- provide table list
- explain tenant_id usage
- explain RLS strategy
- explain indexes
- explain soft delete strategy
- explain audit requirements
- explain rollback strategy

Do not create migrations without explicit confirmation.

Do not use production credentials.

Do not run destructive database commands unless explicitly approved.

## 6. Audit and Compliance Rules

KirinDesk must support append-only audit logs with hash-chain design in later phases.

Sensitive operations must be designed to be auditable, including:

- login
- permission changes
- user changes
- tenant changes
- file upload
- file download
- export
- support access
- approval
- lock/unlock
- business data changes
- AI/OCR calls

Audit logs must not be editable or deletable by normal application logic.

## 7. Provider Abstraction Rules

AI, OCR, Payment, Storage, and Commission logic must use provider interfaces.

Do not hardcode vendors.

Phase 0 may only use mock providers or interface placeholders.

Do not connect real DeepSeek, OpenAI, WeChat Pay, Alipay, Stripe, OCR services, cloud storage, or email services without approval.

## 8. Local Development Rules

Development starts locally.

Do not deploy to a public server unless explicitly approved.

Do not kill unrelated processes.

Do not run killall node.

If a port is occupied, report the conflict and suggest options.

Do not delete .claude/.

Do not commit .env, node_modules, dist, logs, private storage files, or real secrets.

## 9. Reporting Rules

After each phase or sub-phase, report:

- files added
- files modified
- files deleted
- commands executed
- test results
- what passed
- what failed
- whether database schema changed
- whether any secrets were created
- whether any risk remains
- recommended next step

If something failed, report the exact failure and propose the smallest safe fix.

## 10. Current Phase Rule

The current completed execution scope is:

- Phase 0A: Monorepo project skeleton
- Phase 0B: Docker Compose local environment with PostgreSQL and Redis
- Phase 0C-Trust: Trust & Security documentation framework

The next planned step is:

Phase 0D — Database Foundation Plan

Do not jump to Phase 1 until Phase 0 database, tenant, auth, RBAC, RLS, audit, file security, provider abstraction, and trust foundations are planned and approved.
