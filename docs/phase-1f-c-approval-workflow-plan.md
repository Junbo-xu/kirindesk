# Phase 1F-C — Order Approval Workflow (Planning)

> Status: **Planning only.** No migration, no code, no commit until this plan is
> reviewed and approved. Mirrors the structure of
> `phase-1f-b-finance-exchange-rate-plan.md`.
>
> Builds on completed work: orders + line items (1F-A), FX snapshot / base-currency
> derivation (1F-B). Reuses the already-seeded but currently-unused `orders:approve`
> and `procurement:approve` permission bits.

---

## 1. Goals & Scope

### Problem

Today an order's `status` is a free transition driven entirely by whoever holds
`orders:update` / `procurement:update`. Any editor can move an order from `draft`
to `confirmed` in a single PATCH, with no second pair of eyes and no record of
*who approved* versus *who drafted*. For orders that carry financial commitment
(a frozen FX snapshot, a contractual total), the business needs a controlled
gate: a submitter prepares the order, a distinct approver signs off, and the
transition is attributable and tamper-evident.

The `orders:approve` and `procurement:approve` permissions were seeded in
`db/seeds/002_permissions.sql` precisely for this, but nothing consumes them yet.
This phase makes them real.

### In scope (this phase)

- An explicit **approval state machine** layered onto the existing order `status`
  column (sales + purchase, symmetric), introducing `pending_approval`,
  `approved`, and `rejected` as governed transitions.
- **Submit for approval** action (submitter side) and **approve / reject** actions
  (approver side), gated by `orders:approve` / `procurement:approve`.
- **Separation of duties**: the user who submits an order for approval cannot be
  the same user who approves it (recommendation; see D-decisions).
- **Edit lock** while an order is `pending_approval` or `approved` — controlled
  fields become read-only so the approved artifact cannot silently change.
- **Audit hash-chain** entries for every approval transition (submit / approve /
  reject), attributable to the actor, reusing the existing append-only chain.
- Web UI affordances: submit button, approver action panel, status display, and
  permission-reactive controls (consistent with the 1F-B settings page pattern).

### Out of scope (deferred)

- Multi-level / N-step approval chains (manager → director → finance). This phase
  targets **single-level** approval (confirmed). The `order_approvals` table
  carries a `level` column (default `1`) so multi-level can be added later without
  a breaking migration, but no chain engine is built now.
- Configurable approval rules / thresholds (e.g. "orders over X require approval").
  This phase: approval is a manual workflow available on demand, not a
  policy-triggered gate.
- Delegation, out-of-office reassignment, escalation timers, notifications/email.
- Parallel approvers / quorum ("any 2 of 3").
- Approval of entities other than orders (e.g. commission tables have their own
  lock/unlock permissions already).

### Open questions (to resolve before exit)

- Placeholder — consolidated in §10 once the D-decisions below are confirmed.

---

## 2. State Machine Design

### 2.1 Relationship to the existing `status` enum

The current order `status` is `varchar(32)` with
`CHECK (status IN ('draft','confirmed','completed','cancelled'))` on both
`sales_orders` and `purchase_orders`. The approval states must slot into this
**single existing column** rather than introduce a parallel status field, to
avoid two sources of truth.

**Decision (confirmed): approval is inserted *between* `draft` and `confirmed`.**
The existing `confirmed → completed → cancelled` lifecycle is preserved
unchanged; approval is a new gate in front of `confirmed`, not a replacement for
it. Extended enum (CHECK constraint widened in the migration):

```
draft → pending_approval → approved → confirmed → completed
   ↑                    ↘ rejected ──┘ (back to draft)
   │                                   
draft ──────────────────────────────→ cancelled
pending_approval ─(withdraw)→ draft
approved ───────────────────────────→ cancelled   (forward-only; no reverse)
```

- `draft` — work in progress; freely editable (unchanged from today).
- `pending_approval` — **new.** Submitted, awaiting an approver; edit-locked.
- `approved` — **new.** Signed off; edit-locked. A distinct state that sits
  *before* `confirmed` — it does **not** replace `confirmed`. An approved order
  may then proceed to `confirmed` (the existing "ready to act on" state) via the
  normal `orders:update` path.
- `rejected` — **new.** Approver declined; the order returns to `draft` for the
  submitter to revise and re-submit (no direct `rejected → pending_approval`;
  always round-trips through `draft` so the edit lock is cleanly released).
- `confirmed` / `completed` / `cancelled` — **unchanged** from today, including
  their existing transitions. Pre-existing orders already in these states are
  unaffected by the migration (see §10 risks).

**Irreversibility (confirmed):** `approved` is forward-only. There is no
`approved → draft` or `approved → pending_approval`. To undo an approved order,
the only path is `approved → cancelled` (an explicit, audited cancel), then a new
order if needed. This keeps an approved financial artifact immutable in place.

### 2.2 Transitions and who can trigger them

