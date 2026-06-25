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

- Phase 1F-B: Finance / exchange-rate snapshot — orders capture a base-currency cost view via an FX rate snapshot at order time so downstream reporting and commission can sum in the tenant base currency. Each order derives total_amount_base from the captured rate (NULL when un-costed, never silently zeroed); the BigInt money helper (apps/api/src/common/order-money.ts) is shared across sales and purchase order services. Pushed (commit 2559076 backend).

- Phase 1F-C: Order approval workflow — migration 032 (order_approvals shared immutable ledger with an order_type discriminator, no hard FK, RLS + tenant_isolation, SELECT/INSERT-only grant, level column reserved for multi-level; both order status CHECKs widened to the new superset, down migration coerces straggler states before restoring). Shared state machine (common/order-approval.ts) with submit/approve/reject/withdraw transitions: assertTransition → 409 on illegal, ApprovalScope guard (403, all-scope required), SelfApproval guard (403, approver ≠ submitter); reject requires a reason. Each transition runs in one tenant-context tx (SELECT … FOR UPDATE, validate, UPDATE status, INSERT ledger row, audit after commit), wired into both sales and purchase order controllers. Pushed (commit f564687 backend).

- Phase 1F-D: Reports aggregation — read-only sales/purchase summary reports over existing orders + FX base currency, on-demand SQL aggregation (no migration, no materialized view). GET /api/reports/sales-summary and /purchase-summary gated by reports:view; SUM(total_amount_base) in tenant base currency with NULL-base (un-costed) rows excluded from the sum and surfaced as a separate count; status calibers (realized / approved_up / pipeline / all, cancelled never summed); groupBy status/customer/supplier/period at month/day granularity; dataScope pushed into the aggregation WHERE before GROUP BY (own-scoped callers can never aggregate another user's rows), tenant isolation via RLS. Web /reports page with side switch, date range (default trailing 6 months), groupBy/granularity/caliber controls, totals row + un-costed count + active caliber/base currency, graceful 403 notice, nav link + route (export deferred). Pushed (commits cabeb1e backend, a7e6180 web; 784b34d plan doc).

- Phase 1F-E: Commission calculation — migration 033 (commission_tables + commission_rate_rules mutable rate model; commission_settlements + commission_settlement_lines immutable append-only lock snapshot; RLS tenant isolation on all four, settlement pair granted SELECT,INSERT with UPDATE/DELETE revoked, reversible up/down verified). Backend commission module: GET /api/commission/summary + /orders compute commission on the 1F-D realized caliber (confirmed+completed) over frozen total_amount_base with per-salesperson rollup + per-order detail and dataScope pushed before aggregation; rate resolution rule → default_rate → 0-with-flag (rateSource: rule|default|none); POST /settlements snapshots rates + figures (immutable, append-only, idempotent re-lock, unlock as superseding append with required reason, editing a locked table → 409, all under SELECT … FOR UPDATE); money math in BigInt integer cents (commission-money.ts, zero float, serialized as numeric(18,2) decimal strings); RBAC commission_tables:view/:lock/:unlock; writes audited (created/updated/rules.replaced/locked/unlocked), reads not. Web commission pages added. Full quality gate green (integration 219, security 13/13); pushed (commits 16235b7 migration, 0493a3c backend, 1f07645 web, 6e43567 docs).

- Phase 1F-F: Commission payout / disbursement — migration 034 (commission_payouts batch header + commission_payout_lines, FORCE RLS, partial-unique no-double-pay index on settlement_id WHERE status<>'void', SELECT/INSERT/UPDATE grants with DELETE revoked, freeze-money-columns BEFORE UPDATE triggers on amount_base / total_payout_base), RBAC seed (commission_payouts:view/:disburse/:reverse in the finance group, separate from commission_tables:* for separation of duties), backend module (CommissionPayoutService + controller + DTOs under api/commission: amount-copy from a current-locked settlement, idempotent create, only-locked-payable 409, row-locked open→paid→void / pending→paid→void status machine with no auto-close, void frees the settlement, dataScope-aware reads, audit on every write), and web pages (CommissionPayoutsListPage + CommissionPayoutDetailPage with disburse/reverse actions, generate-or-view from settlement detail, base-currency display, graceful 403). Money is copied not computed (numeric(18,2), no FX). Full quality gate green (lint / format / typecheck / build / unit 7 / integration 235 / security 13); pushed (commits bad183d migration, 6baf4d1 seed, bb8631a backend, b30d5f3 web, 8368e19 integration tests). Browser QA passed (21/21): base-currency display (RMB total + per-line copied amounts), idempotent generate / no-double-pay (same live payout on regenerate, exactly one non-void payout per settlement), batch disburse → paid, freeze-after-paid read-only (no disburse controls + DB triggers reject amount_base / total_payout_base UPDATE), void frees the settlement to regenerate a new payout, and 403 fallback (view-only user blocked from disburse/void, no-finance user blocked from list + detail).

- Phase 1G: AI/OCR provider abstraction — backend + web complete. Plan in docs/phase-1g-ai-ocr-plan.md (backend) and docs/phase-1g-web-plan.md (web). Mock-only by design (CLAUDE.md §7: no real DeepSeek/OpenAI/OCR vendor wired). Migration 035 reuses the existing provider_invocations table (no new business table): adds nullable source_file_id (FK → files ON DELETE SET NULL, so deleting a file never cascades away the invocation record) and revokes UPDATE/DELETE on provider_invocations (append-only, like audit_logs); up/down/up reversibility verified. OCR + AI provider interfaces (OcrProvider / AiProvider) behind DI tokens (OCR_PROVIDER / AI_PROVIDER); deterministic MockOcrProvider / MockAiProvider (no network, no SDK, no API key, injectable delay for the timeout path + __force_error__ sentinel for the error path); vendor-neutral errors (Ocr/AiProviderException, Ocr/AiTimeoutException, FileNotInScopeException). Provider factory reads AI_OCR_PROVIDER, accepts only `mock`, and fails fast at startup on any other value (no silent fallback to a real vendor). AiService double-writes on success AND failure/timeout: one provider_invocations row (summaries only — fileId/docType in, fieldCount/confidence/textLength out; AI records inputLength, never the input text) plus one audit_logs event (provider.ocr|ai.invoked / .failed, resource_type=provider_invocation, resourceId links the two), provider error re-thrown after recording. AiController (api/ai) under TenantAuthGuard + PermissionGuard: POST /ocr (ocr:process), GET /ocr + /ocr/:id (ocr:view), POST /complete (ai:process), GET /complete + /complete/:id (ai:view); fileId scope-checked before the provider call, dataScope pushed into list/getOne (own sees only own; out-of-scope/cross-tenant → opaque 404); no update/delete routes (append-only). RBAC seed: module ai (id …008) + ocr:view/:process + ai:view/:process (Dev Admin auto-binds via FROM permissions p). Full quality gate green (unit incl. 31 ai unit tests, integration 256 incl. 21 ai integration tests covering mock success/error paths, 401/403 RBAC, dataScope + cross-tenant isolation, and the double-write with no-raw-text / no-input-leak assertions, security 13/13); pushed (commits b79db39 migration, f0627e9 OCR provider, 2ad4b07 AI provider, 794e37f factory/module, bd6238c service, eb1a238 controller, 94b6140 seed, 6feb6be integration tests).

  Web (Phase 1G continuation): two pages under apps/web/src/ai/ — OcrPage (`/ai/ocr`: file-id + docType form → POST /api/ai/ocr, deterministic field table + text snippet + confidence; below it a paginated invocation list + page-local getOne detail) and CompletePage (`/ai/complete`: task + input → POST /api/ai/complete, output panel + list + detail). Six api-client methods (ocrExtract/listOcr/getOcr/aiComplete/listAiCompletions/getAiCompletion) over the existing request<T>() wrapper; types in lib/types.ts mirror the backend summary shape (no tenant_id/request_json/response_json). Routes added to App.tsx; two nav links in AppLayout. Nav uses the app's established always-show + server-403 graceful-degradation convention (not permission-gated hiding — /api/auth/me carries no permission codes, and UI hiding is not a security boundary per §4); a no-perm user lands on the page and the list region renders a 没有权限 notice. Live OCR text / AI output are held only in React state (never persisted by the backend, and the frontend never writes them to localStorage/sessionStorage/URL or console). Pure-frontend change: no migration, no backend edit, no new dependency. Pushed (commits f196642 api-client+types, b996124 OcrPage, 0f5eebb CompletePage, 29347b2 routes+nav).

  Browser QA: this dev environment has no headless browser (Playwright/Puppeteer absent), so DOM rendering was not script-driven. Instead both dev servers were started for real (API on :3001 with all six /api/ai/* routes mapped; web on :3000 proxying /api → :3001) and the exact endpoints the pages call were exercised through the Vite proxy, covering the pages' full data path. Verified: file upload → in-scope fileId; OCR invoice success (MOCK-INV-0001 / amount 1000.00, [[MOCK OCR]] text, confidence 0.95); list + getOne return summary only (no text/fields); non-uuid → 400, unknown/out-of-scope fileId → 404, __force_error__ → 500; AI extract-order-fields success (deterministic JSON, tokensUsed null); all four no-perm routes → 403 (both list regions hit the forbidden branch). DB checks: provider_invocations holds three rows (ocr success / ocr error / ai success) with summaries only — request_json {fileId,docType} / {task,inputLength:14}, response_json {confidence,fieldCount,textLength} / {outputLength,tokensUsed}; audit_logs has the matching provider.ocr.invoked / provider.ocr.failed / provider.ai.invoked events (success AND failure both recorded); a raw-text leak scan for MOCK OCR / minimized text / MOCK CUSTOMER returned 0 rows; dev-tenant audit hash-chain verify-chain PASS (202 entries). Known limitation: the §6.2 step-9 in-browser DevTools privacy check (localStorage/console/URL inspection) needs a human browser and was not run here — but two automation-level proofs stand in for it: (1) the DB stores no raw OCR/AI content, and (2) a grep of OcrPage.tsx/CompletePage.tsx finds zero console.*, zero localStorage/sessionStorage, and zero URL/history writes, so the live results never escape React state.

- Phase 1H: Tenant RBAC role/user management — backend + web + browser QA complete. Plan in docs/phase-1h-rbac-role-editor-plan.md. Zero migration (reuses existing users / roles / user_roles / role_permissions tables + the permissions/modules dictionary, all already FORCE-RLS tenant-isolated); no new permission codes (lands the already-seeded users:view/create/update + roles:view/create/update under the system module). Backend users module (commit f0d2aa0): @Controller('api/users') under TenantAuthGuard + PermissionGuard — list (page/q/status, dataScope narrowed) / getOne (+ roles) / create (bcrypt initial password, optional roleIds) / update (name/phone/status) / PUT :id/roles (full-replace) / DELETE (soft-delete). Backend roles module (commit 473801e): @Controller('api/roles') — list (+ permission/user counts) / getOne (+ permission grants) / create / update / DELETE, PUT :id/permissions (full-replace grants), plus read-only @Controller('api/permissions') catalog grouped by module for the matrix. Server-side guards (CLAUDE.md §4, never UI-only): subset/no-privilege-escalation (caller can only grant codes it holds, at a data_scope ⊆ its own — via RbacService.listEffectivePermissions + scopeWithin), last-active-owner protection (409), self-lock protection (409), system-role read-only (is_system → 403), delete-blocked-while-referenced (409), duplicate email/name (409), is_tenant_owner never settable via DTO whitelist, cross-tenant → opaque 404 by RLS. Every write audited (user.created/updated/deactivated/roles_replaced, role.created/updated/deleted/permissions_replaced) — identifiers + diffs only, never passwords. Full quality gate green (integration 256, security 13/13). Web (commit 59ed4ba): apps/web/src/users/ (UsersListPage — list + search/status filter + enable/disable toggle via PATCH status; UserFormPage — create with initial password + role-assignment checkboxes, edit name/phone/status, email immutable) and apps/web/src/roles/ (RolesListPage — counts + system-role read-only 查看/disabled 删除; RolePermissionsPage — name/description + permission matrix grouped by module with per-grant data_scope dropdown, system roles render read-only), wired into App.tsx routes + AppLayout nav (用户 / 角色), api-client + lib/types extended; graceful-403 degradation on list surfaces; all server-side guards surface as mapped 403/409 notices. Pure-frontend, no new dep. Browser QA (Playwright + real Chromium, both dev servers live on :3001/:5173 through the Vite proxy, 7 screenshots): login → users list (3 rows, status/owner/actions) → roles list (system roles read-only) → create custom role via permission matrix (46 perms grouped by module, scope dropdowns appear on check) → role round-trips on reopen (2 checked) → create user assigning the new role → user appears in list on search → user's role round-trips on edit. All steps passed. Note: the seeded dev roles use synthetic non-v4 UUIDs that the pre-existing CreateUserDto @IsUUID('4') rejects (400) — a dev-fixture artifact only; API-created roles get real v4 UUIDs, so the QA created a fresh role first and assigned that.

The next planned step is:

Phase 1I / next module — revisit Phase 1F governance/reporting candidates (e.g. audit-log viewer, exports) or the next business module. Planning pending user approval. The only deferred earlier item is the Phase 1G human-browser DevTools privacy spot-check; all automated evidence passed.

The Phase 0 foundation baseline is in place. Phase 1E (Files), Phase 1F-A (order line items), Phase 1F-B (finance/exchange-rate snapshot), Phase 1F-C (order approval workflow), Phase 1F-D (reports aggregation), Phase 1F-E (commission calculation), Phase 1F-F (commission payout / disbursement), Phase 1G (AI/OCR provider abstraction — backend + web), and Phase 1H (tenant RBAC role/user management — backend + web + browser QA) are complete. Do not start the next step implementation until its scope is planned and approved.
