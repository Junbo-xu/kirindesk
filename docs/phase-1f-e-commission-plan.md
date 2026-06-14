# Phase 1F-E — Commission Calculation (Planning)

> Status: **Planning only.** No migration, no code, no commit until this plan is
> reviewed and approved. Mirrors the structure of
> `phase-1f-d-reports-plan.md` and `phase-1f-c-approval-workflow-plan.md`.
>
> Builds directly on completed work:
> - **1F-A** — orders + line items. Commission can be computed at order-header
>   granularity or drilled to the line-item level; the line items are the
>   finest basis available.
> - **1F-B** — FX snapshot / base-currency derivation (`total_amount_base`,
>   frozen `fx_rate`/`fx_rate_source`). Commission is money paid against order
>   value, so it must use the **same single-currency caliber** the rest of the
>   system agrees on rather than re-converting at calc time.
> - **1F-C** — approval workflow / governed status states
>   (`draft → pending_approval → approved → rejected → confirmed → completed →
>   cancelled`). Commission must only pay against orders that represent realized
>   business.
> - **1F-D** — reports established the **binding revenue caliber**: realized =
>   `confirmed` + `completed`, summed on `total_amount_base`, `cancelled` never
>   counted, NULL-base (un-costed) rows excluded and surfaced separately. This
>   phase **inherits that caliber verbatim** — commission and reports must never
>   disagree on "what counts as revenue."

---

## 1. Goals & Scope

### Problem

The tenant now has governed orders carrying a frozen base-currency value and a
workflow status that distinguishes a realized commitment from a draft or a dead
order (1F-A through 1F-D). What is still missing is the step that turns that
order value into **money owed to a salesperson**: a commission. Today a tenant
owner cannot answer "how much commission did this salesperson earn this month,"
"what rate applied to this order," or "what is our total commission liability
for the period" without computing it by hand outside the system — and doing so
by hand invites exactly the disagreement 1F-D was built to prevent (two people
adding up "revenue" differently).

Commission is fundamentally a **derivation on top of realized order value**:
take the orders that count (the 1F-D realized caliber), apply a rate (per
salesperson / per rule), and produce a per-order and per-salesperson commission
figure in the tenant base currency. The order value, the currency caliber, and
the "which orders count" rule are all already defined upstream; this phase adds
the **rate model + the calculation + a way to read the result**, and nothing
that re-litigates the upstream calibers.

The permission code `commission_tables:view` / `:lock` / `:unlock` already exists
in the seed (module `finance`), which signals the intended shape: commission is
driven by a **commission table** (a set of rates/rules) that can be **locked**
so a computed payout period cannot shift underneath after it is settled. This
phase makes that latent model real.

### In scope (this phase)