| From | To | Action | Required permission | Notes |
|------|----|--------|---------------------|-------|
| `draft` | `pending_approval` | Submit | `orders:update` (owner/editor) | Must have ≥1 line item (reuse 1F-A non-draft rule); FX snapshot frozen at submit if resolvable |
| `pending_approval` | `approved` | Approve | `orders:approve` (**`all` scope**) | Approver ≠ submitter (separation of duties) |
| `pending_approval` | `rejected` | Reject | `orders:approve` (**`all` scope**) | Reason captured; approver ≠ submitter |
| `pending_approval` | `draft` | Withdraw | `orders:update` (submitter) | **Confirmed allowed.** Submitter recalls before any decision; releases the edit lock |
| `rejected` | `draft` | Reopen / revise | `orders:update` | Back to editable; re-submit starts a new approval row |
| `approved` | `confirmed` | Confirm | `orders:update` | Existing lifecycle step, unchanged |
| `confirmed` | `completed` | Complete | `orders:update` | Unchanged from today |
| `draft` / `approved` / `confirmed` | `cancelled` | Cancel | `orders:update` | **Confirmed:** `approved` is undone only via cancel (forward-only). A `pending_approval` order must be **withdrawn first**, then cancelled — no direct `pending_approval → cancelled` |

Purchase side is symmetric, substituting `procurement:update` / `procurement:approve`.

Illegal transitions (e.g. `draft → approved` directly, `approved → draft`,
`approved → pending_approval`, `pending_approval → cancelled`) must be rejected at
the service layer with `409 Conflict`, not silently allowed.

### 2.3 Edit lock semantics

While `pending_approval` or `approved`, the controlled fields of the order header
+ line items are read-only: `currency`, `items[]` (and therefore the derived
`total_amount`), and the FX snapshot (`fx_rate`, `total_amount_base`, etc.). These
are the fields that define the financial artifact being signed off. Non-controlled
metadata (e.g. `notes`) **remains editable** so an approver/owner can annotate
without breaking the lock. The lock is enforced **server-side** (the authority);
the web form reflects it but is not the gate. The lock is released by leaving the
locked states: `pending_approval → draft` (withdraw) or `rejected → draft`
(reopen). `approved` is forward-only, so an approved order's controlled fields stay
locked for its entire remaining life — the only exit is `cancelled`.

---

## 3. Core Design Decisions

### D1. Approval record: dedicated table vs. reuse audit log

**Options:**
- (a) Reuse only the audit hash-chain — every submit/approve/reject is an
  `audit_logs` row; no new table.
- (b) A dedicated `order_approvals` table (one row per approval decision, with
  order FK, actor, decision, reason, timestamp), *plus* audit entries.

**Decision (confirmed): (b) dedicated table + audit.** The audit chain is
append-only, tamper-evident *history* — excellent for "prove who did what," poor
for "efficiently query the current/last approval decision for this order" or to
support a future multi-level chain. A first-class `order_approvals` table gives
queryable, indexable workflow state and a natural home for `decision`, `reason`,
`approver_user_id`, and `level`. The audit log still records each transition for
integrity. This mirrors 1F-B's stance of using purpose-built storage (the
`exchange_rates` table) rather than overloading a generic store.

