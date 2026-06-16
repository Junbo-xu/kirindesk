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

- Phase 0: Foundation baseline established — monorepo skeleton, Docker Compose local env (PostgreSQL + Redis), trust & security docs, and the rules/docs for database, tenant isolation, auth, RBAC, RLS, audit, file security, and provider abstraction. Database migrations, dual-JWT auth, RBAC, audit hash-chain, and the quality gate / test infrastructure have landed in code.
- Phase 1A: Customers — table (RLS + indexes), API (CRUD + soft delete + dataScope + audit), and integration tests. Web CRUD pages added later (commit 2a6b4ad). Committed.
- Phase 1B: Sales Orders — table, API, and web CRUD pages. Frontend CRUD browser QA (T01–T13) passed: create / list / filter / search / edit / soft-delete, with 400 / 401 / 404 / 409 verified. Committed (latest commit 54aa2be).
- Phase 1C: Suppliers — table (RLS + indexes), suppliers:* permissions (procurement module), API (CRUD + soft delete + dataScope + audit), web CRUD pages, and integration tests. Integration suite 101 passing; browser QA (create / list / filter / search / edit / soft-delete / nav) and server-side 400 / 401 / 404 verified. Committed (commit 76363c6).
- Phase 1D: Purchase Orders — table (RLS + indexes, supplier_id FK ON DELETE RESTRICT, unique tenant order_number), procurement:delete permission, API (CRUD + soft delete + dataScope + supplier in-scope check + duplicate order_number 409 + audit), web CRUD pages with supplier dropdown, and integration tests. Full quality gate green (lint / format / typecheck / build / unit 7 / integration 129 / security 13); browser QA (create / supplier dropdown / name mapping / search / edit / soft-delete / nav) and server-side 400 / 401 / 404 / 409 verified. Committed (commit 0d9b082).
- Phase 1E: Files (object storage) — S3-compatible storage behind a provider interface (StorageProvider + S3StorageProvider, MinIO for local dev via docker-compose), files API (multipart upload with 25MB + MIME allowlist + server-side sha256, list + getOne + dataScope, single-use short-lived signed download tokens hashed at rest, public token-authenticated download endpoint, soft delete), files:view permission seed, migration 028 (user FKs + app_lookup_file_token SECURITY DEFINER helper for anonymous-download RLS bootstrap), migration 029 (pin SECURITY DEFINER search_path), and integration tests with an in-memory fake storage provider. Full quality gate green (lint / format / typecheck / build / unit 7 / integration 152 / security 13); end-to-end QA against real MinIO (upload → object lands with tenant-prefixed key → list → token download byte-match → token reuse 404 → MIME reject 400 → soft delete → audit chain uploaded/token_issued/downloaded/deleted) verified. Self-review (security/isolation, error-handling/concurrency, audit/provider/secrets) completed; two must-fix items (SECURITY DEFINER search_path, S3 SDK error scrubbing) resolved.

  Known tech debt deferred from Phase 1E (revisit in later phases, not blocking):
  - Tenant status gate on download: a token issued before a tenant is suspended remains usable for its short TTL. Belongs in a global tenant-lifecycle middleware, not the files module.
  - Download token rate limiting: no cap on how many active tokens can be minted per file. Belongs in global rate-limiting middleware.
  - Real-time permission revocation on download: download validates token validity only, not whether the issuer still holds files:download / the file is still in scope at download time. Inherent signed-token trade-off (short TTL + single-use mitigates).
  - Orphan object sweep: a failed metadata insert after a successful storage put attempts a best-effort delete; double-failure leaves an orphan object (logged, no DB row references it). Needs a background reconciliation job (storage vs files table).
  - sha256 de-duplication: identical content uploaded multiple times produces multiple rows/objects; sha256 is computed and stored but not used for dedup. Product decision (cross-user object sharing touches isolation).
  - Audit metadata enrichment: file.downloaded / file.token_issued record actorId + resourceId only; downloader IP/UA and token id are not captured. Audit enhancement pending schema confirmation.

- Phase 1F-A: Order line items — migration 030 (sales_order_items + purchase_order_items detail tables with RLS + indexes + quantity/price/line_total numeric precision checks), backend for both sales and purchase orders (line items written in a single transaction, total_amount derived server-side as Σ line_total and never accepted from the client, line_no assigned server-side, draft allows 0 lines / non-draft requires ≥1, full-array replace semantics on update, audit before/after snapshots include full line-item sets, historical header-only orders still readable/editable), shared BigInt money helper (apps/api/src/common/order-money.ts) reused across both services, and a web line-item editor on both order forms (add/remove rows, per-row line_total + read-only derived total_amount, items[] sent on submit, existing lines echoed on edit). Full quality gate green (lint / format / typecheck / build / unit 15 / integration 154 / security 13); pushed (commits fb31e93 backend, 51e7d08 web). Browser QA still to be done.

- Phase 1F-F: Commission payout / disbursement — migration 034 (commission_payouts batch header + commission_payout_lines, FORCE RLS, partial-unique no-double-pay index on settlement_id WHERE status<>'void', SELECT/INSERT/UPDATE grants with DELETE revoked, freeze-money-columns BEFORE UPDATE triggers on amount_base / total_payout_base), RBAC seed (commission_payouts:view/:disburse/:reverse in the finance group, separate from commission_tables:* for separation of duties), backend module (CommissionPayoutService + controller + DTOs under api/commission: amount-copy from a current-locked settlement, idempotent create, only-locked-payable 409, row-locked open→paid→void / pending→paid→void status machine with no auto-close, void frees the settlement, dataScope-aware reads, audit on every write), and web pages (CommissionPayoutsListPage + CommissionPayoutDetailPage with disburse/reverse actions, generate-or-view from settlement detail, base-currency display, graceful 403). Money is copied not computed (numeric(18,2), no FX). Full quality gate green (lint / format / typecheck / build / unit 7 / integration 235 / security 13); pushed (commits bad183d migration, 6baf4d1 seed, bb8631a backend, b30d5f3 web, 8368e19 integration tests). Browser QA passed (21/21): base-currency display (RMB total + per-line copied amounts), idempotent generate / no-double-pay (same live payout on regenerate, exactly one non-void payout per settlement), batch disburse → paid, freeze-after-paid read-only (no disburse controls + DB triggers reject amount_base / total_payout_base UPDATE), void frees the settlement to regenerate a new payout, and 403 fallback (view-only user blocked from disburse/void, no-finance user blocked from list + detail).

The next planned step is:

Phase 1F (continuation) — planning pending user approval. Candidates: option B finance/exchange-rate, or further governance/reporting work.

The Phase 0 foundation baseline is in place. Phase 1E (Files), Phase 1F-A (order line items), and Phase 1F-F (commission payout / disbursement) are complete. Do not start the next Phase 1F step implementation until its scope is planned and approved.