- **A commission rate model** — a tenant-scoped commission table holding the
  rate rules that map a realized order to a commission amount. The minimal,
  recommended rule shape is a **percentage rate of `total_amount_base`**, scoped
  by salesperson (the order's `owner_user_id`) with a tenant-level default;
  richer tiering is called out as a deferred extension (§3).
- **Commission calculation** — a read/derive operation that, for a requested
  period and (optionally) salesperson, takes the **1F-D realized orders**
  (`confirmed` + `completed`, summed on `total_amount_base`, `cancelled`
  excluded, un-costed NULL-base rows excluded + surfaced), applies the
  applicable rate, and produces:
  - a **per-order** commission line (order → base amount → rate → commission),
    and
  - a **per-salesperson** rollup (salesperson → realized base total → commission
    total) for the period.
  All commission amounts are in the **tenant base currency** (§1 dependency on
  1F-B), consistent with reports.
- **Lock / settle semantics** — the ability to **lock** a commission table (and
  thereby freeze the rates a settled period was computed against), gated by the
  existing `commission_tables:lock` / `:unlock` permissions, so a payout figure
  is reproducible and cannot silently change after sign-off. The exact freeze
  granularity (lock the table vs. snapshot the period) is a §3 decision; the
  recommendation is to snapshot the rate set used for a settled period.
- **Read endpoints + a web page** surfacing the per-order and per-salesperson
  commission for a period, permission-gated by `commission_tables:view` (and the
  `finance:view` module gate where applicable), mirroring the 1F-D reports page
  conventions (base-currency column, caliber label, graceful 403).
- **Tenant isolation + `dataScope`** applied to the calculation exactly as in
  reports: an `own`-scoped caller sees only their own commission; an `all`-scoped
  caller sees the whole tenant. Scope is pushed into the aggregation before
  rollup, never masked after (inherited from 1F-D §D3).
- **Audit** of the privileged, state-changing actions only — creating/editing a
  commission table and lock/unlock — appended to the existing hash-chain.
  Reading a commission calculation, like reading a report, writes nothing.

### Out of scope (deferred)

- **Payout execution / disbursement.** This phase *computes* commission owed; it
  does not pay it, integrate with payroll, generate payment instructions, or
  track "paid vs. unpaid" beyond the lock/settle marker. Disbursement is a later
  phase.
- **Complex tiered / progressive / split-commission schemes.** The shipped rule
  model is a flat percentage per salesperson with a tenant default. Tiered
  brackets, product-category rates, team splits, accelerators, draws/clawbacks,
  and multi-currency rate tables are deferred; the model is designed not to
  preclude them but does not implement them now.
- **Commission on anything other than realized orders.** No commission on
  pipeline/draft orders, quotes, or non-order revenue. The basis is exactly the
  1F-D realized caliber.
- **Re-deriving or overriding the revenue caliber.** Commission inherits the
  1F-D base-currency + realized-status caliber verbatim. This phase does not add
  a competing definition of revenue, does not re-apply live FX, and does not sum
  original-currency amounts.
- **Materialized commission tables / persisted period snapshots beyond the lock
  marker.** Calculation is on-demand over existing data (mirroring 1F-D §D1),
  except for the deliberate rate-snapshot that lock/settle requires; whether any
  further persistence is needed is a §3 decision (recommendation: persist only
  the rate model and the lock/settle snapshot, derive everything else live).
- **Approval workflow *for* commission tables.** Lock/unlock is the governance
  mechanism here, not a multi-step approval chain. A full approval workflow over
  commission tables (à la 1F-C orders) is out of scope.
- **Adjustments / manual commission overrides per order.** Hand-editing an
  individual order's commission outside the rule model is deferred.
- **Cross-tenant / platform-admin commission analytics.** Single-tenant only,
  scoped via RLS as everywhere else.
- **Export (CSV/Excel/PDF) and charts.** Tabular on-screen results only,
  consistent with where 1F-D left exports.

### Dependencies (explicit)

- **1F-A line items** — the finest available basis for commission; this phase
  computes at the order-header `total_amount_base` level by default and treats
  line-item-level commission as a deferred refinement, but the line items exist
  if a future rule needs category-level rates.
- **1F-B base currency** — every commission amount is derived from
  `total_amount_base` (frozen snapshot, never re-converted), so commission is in
  one additive currency and matches reports.
- **1F-C status states** — only governed, realized states are commissionable.
- **1F-D realized caliber** — the binding "what counts as revenue" rule, reused
  by name (`caliber=realized`) so commission and reports cannot diverge.

### Open questions

- Placeholder — consolidated in the final section once the §3 decisions are
  confirmed. (Per standing instruction, every [待确认] defaults to its stated
  recommendation.)

---

## 2. Commission Model & Caliber

_Placeholder — to be written._

---

## 3. Core Design Decisions

_Placeholder — to be written._

---

## 4. Data Model

_Placeholder — to be written._

---

## 5. API Design

_Placeholder — to be written._

---

## 6. Web / Frontend

_Placeholder — to be written._

---

## 7. Audit & Security

_Placeholder — to be written._

---

## 8. Testing & Quality Gate

_Placeholder — to be written._

---

## 9. Migration & Rollout

_Placeholder — to be written._

---

## 10. Open Questions & Risks

_Placeholder — to be written._