**Decision (confirmed): one shared `order_approvals` table** with an
`order_type` discriminator (`'sales' | 'purchase'`) + `order_id`, rather than two
tables. Rationale: an approval row is a thin, structurally identical workflow
record on both sides (same columns, same lifecycle); a single table avoids
duplicated DDL, indexes, RLS policies, and service logic, and makes a future
"my pending approvals" query trivial across both order types. The trade-off — the
rest of the codebase keeps sales/purchase fully separate — is accepted here
because, unlike orders/items (which differ in columns and FKs), the approval
record genuinely does not. The FK cannot be a single SQL `REFERENCES` across two
parent tables; integrity to the parent order is enforced in the service layer
(the row is only ever written inside the order's tenant-context transaction) plus
the `(order_type, order_id)` shape. See §4.1 for the column list and the
no-hard-FK note.

### D2. Single-level vs. multi-level approval

**Decision (confirmed): single-level this phase; schema reserves `level` for
multi-level later.** One `pending_approval → approved/rejected` decision by one
approver. The `order_approvals` table carries a `level smallint NOT NULL DEFAULT 1`
column and does **not** assume exactly one row per order, so a future phase can
add sequential steps (level 2, 3, …) without a breaking migration. Building a
configurable multi-step engine now would violate the "minimum step, avoid scope
creep" gate and isn't justified by current requirements. The active-decision query
becomes "latest row for `(order_type, order_id)` at the max level."

### D3. `orders:approve` permission granularity

**Decision (confirmed): reuse the existing `orders:approve` /
`procurement:approve` bits, and require an `all` data_scope to approve.** No new
permission codes.

- **Approve/reject** checks `orders:approve` (sales) or `procurement:approve`
  (purchase). Additionally, **the grant must be `all`-scoped**: an `own`-scoped
  approve grant is rejected for the approval action. Rationale: an `own`-scoped
  approver could only ever approve orders they own — which is exactly the
  self-approval the workflow exists to prevent. Requiring `all` scope means an
  approver is, by construction, someone trusted across the tenant's orders, and it
  structurally blocks "approve my own scope" self-elevation. This reuses the
  existing `data_scope` machinery rather than inventing a new scope.
- **Separation of duties** (approver `user_id` ≠ submitter `user_id`) is enforced
  in the service layer *in addition to* the scope rule, since a single user may
  legitimately hold both `update` and `approve` and the scope check alone does not
  prevent a tenant with one all-scoped admin from self-approving. Both guards
  apply; see §7.2.
- **Submit-for-approval** stays under `orders:update` / `procurement:update` — no
  dedicated submit permission. Submitting is an editor action; approving is the
  privileged one.

> **Note on single-admin tenants:** the combination of "approver ≠ submitter" and
> "approve needs `all` scope" means a tenant with exactly one user cannot both
> draft and approve. This is intentional (separation of duties is the point) but
> must be called out in onboarding. See §10 risks.

---

## 4. Data Model

### 4.1 Table inventory — `order_approvals`

One shared table (D1) recording every approval *decision event* across both order
types. Append-mostly: a new row per submit/approve/reject/withdraw transition, so
the table doubles as a per-order workflow history while the order's own `status`
column remains the single source of truth for current state.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | `uuid` | no | PK, `DEFAULT uuid_generate_v4()` |
| `tenant_id` | `uuid` | no | `REFERENCES tenants(id)`; RLS key |
| `order_type` | `varchar(16)` | no | `CHECK (order_type IN ('sales','purchase'))` — D1 discriminator |
| `order_id` | `uuid` | no | The sales/purchase order. **No SQL FK** (cannot reference two parent tables); integrity enforced in service layer — see note below |
| `level` | `smallint` | no | `DEFAULT 1`, `CHECK (level >= 1)` — D2 multi-level reservation |
| `action` | `varchar(20)` | no | `CHECK (action IN ('submit','approve','reject','withdraw'))` — the transition this row records |
| `from_status` | `varchar(32)` | no | Order status before the transition (snapshot for audit/history) |
| `to_status` | `varchar(32)` | no | Order status after the transition |
| `actor_user_id` | `uuid` | no | `REFERENCES users(id)`; who performed the action (submitter for `submit`/`withdraw`, approver for `approve`/`reject`) |
| `reason` | `text` | yes | Required for `reject` (enforced in service), optional otherwise |
| `created_at` | `timestamptz` | no | `DEFAULT now()` — decision timestamp; the table is immutable so there is no `updated_at` |

**No hard FK to the order (by design, D1).** A column cannot `REFERENCES` two
different parent tables, and we rejected splitting into two tables. Referential
integrity to the parent order is guaranteed instead by: (1) rows are only ever
inserted inside the order's own tenant-context transaction, immediately after the
order's `status` UPDATE in the same service call; (2) `tenant_id` + RLS scope both
to the same tenant; (3) orders are **soft-deleted** (`deleted_at`), never hard
-deleted, so an `order_id` never dangles. **[待确认]** whether to add a
deferred-validation trigger asserting the `(order_type, order_id)` row exists —
recommendation: **no** for this phase (service-layer guarantee + soft-delete is
sufficient; a cross-table trigger adds complexity for a case the transaction
already prevents).

### 4.2 Soft delete

`order_approvals` is an **immutable audit-style ledger**: rows are never updated
or deleted, so it has **no `deleted_at` column**. When an order is soft-deleted,
its approval rows are retained (history must survive the order's soft delete, same
as audit). **[待确认]** confirm we do not need to filter approval history by the
parent order's `deleted_at` in any read path — recommendation: approval history is
only read in the context of a specific (already-loaded) order, so the parent's
visibility check already applies.

### 4.3 Widened `status` CHECK on the order tables

Migration alters the existing `CHECK` on **both** `sales_orders` and
`purchase_orders` (drop + re-add, mirroring how 031 added FX constraints):

```
-- before: CHECK (status IN ('draft','confirmed','completed','cancelled'))
-- after:  CHECK (status IN ('draft','pending_approval','approved',
--                           'rejected','confirmed','completed','cancelled'))
```

Existing rows (all in the old four states) remain valid — the new set is a
superset, so the migration is non-destructive and needs no data backfill. The
`DEFAULT 'draft'` is unchanged. The DTO `@IsIn([...])` lists widen to match, but
**clients may not set the approval states directly via the normal create/update
path** — those states are reachable only through the dedicated transition
endpoints (§5), so the create/update DTO keeps accepting only
`draft`/`confirmed`/`completed`/`cancelled`. **[待确认]** exact DTO split:
recommendation is create/update DTO stays on the original four; the transition
endpoints own the four new states.

### 4.4 Precision & money discipline

No new money columns are introduced; approval does not alter `total_amount`,
`total_amount_base`, or the FX snapshot (those are frozen at submit per §2.2 and
locked per §2.3). The 1F-A/1F-B money discipline is therefore inherited unchanged.
The only new numeric column is `level` (`smallint`), which is a workflow ordinal,
not money.

### 4.5 `tenant_id` usage

`order_approvals.tenant_id` is mandatory and set from the request actor's tenant
(never from client input), consistent with every other business table. All reads
and writes go through `withTenantContext`, so `app_current_tenant_id()` is set and
RLS applies. The `(order_type, order_id)` pair is only ever resolved *within* a
tenant, so there is no cross-tenant order lookup risk.

### 4.6 RLS strategy

Standard tenant-isolation policy, identical to the 030/031 pattern — no
table-specific policy logic:

```sql
ALTER TABLE order_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON order_approvals
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON order_approvals TO kirindesk_app;
```

**Note:** the grant is `SELECT, INSERT` only — **no `UPDATE`/`DELETE`** — enforcing
the immutable-ledger property at the privilege level (defence in depth beyond
"the service never updates it"). **[待确认]** confirm app role needs no DELETE even
for test teardown (integration tests run as the migration/superuser role and can
truncate directly, so this is fine).

### 4.7 Indexes

- `idx_order_approvals_tenant_id` on `(tenant_id)` — RLS/scan baseline, matches the
  convention on every table.
- `idx_order_approvals_order` on `(tenant_id, order_type, order_id, level DESC, created_at DESC)`
  — the workhorse: "latest decision for this order (at the top level)" and the
  full per-order history both read off this index.
- **[待确认]** an index supporting a future "all pending approvals for this tenant"
  inbox view (`(tenant_id, to_status)` partial on `to_status = 'pending_approval'`).
  Recommendation: **defer** — the inbox query is not built this phase (no
  cross-order list endpoint in §5); add it with the feature that needs it rather
  than speculatively.

---

## 5. API Design

All transition endpoints live **under the existing order controllers**
(`apps/api/src/sales-orders`, `apps/api/src/purchase-orders`) — symmetric on both
sides — rather than a new controller, so the approval action sits next to the
order it mutates and reuses the same `TenantAuthGuard` + `PermissionGuard` wiring.
Each is a dedicated sub-resource action (not a generic `PATCH status`), which makes
the permission requirement, the legal from-states, and the audit action
unambiguous per endpoint.

### 5.1 Endpoints (sales; purchase is identical with `/purchase-orders` + `procurement:*`)

| Method & path | Action | Permission | Legal from → to | Body |
|---------------|--------|-----------|-----------------|------|
| `POST /api/sales-orders/:id/submit` | Submit for approval | `orders:update` | `draft` → `pending_approval` | none |
| `POST /api/sales-orders/:id/approve` | Approve | `orders:approve` (**`all` scope**) | `pending_approval` → `approved` | optional `{ reason? }` |
| `POST /api/sales-orders/:id/reject` | Reject | `orders:approve` (**`all` scope**) | `pending_approval` → `rejected` | **required** `{ reason }` |
| `POST /api/sales-orders/:id/withdraw` | Withdraw | `orders:update` | `pending_approval` → `draft` | optional `{ reason? }` |

Notes:
- `reopen` (`rejected → draft`), `confirm` (`approved → confirmed`), `complete`,
  and `cancel` are **existing-lifecycle** transitions driven through the current
  update path, not new approval endpoints — the approval feature only owns
  submit/approve/reject/withdraw. **[待确认]** whether `rejected → draft` reopen
  should be an explicit endpoint or just a normal status update; recommendation:
  normal update path (it carries no approval semantics — it just unlocks for
  editing), but it must still be a *legal* transition in the status guard.
- Each endpoint performs, in one `withTenantContext` transaction: load order (row
  lock via `SELECT ... FOR UPDATE` to avoid concurrent double-approve), validate
  the transition + guards, UPDATE the order `status`, INSERT the `order_approvals`
  row, then emit the audit entry (§7). The FX-freeze-at-submit behaviour (§2.2)
  runs inside the `submit` transaction.

### 5.2 Request DTOs

- `ApproveOrderDto` — `{ reason?: string }` (`@IsOptional`, `@MaxLength`).
- `RejectOrderDto` — `{ reason: string }` (`@IsNotEmpty`, `@MaxLength`). Reason is
  mandatory on reject so the submitter learns why. **[待确认]** max length —
  recommendation 1000 chars, matching the audit `reason` field conventions.
- `WithdrawOrderDto` — `{ reason?: string }`.
- `submit` takes no body.

### 5.3 Response shape

Each endpoint returns the **updated order** in the same response shape as
`getOne` (status now reflecting the transition), plus the just-created approval
record nested, e.g. `{ ...orderResponse, approval: { id, action, from_status,
to_status, actor_user_id, reason, created_at, level } }`. **[待确认]** whether to
nest `approval` or return only the order and require a separate history fetch;
recommendation: nest the single just-created record (cheap, avoids a round trip),
and defer a `GET /:id/approvals` history endpoint to §6/later unless the UI needs
it.

### 5.4 Transition validation & error codes

A single `assertTransition(from, action)` helper (shared by both services) maps the
state machine in §2.2 to outcomes:

| Condition | HTTP | Body `message` |
|-----------|------|----------------|
| Action not legal from current status (e.g. `approve` on a `draft`) | `409 Conflict` | `Order is not in a state that allows '<action>' (current: <status>)` |
| Caller lacks the required permission | `403` | standard `PermissionGuard` denial (also audited as `rbac:permission_denied`) |
| Approve/reject but grant is `own`-scoped, not `all` | `403 Forbidden` | `Approval requires all-scope permission` |
| Approver `user_id` == submitter `user_id` (separation of duties) | `403 Forbidden` | `Approver cannot be the submitter of the order` |
| `reject` with empty/missing `reason` | `400 Bad Request` | DTO validation message |
| Order not found / not in tenant / soft-deleted | `404 Not Found` | `Order not found` |
| Concurrent transition lost the row lock race (status changed under us) | `409 Conflict` | same as illegal-transition (re-checked after `FOR UPDATE`) |

Rationale for `409` (not `400`) on illegal transitions: the request is
well-formed; it conflicts with current server state — the order moved, or the
caller's view is stale. `400` is reserved for malformed input (bad DTO). This
matches the existing duplicate-`order_number` `409` convention from Phase 1D.

---

## 6. Web / Frontend

The order form (sales + purchase, symmetric) gains approval-aware affordances. The
server remains the authority for every transition and the edit lock (§2.3); the UI
only *reflects* state and offers the actions the current order status allows.

### 6.1 Status badge

A status badge on both the list and detail/edit pages renders the order `status`,
extended for the new states: `draft` / `待审批 (pending_approval)` /
`已批准 (approved)` / `已驳回 (rejected)` / plus the existing
`confirmed`/`completed`/`cancelled`. The list page (already showing `status`) needs
no structural change beyond the new labels. **[待确认]** exact zh-CN labels —
recommendation: `草稿 / 待审批 / 已批准 / 已驳回 / 已确认 / 已完成 / 已取消`,
matching the existing Chinese UI convention.

### 6.2 Action controls (state- and permission-reactive)

The form shows only the actions legal from the current status, and only those the
user's permissions allow:

- **`draft`** → a **提交审批 (Submit)** button (needs `orders:update`, which an
  editor already has to reach the form). Disabled with a hint when the order has
  zero line items (mirrors the 1F-A non-draft rule client-side; server still
  enforces).
- **`pending_approval`** → an **approver action panel** with **批准 (Approve)** and
  **驳回 (Reject)** buttons (reject opens a required-reason textarea), plus a
  **撤回 (Withdraw)** button for the submitter. The submitter's own view shows
  Withdraw; an approver's view shows Approve/Reject.
- **`approved` / `confirmed` / etc.** → no approval actions; the existing
  confirm/complete/cancel controls continue via the normal update path.

### 6.3 Permission-reactive rendering (1F-B fallback pattern)

Since `MeResponse` still exposes no permission list (per the 1F-B finding), the UI
follows the **same graceful-403 fallback** the settings page uses rather than
introducing client-side permission gating:

- The Approve/Reject panel is rendered for anyone viewing a `pending_approval`
  order; if the user lacks `orders:approve` / `all` scope, the action returns 403
  and the UI surfaces `没有权限审批此订单` and disables the buttons.
- This avoids building a client permission cache now. **[待确认]** whether to
  instead extend `/api/auth/me` to return the caller's permission codes so the UI
  can pre-hide approver controls (cleaner UX, but a cross-cutting change touching
  auth). Recommendation: **defer** — keep the reactive-403 fallback for 1F-C; track
  the `/me` permissions enhancement as its own item, exactly as 1F-B concluded.

### 6.4 Edit-lock reflection

When the order is `pending_approval` or `approved`, the form's controlled fields
(currency, line items, FX inputs) render **read-only/disabled**, reflecting the
server lock (§2.3); `notes` stays editable. The form derives the lock purely from
`status`, so no extra API data is needed. Submitting the disabled form is
impossible client-side, and the server rejects it regardless.

### 6.5 Approval history (optional)

If §5.3's nested `approval` record is shown, the detail page can render the latest
decision (who/when/reason). **[待确认]** whether to show full history now —
recommendation: show only the latest decision inline this phase; a full
`GET /:id/approvals` history view is deferred unless requested.

---

## 7. Audit & Security

### 7.1 Audit requirements

Every approval transition is written to the existing append-only audit hash-chain
(via `AuditService.log`), **in addition to** the `order_approvals` row (D1). The
audit entry is the tamper-evident proof; the table is the queryable workflow state.

- **Action naming** — follows the existing `<resource>.<verb>` convention
  (`sales_order.created`, etc.). New actions, per side:
  - `sales_order.submitted`, `sales_order.approved`, `sales_order.rejected`,
    `sales_order.withdrawn`
  - `purchase_order.submitted`, `purchase_order.approved`,
    `purchase_order.rejected`, `purchase_order.withdrawn`
  **[待确认]** verb set — recommendation: the four above, mirroring the four
  transition endpoints (§5.1).
- **`resource_type`** — `sales_order` / `purchase_order` (the order is the
  audited resource, not the approval row), `resource_id` = order id. Rationale:
  auditors reason about "what happened to this order," and it keeps the chain
  consistent with the existing create/update/delete entries on the same order.
- **`before` / `after` snapshots** — `before` = `{ status: <from_status> }`,
  `after` = `{ status: <to_status>, approval: { action, actor_user_id, reason,
  level } }`. The order's financial fields are unchanged by approve/reject/withdraw
  (frozen at submit), so the snapshot focuses on the status + decision metadata
  rather than the full order body. For `submit`, since the FX snapshot may be
  frozen in the same transaction, the `after` also includes the resulting
  `fx_rate` / `total_amount_base` (or nulls). **[待确认]** snapshot granularity —
  recommendation: status + decision metadata (+ FX on submit), not the full order
  object, to keep the chain readable.
- **Chain integrity** — entries are emitted *after* the business UPDATE+INSERT
  commit, via the same `safeAudit` wrapper the order services already use (audit
  failure logs an error but does not roll back the committed transition). The
  per-tenant chain (`tenant:<id>`) must still `verifyChain` green after a run of
  approvals (asserted in tests, §8).

### 7.2 Security

- **Separation of duties** — enforced server-side in the approve/reject path:
  load the order's most recent `submit` approval row, compare its `actor_user_id`
  to the current approver; equal → `403` (§5.4). This is independent of, and
  additional to, the permission/scope check.
- **`all`-scope requirement for approve** — the approve/reject service path
  rejects an `own`-scoped `orders:approve` grant (§D3), structurally preventing an
  approver from being limited to (and thus self-approving) their own orders. The
  scope is read from the same RBAC resolution the `PermissionGuard` already
  performs. **[待确认]** mechanism — recommendation: have the guard/service expose
  the resolved `data_scope` for the matched permission so the service can assert
  `=== 'all'`, rather than a second DB lookup.
- **Tenant isolation** — `order_approvals` carries `tenant_id` + RLS (§4.6); all
  reads/writes run inside `withTenantContext`. The order is re-loaded and
  tenant-checked inside the same transaction before any status change, so a
  cross-tenant `:id` yields `404`.
- **Concurrency / idempotency** — the transition transaction takes
  `SELECT ... FOR UPDATE` on the order row, then re-checks the from-state after
  acquiring the lock; two concurrent approves serialize and the second sees a
  non-`pending_approval` status → `409`. There is no separate idempotency key;
  the state machine itself makes a repeated approve a no-legal-transition `409`.
- **Reason handling** — `reason` is user free-text; it is stored and rendered as
  data (escaped by the React layer), never interpolated into SQL (parameterized)
  or shell. Length-bounded by the DTO (§5.2).

---

## 8. Testing & Quality Gate

### 8.1 Coverage to add

Integration tests (the project's primary tier, real DB + RLS) added for **both**
sales and purchase sides, mirroring the existing order test files. The
`test/fixtures.ts` seed gains an `all`-scoped approver user and an `own`-scoped
non-approver to exercise the gates (extending the pattern already used for the
1F-B `tenant_settings` viewer).

- **State-machine matrix** — every legal transition succeeds and lands the
  expected `status` + `order_approvals` row:
  - `draft → submit → pending_approval` (and FX freeze on submit when resolvable)
  - `pending_approval → approve → approved`
  - `pending_approval → reject → rejected` (reason persisted)
  - `pending_approval → withdraw → draft`
  - `rejected → draft` reopen via update path
- **Illegal transitions → 409** — a representative set: `approve` on a `draft`,
  `submit` on an `approved`, `withdraw` on an `approved`, `approve` on an already
  `approved`/`rejected` order, direct `pending_approval → cancelled`,
  `approved → draft`.
- **Submit guard** — `submit` on a `draft` with zero line items → blocked
  (reuse/extend the 1F-A non-draft rule).
- **Permission gates** — `submit`/`approve`/`reject`/`withdraw` with **no token →
  401**; with a tenant token lacking the action's permission → **403**.
- **`all`-scope rule** — an `own`-scoped `orders:approve` grant → `approve` returns
  **403** (`Approval requires all-scope permission`).
- **Separation of duties** — the submitter (even with an `all`-scoped approve
  grant) approving their own order → **403**; a different approver succeeds.
- **Edit lock** — updating controlled fields (items/currency/FX) on a
  `pending_approval` or `approved` order → rejected server-side; `notes` update
  succeeds.
- **Audit + chain** — after a submit→approve sequence, the expected
  `*.submitted` / `*.approved` audit rows exist with correct `resource_type` /
  `resource_id` / actor, and `verifyChain('tenant:<id>')` returns ok.
- **Cross-tenant isolation** — tenant A cannot submit/approve/withdraw tenant B's
  order (`404`); `order_approvals` rows never leak across tenants.
- **Concurrency** — **[待确认]** whether to add a concurrent double-approve test
  (two transactions racing the `FOR UPDATE`). Recommendation: include a
  best-effort serialized test asserting the second attempt gets `409`; skip if it
  proves flaky in CI.

### 8.2 Quality gate

The full gate must stay green before commit, per `docs/quality-gate.md` and the
1F-A/1F-B precedent: `pnpm verify` = lint / format / typecheck / build / unit /
integration / security, with the integration count rising by the new approval
tests. Prettier/eslint auto-fixes applied inline. Web `typecheck` run separately
(the API-scoped `format:check` does not cover `apps/web`), as in 1F-B.

**Browser QA** (deferred to a dedicated post-merge QA step, the 1F-A/1F-B
pattern), scenario list to cover later:
1. Submit a draft → status badge flips to 待审批, controlled fields lock.
2. Approver approves → 已批准; reject (with reason) → 已驳回 with reason shown.
3. Submitter withdraw → back to 草稿, fields editable again.
4. Self-approval blocked (submitter cannot approve own order) — UI surfaces 403.
5. Non-approver sees the reactive-403 fallback on the approve panel.
6. Server-side cross-check: `order_approvals` rows + order `status` + audit chain.

**[待确认]** whether browser QA is in-scope for the 1F-C implementation PR or a
follow-up, as it was for 1F-A/1F-B. Recommendation: follow-up QA step, consistent
with prior phases.

---

## 9. Migration & Rollout

### 9.1 Forward migration (next number after 031 → **032**)

A single migration `db/migrations/032_order_approvals.sql`, `-- UP` section, two
parts:

1. **Widen the `status` CHECK** on both order tables (drop + re-add, mirroring how
   031 added the FX constraints):
   ```sql
   ALTER TABLE sales_orders DROP CONSTRAINT chk_sales_orders_status;
   ALTER TABLE sales_orders ADD CONSTRAINT chk_sales_orders_status
     CHECK (status IN ('draft','pending_approval','approved','rejected',
                       'confirmed','completed','cancelled'));
   -- identical for purchase_orders / chk_purchase_orders_status
   ```
   Non-destructive: the new set is a superset of the old, existing rows stay
   valid, no backfill, `DEFAULT 'draft'` unchanged.
2. **Create `order_approvals`** with the columns from §4.1, the
   `order_type`/`action`/`level` CHECK constraints, RLS enable+force+policy
   (§4.6), the `SELECT, INSERT`-only grant to `kirindesk_app`, and the two indexes
   (§4.7).

No data migration. **[待确认]** whether to also seed anything — recommendation:
**no seed**; `orders:approve`/`procurement:approve` already exist in
`002_permissions.sql`, and no default role grant changes (tenants assign the
approve permission to roles themselves).

### 9.2 Rollback (down migration)

`-- DOWN` section, reverse order:
```sql
DROP TABLE IF EXISTS order_approvals CASCADE;
-- restore the original four-state CHECK on both order tables
ALTER TABLE sales_orders DROP CONSTRAINT chk_sales_orders_status;
ALTER TABLE sales_orders ADD CONSTRAINT chk_sales_orders_status
  CHECK (status IN ('draft','confirmed','completed','cancelled'));
-- identical for purchase_orders
```
**Caveat (must be documented in the migration):** restoring the narrow CHECK
fails if any order is currently in a new state (`pending_approval` / `approved` /
`rejected`). The down migration is therefore only clean before the feature is used
in earnest. **[待确认]** whether the down migration should first coerce stragglers
(e.g. `pending_approval`/`rejected → draft`, `approved → confirmed`) so rollback
never fails. Recommendation: **include the coercion `UPDATE`s** in the down path
with a comment, so rollback is deterministic rather than throwing on a CHECK
violation; this matches a "rollback must always work" stance.

### 9.3 Verification commands

After writing the migration (implementation step, not now):
```bash
# apply + rollback + re-apply round-trip on a scratch DB
pnpm --filter @kirindesk/database migrate

# confirm the widened CHECK and new table/policy exist
#   \d+ sales_orders        -> status CHECK lists 7 states
#   \d+ order_approvals     -> RLS enabled, FORCE, tenant_isolation_policy
#   \dp order_approvals     -> kirindesk_app has SELECT, INSERT only (no UPDATE/DELETE)

# full gate
pnpm verify
pnpm --filter @kirindesk/web typecheck
```
The migrate runner's up/down round-trip (the project already exercises this) plus
`pnpm verify` is the gate. **[待确认]** nothing outstanding here — verification is
standard.

---

## 10. Open Questions & Risks

### 10.1 Exit criteria (acceptance)

This phase is done when:

- Migration 032 applies and rolls back cleanly (round-trip), widening the order
  `status` CHECK and creating `order_approvals` with RLS + grants + indexes.
- Both order services expose `submit` / `approve` / `reject` / `withdraw` with the
  state machine (§2.2), permission + `all`-scope + separation-of-duties gates
  (§D3/§7.2), the edit lock (§2.3), and FX-freeze-on-submit (§2.2), each writing
  an `order_approvals` row + an audit entry in one transaction.
- Illegal transitions return `409`, permission failures `401`/`403`, bad input
  `400`, missing/cross-tenant orders `404` (§5.4).
- Web order forms reflect status, lock controlled fields when
  `pending_approval`/`approved`, and offer state/permission-reactive
  submit/approve/reject/withdraw controls (§6).
- Full quality gate green (`pnpm verify` + web `typecheck`); new integration tests
  cover the §8.1 matrix; `verifyChain` green after approval runs.
- No code touches real external services; no scope beyond §1.

### 10.2 Consolidated [待确认] items

All carry the recommendation already stated inline; per the user's standing
instruction, **each defaults to its recommendation** unless overridden:

1. **§1 / §D2 — single-level approval** is sufficient for target customers (model
   reserves `level` for future multi-level). *Rec: yes, single-level.*
2. **§4.1 — no cross-table validation trigger** on `(order_type, order_id)`. *Rec:
   no trigger; rely on service-layer transaction + soft-delete.*
3. **§4.2 — approval history not filtered by parent order `deleted_at`.** *Rec:
   fine; history is only read in an already-loaded order's context.*
4. **§4.3 — create/update DTO keeps the original four states**; the four new
   states are reachable only via transition endpoints. *Rec: split as described.*
5. **§4.6 — `kirindesk_app` gets `SELECT, INSERT` only** (no UPDATE/DELETE) on
   `order_approvals`. *Rec: yes, immutable ledger at the privilege level.*
6. **§4.7 — defer the pending-inbox index** (`(tenant_id, to_status)` partial)
   until a cross-order inbox feature needs it. *Rec: defer.*
7. **§5.1 / §6.3 — `rejected → draft` reopen uses the normal update path** (not a
   dedicated endpoint); `/me` permission-codes enhancement deferred (keep the
   reactive-403 fallback). *Rec: reuse update path; defer `/me` change.*
8. **§5.3 / §6.5 — responses nest the single just-created approval record**; full
   `GET /:id/approvals` history view deferred. *Rec: nest latest only.*
9. **§9.2 — down migration coerces straggler states** (`pending_approval`/
   `rejected → draft`, `approved → confirmed`) before restoring the narrow CHECK,
   so rollback never throws. *Rec: include the coercion UPDATEs.*

> Minor sub-points noted inline (zh-CN labels §6.1, reason max-length §5.2,
> snapshot granularity §7.1, scope-resolution mechanism §7.2, concurrency test
> §8.1, browser-QA timing §8.2) also default to their stated recommendations.

### 10.3 Risks

- **Status enum widening** — touches the most-queried column on both order tables.
  Mitigated: superset CHECK, no backfill, no type change; existing rows unaffected.
- **`confirmed` semantics** — approval inserts *before* `confirmed`, leaving the
  existing `confirmed → completed → cancelled` lifecycle intact (§2.1). Risk is
  user confusion between "approved" and "confirmed"; mitigated by distinct
  labels/badges and docs. Pre-existing orders sitting in `confirmed` are valid and
  simply never went through the new gate.
- **Single-admin tenants** — "approver ≠ submitter" + "approve needs `all` scope"
  means a one-user tenant cannot both draft and approve (§D3). Intentional
  (separation of duties is the point) but must be surfaced in onboarding; a tenant
  that wants no approval gate simply never moves orders into `pending_approval`.
- **No hard FK on `order_approvals.order_id`** (§4.1) — integrity depends on the
  service-layer transaction discipline. Mitigated by soft-delete (ids never
  dangle) and tenant+RLS scoping; the optional trigger ([待确认] #2) remains a
  future tightening if needed.
- **Audit-after-commit gap** — an approval can commit while its audit write fails
  (logged, not rolled back), same trade-off as existing order actions. Accepted
  and consistent with the codebase; surfaced via error logs and the chain-verify
  test.
