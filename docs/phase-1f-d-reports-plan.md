# Phase 1F-D — Reports (Planning)

> Status: **Planning only.** No migration, no code, no commit until this plan is
> reviewed and approved. Mirrors the structure of
> `phase-1f-c-approval-workflow-plan.md`.
>
> Builds on completed work: orders + line items (1F-A), FX snapshot /
> base-currency derivation (1F-B), approval workflow / governed status states
> (1F-C). Sequenced **before** commission (Phase 1F-E candidate): commission
> calculation depends on the amount caliber (原币种 vs 本位币, which order states
> count as realized revenue) that this phase pins down. Reports establish that
> caliber as the single source of truth so commission inherits it rather than
> re-deriving it.

---

## 1. Goals & Scope

### Problem

The tenant now accumulates governed orders on both sides (sales + purchase),
each carrying line items, a frozen FX snapshot, a base-currency total
(`total_amount_base`), and a workflow status that distinguishes a `draft` from
an `approved` / `confirmed` / `completed` commitment. What the product still
lacks is any **aggregated view**: a tenant owner cannot answer "how much did we
sell this month," "which customer drives the most revenue," "what is our
purchase commitment by supplier," or "show me the trend across the last six
months" without exporting raw rows and adding them up by hand.

Every ingredient for those answers already exists in the transactional tables —
the missing layer is **read-only aggregation** that rolls orders up across a
time dimension and a grouping dimension (status, customer, supplier), reported
in a consistent money caliber. Critically, this caliber must be defined **once,
here**, because commission (the next phase) pays out against exactly these
numbers; if reports and commission disagree on "what counts as revenue," the
business breaks.

This phase delivers that aggregation layer and nothing more.

### In scope (this phase)

- **Read-only aggregate reports** over the existing sales and purchase orders
  (+ line items + FX base-currency derivation from 1F-B), computed on demand.
  No new transactional data; reports never write to or denormalize the order
  tables.
- **Sales summary** and **purchase summary** reports (symmetric), each
  aggregating order totals across:
  - a **time dimension** (e.g. by month / by day within a requested range), and
  - a **grouping dimension** — by **status**, by **customer** (sales), by
    **supplier** (purchase).
- A **consistent money caliber**: amounts reported in the tenant's **base
  currency** (`total_amount_base`) so multi-currency orders sum meaningfully,
  with the original-currency view and the handling of un-frozen FX rows pinned
  in §2.
- A **status filter caliber**: an explicit, documented rule for *which* order
  states count toward each report (e.g. realized vs. pipeline), defined in §2 so
  commission can inherit it verbatim.
- **Tenant isolation + `dataScope`** applied to the aggregation exactly as they
  apply to the underlying order list (an `own`-scoped caller sees only their own
  orders rolled up; an `all`-scoped caller sees the whole tenant). See §3.
- A **read endpoint + web report page** surfacing these summaries (consistent
  with existing list-page conventions), permission-gated (permission code
  decision in §3).

### Out of scope (deferred)

- **CSV / Excel / PDF export.** This phase renders aggregates on screen only;
  downloadable exports (and any signed-token download plumbing) are a later
  phase.
- **Charts / visualizations.** Tabular aggregates only. Front-end charting
  (trend lines, pie breakdowns) is deferred; the data shape returned should not
  preclude adding them later, but no charting is built now.
- **Materialized / persisted report tables or snapshots.** Whether to ever
  materialize is discussed as a design decision in §3, but the recommendation —
  and this phase's scope — is on-demand aggregation with **no new table** and
  **no migration**.
- **Scheduled / emailed reports, report subscriptions, saved report
  definitions.**
- **Commission calculation** itself. This phase only *fixes the caliber*
  commission will use; the commission engine, rates, and payout logic are the
  next phase.
- **Cross-tenant / platform-admin analytics.** All reports are single-tenant,
  scoped to the caller's tenant via RLS as everywhere else.
- **Custom / ad-hoc report builder** (user-defined groupings, pivot UI). The
  report set is a fixed, curated list (§2), not a query builder.

### Open questions (to resolve before exit)

- Placeholder — consolidated in §10 once the D-decisions below are confirmed.

---

## 2. Report Catalog & Caliber

This section pins the data caliber every report obeys. The caliber is binding:
commission (next phase) inherits it verbatim, so it is stated here as the single
source of truth, not re-derived downstream.

### 2.1 Report catalog (this phase)

Two symmetric reports, each returning tabular aggregates (no charts, no export):

| Report | Source | Group-by dimension(s) | Time dimension |
|--------|--------|-----------------------|----------------|
| **Sales summary** | `sales_orders` (+ items, + FX base) | by **status**, by **customer** | by month (within a requested `[from, to]` range), optionally by day |
| **Purchase summary** | `purchase_orders` (+ items, + FX base) | by **status**, by **supplier** | by month (within a requested `[from, to]` range), optionally by day |

Each row of an aggregate carries: the group key (status / customer / supplier /
period), an **order count**, and a **summed amount** in the money caliber below.
The grouping and time dimensions compose (e.g. "sales by customer per month"),
with the exact endpoint shape and the set of supported groupings deferred to §5.

### 2.2 Money caliber — sum in base currency

**Decision (recommended): aggregate on `total_amount_base` (tenant base
currency), not on the original-currency `total_amount`. [待确认]**

- Orders may be in mixed currencies (`RMB`/`USD`/`HKD`/`EUR`). Summing the raw
  `total_amount` across currencies is meaningless ("100 USD + 100 RMB = 200 ?").
  `total_amount_base` is the 1F-B–frozen, single-currency figure precisely so
  that cross-currency rows are comparable and additive. Reports therefore sum
  **`total_amount_base`**, and every amount a report returns is implicitly "in
  the tenant's base currency."
- The original-currency `total_amount` is **not** summed across groups. It may
  still appear as a per-order detail if a drill-down is added later, but the
  aggregate caliber is base-currency only. Rationale: a single additive number
  the whole tenant agrees on, matching how commission will pay out.
- **Un-frozen FX rows** (`total_amount_base IS NULL` — the 1F-B case where a
  cross-currency order had no resolvable rate at submit, so the base amount was
  left null rather than guessed): these rows are **excluded from the summed
  amount** and surfaced as a separate **"un-costed" count** on the report, so a
  null never silently reads as a zero contribution. *Rec: exclude from the sum,
  report the count separately so the gap is visible and actionable.* [待确认]
- Same-currency orders (currency == base) have `total_amount_base ==
  total_amount` by 1F-B's `rate=1/source=system` rule, so they need no special
  casing — they aggregate identically.

### 2.3 Status caliber — which order states count

The 1F-C status enum is
`draft → pending_approval → approved → rejected → confirmed → completed →
cancelled`. Not all of these represent realized business value, so a report must
state which states it counts. **The report does not collapse states silently;
it groups by status and lets the consumer see each bucket, while defining a
default "realized" caliber for headline totals.**

**Decision (recommended) — three explicit calibers, status-grouped underneath:**
[待确认]

- **Realized (headline default):** `confirmed` + `completed`. These are the
  states that represent committed, acted-upon business — the natural basis for
  "how much did we actually sell/buy." This is the caliber **commission should
  inherit** unless the business says otherwise.
- **Approved-and-up (optional caliber):** `approved` + `confirmed` +
  `completed`. Includes orders that passed the 1F-C approval gate but are not yet
  confirmed. Offered because some businesses treat sign-off as the revenue
  trigger.
- **Pipeline (excluded from realized, shown separately):** `draft` +
  `pending_approval` + `rejected`. In-flight or dead orders; reported as
  visibility but never folded into a realized total.
- **`cancelled` is always excluded** from every summed amount (it represents
  voided commitment), but its count may be shown for completeness.

Because the report **groups by status**, all buckets are visible in the raw
breakdown regardless of caliber; the caliber only governs which buckets feed the
headline/subtotal line. The default headline caliber is **Realized**; the chosen
caliber is an explicit request parameter (default `realized`), so commission can
later pin the exact same parameter value. *Rec: default `realized` =
`confirmed`+`completed`; expose the caliber as a parameter rather than
hard-coding, so commission reuses it by name.* [待确认]

### 2.4 `dataScope` applied to the aggregate

**Decision (recommended): the aggregation respects the caller's `dataScope`
exactly as the underlying order list does — scope is applied to the rows
*before* they are aggregated, never after. [待确认]**

- An **`all`-scoped** caller (e.g. `orders:view` / `procurement:view` granted at
  `all`) aggregates over every order in the tenant.
- An **`own`-scoped** caller aggregates only over orders they own
  (`owner_user_id = :userId`), reusing the existing `restrictsToOwner` predicate
  from the order services — the same `WHERE owner_user_id = $n` clause, applied
  inside the aggregation query before `GROUP BY`. The resulting totals are
  therefore "my numbers," consistent with what the same user sees on the order
  list page.
- Scope filtering is part of the SQL aggregation predicate, **not** a
  post-aggregation mask, so an `own`-scoped caller can never observe another
  user's totals even in a roll-up cell. *Rec: push scope into the aggregation
  `WHERE`, mirroring the list endpoints; do not aggregate-then-filter.* [待确认]
- Tenant isolation remains enforced by RLS on the base tables (every aggregation
  query runs in the tenant's RLS context); `dataScope` is the **intra-tenant**
  narrowing layered on top, identical to today's list behavior. The interaction
  of RLS + `dataScope` for read-only aggregates is detailed further in §3.

---

## 3. Core Design Decisions

### D1. On-demand aggregation query vs. materialized view

**Options:**
- (a) **On-demand SQL aggregation** — each report request runs a `GROUP BY`
  query directly against `sales_orders` / `purchase_orders` (+ items + FX base),
  in the caller's RLS + `dataScope` context. No new object, no migration.
- (b) **Materialized view** (or a persisted summary table refreshed on a
  schedule / on write) that pre-rolls the aggregates.

**Decision (recommended): (a) on-demand aggregation, no materialized view, no
new table. [待确认]**

- **Correctness & freshness.** A report always reflects the live order state the
  instant it is read — an order that just moved `pending_approval → approved`,
  or a freshly frozen FX base amount, shows up immediately. A materialized view
  introduces a staleness window and a refresh story (when? on every order write?
  on a timer?) that this phase does not need.
- **`dataScope` is per-caller.** A materialized view pre-aggregates *across*
  owners; it cannot encode "rows owned by the requesting user" without either
  refreshing per user (absurd) or storing `owner_user_id` in the grouping and
  re-aggregating at read time — at which point it's just a slower on-demand
  query with a staleness penalty. On-demand aggregation applies the scope
  predicate naturally (see D3).
- **Volume.** At the target customer scale (orders per tenant per month), a
  `GROUP BY` over an indexed `(tenant_id, status)` / `(tenant_id, created_at)`
  set is comfortably fast. The existing indexes
  (`idx_sales_orders_tenant_status`, `idx_sales_orders_tenant_created_at`, and
  the purchase equivalents) already cover the status- and time-dimension
  filters; no new index is anticipated for this phase. [待确认]
- **Gate discipline.** A materialized view is a schema object requiring a
  migration. The CLAUDE.md gate is "minimum step, no migration without explicit
  confirmation." On-demand aggregation ships the feature with **zero schema
  change**, which is the smaller, reversible step.
- **Revisit later.** If a future phase adds expensive cross-range trend reports
  or the tenant scale grows, materialization can be introduced then as an
  optimization behind the same read endpoint — the API contract (§5) is designed
  not to leak whether the numbers are live or cached. *Rec: defer
  materialization until a measured need exists.*

### D2. Aggregate in base currency (`total_amount_base`)

**Decision (recommended): every summed amount aggregates `total_amount_base`,
the 1F-B–frozen tenant-base-currency figure; the original-currency
`total_amount` is never summed across groups. [待确认]**

- This is the money-caliber rule from §2.2, restated as a binding design
  decision because it has cross-phase consequences: commission pays against
  these numbers, so commission must also read `total_amount_base`. Defining it
  in one place prevents the two phases from diverging.
- Cross-currency additivity is the whole reason 1F-B froze a base amount per
  order. Summing `total_amount` across mixed currencies is arithmetically
  meaningless; summing `total_amount_base` is correct by construction.
- **Null handling is part of the caliber, not an afterthought.** Rows with
  `total_amount_base IS NULL` (un-resolvable FX at freeze time) are **excluded
  from the sum** and counted separately as "un-costed," so a missing base amount
  can never be silently read as a zero. The aggregation uses
  `SUM(total_amount_base)` (which ignores nulls in SQL) paired with a
  `COUNT(*) FILTER (WHERE total_amount_base IS NULL)` to surface the gap. *Rec:
  sum-ignoring-null plus an explicit un-costed count.*
- No rounding or re-conversion happens at report time: the report sums the
  already-frozen per-order base figures. It does **not** re-apply live FX rates
  to historical orders — the frozen snapshot is the figure of record, consistent
  with 1F-B's immutability stance. *Rec: sum frozen snapshots only; never
  re-convert at read time.* [待确认]

### D3. `dataScope` applied inside the aggregation query (anti-escalation)

**Decision (recommended): the `dataScope` predicate is part of the aggregation
`WHERE` clause, applied to rows *before* `GROUP BY`; tenant isolation stays on
RLS. Aggregate-then-filter is explicitly rejected. [待确认]**

- **Two independent layers, both enforced server-side:**
  1. **Tenant isolation** — every aggregation query runs in the tenant's RLS
     context (the same `app.current_tenant_id` mechanism as all reads). RLS on
     the base tables guarantees a query can only ever see the caller's tenant's
     rows; the report layer adds nothing and removes nothing here.
  2. **`dataScope` narrowing** — layered *on top* of RLS, identical to the order
     list endpoints. An `all`-scoped caller has no extra predicate; an
     `own`-scoped caller gets `AND owner_user_id = $n` injected into the
     aggregation query, reusing the exact `restrictsToOwner` predicate already
     used by `sales-orders.service` / `purchase-orders.service`. The narrowing
     happens **before** aggregation, so an `own`-scoped caller's group totals
     only ever cover their own orders.
- **Why before, not after.** If aggregation ran tenant-wide and then a mask were
  applied to the result rows, an `own`-scoped caller's roll-up cells would have
  been computed from other users' orders — leaking tenant-wide totals through an
  aggregate even if individual rows are hidden. Pushing the scope predicate into
  the `WHERE` makes leakage structurally impossible: the rows the user may not
  see never enter any `SUM`/`COUNT`. *Rec: scope-then-aggregate, never
  aggregate-then-mask.*
- **Permission gate.** Read access to a report is gated by a view permission
  (the `reports:view` vs. reuse-`orders:view`/`procurement:view` decision is
  deferred to §3's permission sub-section / §7; flagged here as the access gate
  that runs before any aggregation). The `dataScope` attached to that grant is
  what selects the `all` vs. `own` branch above.
- This mirrors 1F-C's stance that authorization is enforced at the service/SQL
  layer (the authority), with the UI merely reflecting it. *Rec: enforce in the
  aggregation SQL; treat the web report page as a reflection, not the gate.*

---

## 4. Data Model

**No new tables. No new columns. No migration.** This phase is pure read-only
aggregation over data models that already exist and are already governed:

- `sales_orders` / `purchase_orders` — header, `status`, `currency`,
  `total_amount`, `owner_user_id`, `created_at`, and the 1F-B FX columns
  (`fx_rate`, `fx_rate_source`, `total_amount_base`, `fx_captured_at`).
- `sales_order_items` / `purchase_order_items` — line items (1F-A). Read only if
  a line-level breakdown is needed; the header `total_amount` /
  `total_amount_base` already carries the server-derived totals, so the summary
  reports in §2 aggregate at the header level and do not require touching the
  item tables.
- `customers` / `suppliers` — joined for the by-customer / by-supplier grouping
  labels (read only).

Consequences of "no new schema object":

- **No migration file is created in this phase**, consistent with the CLAUDE.md
  gate (no migration without explicit confirmation) and with D1 (on-demand
  aggregation, no materialized view / summary table).
- **No new index is anticipated.** The existing
  `idx_{sales,purchase}_orders_tenant_status` and
  `idx_{sales,purchase}_orders_tenant_created_at` indexes already cover the
  status- and time-dimension predicates the aggregation queries filter on. If a
  specific grouping later proves slow under real data, an index can be proposed
  then as a separate, explicitly-confirmed migration — not pre-emptively here.
  [待确认]
- **No RLS or grant change.** Aggregation queries run as `kirindesk_app` in the
  tenant's existing RLS context against the same base tables; the existing
  `SELECT` privilege and tenant-isolation policies already permit and constrain
  exactly the reads this phase performs. Nothing new is granted.
- **Reports are derived, never stored.** No aggregate result is persisted back;
  there is no denormalization of order totals into a report table, so there is
  no new write path, no refresh/staleness concern, and nothing to roll back.

---

## 5. API Design

All endpoints are **read-only** (`GET`), tenant-scoped via RLS, narrowed by the
caller's `dataScope` (§D3), and gated by a **view permission** (the
`reports:view` vs. reuse-`orders:view`/`procurement:view` decision is in §7;
this section assumes the gate by the name `reports:view` as the recommended
option). No mutating verbs exist in this module.

### 5.1 Endpoints

Two symmetric summary endpoints, mirroring the sales/purchase split used
everywhere else:

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/reports/sales-summary` | `reports:view` (sales facet) | Aggregate sales orders by the requested dimension(s) |
| `GET` | `/api/reports/purchase-summary` | `reports:view` (procurement facet) | Aggregate purchase orders by the requested dimension(s) |

Purchase is identical in shape to sales, substituting supplier for customer and
the procurement permission facet. (Whether `reports:view` is one code with two
facets, or splits into `reports:sales`/`reports:purchase`, is a §7 [待确认];
the route pair is the same either way.)

### 5.2 Query parameters

| Param | Type | Default | Meaning |
|-------|------|---------|---------|
| `from` | date (`YYYY-MM-DD`) | required | Inclusive start of the time range (filters on `created_at`) |
| `to` | date (`YYYY-MM-DD`) | required | Inclusive end of the time range |
| `groupBy` | enum | `status` | Grouping dimension: `status` \| `customer` (sales) \| `supplier` (purchase) \| `period` |
| `granularity` | enum | `month` | Time bucket when `groupBy=period` (or the secondary time axis): `month` \| `day` |
| `caliber` | enum | `realized` | Status caliber from §2.3: `realized` (`confirmed`+`completed`) \| `approved_up` \| `pipeline` \| `all` |

- `from`/`to` are validated as a sane range (`from <= to`); an invalid or
  missing range is a `400`. [待确认: max range cap, e.g. ≤ 24 months]
- `caliber` selects which statuses feed the summed amount; the response always
  also returns the per-status breakdown so the consumer sees every bucket
  regardless of caliber (§2.3). Commission later passes the same `caliber` value
  by name.
- Unknown `groupBy`/`granularity`/`caliber` values are rejected `400` (no silent
  fallback).

### 5.3 Response shape

A single JSON object: the grouped rows plus a totals/meta envelope. Amounts are
**base-currency** (`total_amount_base`, §D2); the response states this so the
client never guesses the currency.

```jsonc
{
  "caliber": "realized",          // echoed back: which statuses fed the totals
  "currency": "RMB",              // tenant base currency the amounts are in
  "range": { "from": "2026-01-01", "to": "2026-06-30", "granularity": "month" },
  "groupBy": "status",
  "rows": [
    {
      "key": "confirmed",         // group key: status code | customer/supplier id | period bucket
      "label": "已确认",           // display label (zh-CN status, or customer/supplier name)
      "orderCount": 42,
      "amountBase": "128400.00",  // SUM(total_amount_base) over in-caliber rows in this group
      "unCostedCount": 1          // rows excluded from amountBase due to NULL base (§2.2)
    }
    // …one row per group key
  ],
  "totals": {
    "orderCount": 57,
    "amountBase": "150250.00",    // sum across in-caliber groups
    "unCostedCount": 2            // tenant-wide un-costed rows in range (visibility, not folded into amount)
  }
}
```

- `amountBase` is a decimal **string** (numeric precision preserved, never a JS
  float), consistent with how order totals are already serialized.
- `unCostedCount` surfaces NULL-base rows so a missing FX freeze is visible and
  never silently read as zero (§D2).
- When `groupBy=customer`/`supplier`, `key` is the entity id and `label` its
  name (joined read-only); when `groupBy=period`, `key`/`label` is the bucket
  (e.g. `2026-03`). The breakdown-by-status is included alongside even for
  non-status groupings so the caliber buckets stay inspectable. [待确认: whether
  to always embed the status breakdown or only on `groupBy=status`]

### 5.4 Errors

- `400` — invalid/missing `from`/`to`, `from > to`, or unknown enum value.
- `401` — unauthenticated.
- `403` — authenticated but lacks the report view permission.
- Tenant isolation and `dataScope` narrowing never produce a 403 by themselves;
  they silently scope the aggregate (an out-of-scope caller simply sees their own
  smaller numbers, or zero rows), consistent with the list endpoints.

---

## 6. Web / Frontend

A single read-only reports page (or a sales/purchase pair), consistent with the
existing list-page conventions and the 1F-B/1F-C permission-reactive pattern.
No editing, no mutation controls — reports only render.

### 6.1 Route

- `/reports` — the reports landing page, added to `App.tsx` under the
  `ProtectedRoute` + `AppLayout` block like every other authenticated page.
- Sales and purchase summaries live on this one page as two sections (or a
  toggle), rather than two separate routes, since they share controls and shape.
  [待确认: single `/reports` with a sales/purchase switch vs. `/reports/sales`
  + `/reports/purchase`]
- A nav entry is added to `AppLayout` (shown only when the caller holds the view
  permission; see §6.4).

### 6.2 Controls

The page exposes the §5.2 query parameters as form controls, then calls the
read endpoint and renders the returned aggregate:

- **Date range** (`from` / `to`) — date inputs, defaulting to a sensible window
  (e.g. current month-to-date or trailing N months). [待确认: default window]
- **Group-by** selector — 状态 / 客户(销售)/ 供应商(采购)/ 时间(period).
- **Granularity** selector — 按月 / 按日 (relevant when grouping by time).
- **Caliber** selector — 已实现(confirmed+completed,默认)/ 已批准及以上 /
  在途 / 全部, mapping 1-to-1 to the §2.3 `caliber` parameter.

Changing any control re-fetches; the page never aggregates client-side beyond
trivially rendering the server's rows.

### 6.3 What is displayed

A table of the server's grouped rows plus a totals line:

- **Group column** — the zh-CN label: status label (复用 1F-C `已草稿/待审批/
  已批准/…` 标签), or customer/supplier name, or period bucket (`2026-03`).
- **订单数 (order count)** column.
- **本位币金额 (base-currency amount)** column — renders `amountBase` with the
  base currency from the response envelope (e.g. `¥128,400.00` / `RMB`), so the
  unit is explicit and the column header states the caliber is base-currency.
  This is the headline number; original-currency per-order amounts are **not**
  summed here (§D2).
- **未计入 (un-costed) count** — surfaces `unCostedCount` (NULL-base rows) as a
  small annotation per row and in the totals line, so a missing FX freeze is
  visible rather than silently dropped (§2.2). When zero, it is hidden or shown
  as `—`.
- A **totals row** summing in-caliber groups, mirroring `response.totals`.
- The selected **caliber and base currency are shown in/above the table** (e.g.
  "口径:已实现 · 金额单位:本位币 RMB") so the numbers are never ambiguous.

Empty result (no orders in range/scope) renders a friendly empty state, not an
error.

### 6.4 Permission-reactive rendering (403 fallback)

Consistent with the 1F-B settings-page and 1F-C approval-panel pattern, the UI
**reflects** authorization but is not the gate (the API is, §D3):

- The `/reports` nav entry and page are shown when the caller holds the report
  view permission. With the current `/me` payload not enumerating permission
  codes, the page uses the same **reactive-403 fallback** already used elsewhere:
  it attempts the read, and on `403` renders a clear read-only notice
  (e.g. “没有权限查看报表”) instead of a broken table — no client-side secret
  about who may view.
- Because the page is read-only, there is no "denied save flips to read-only"
  case to handle (unlike 1F-B settings); a 403 simply replaces the table region
  with the permission notice.
- `dataScope` is invisible to the UI: an `own`-scoped caller just sees their own
  (smaller) numbers returned by the server; the page does not need to know or
  display the scope, it renders whatever in-scope aggregate the API returns.

---

## 7. Audit & Security

### 7.1 Audit — reads do not write to the chain

- Reports are **pure reads**. They emit **no `audit_logs` rows** and touch the
  hash-chain not at all. The append-only audit chain records state *mutations*
  (who changed what); viewing an aggregate changes nothing, so writing an audit
  row per report view would only dilute the chain with non-events and add a write
  path to a read-only feature. *Rec: no audit entry for report reads.* [待确认]
- Consequently this phase adds **no `verifyChain` surface** and cannot affect
  chain integrity — there is nothing to verify because nothing is appended.
- If a future compliance need requires "who viewed which report when," that
  belongs in a separate access-log mechanism, **not** the integrity hash-chain
  (mixing read-access logging into the tamper-evident mutation chain would
  conflate two different concerns). Explicitly out of scope here.

### 7.2 Security

**Permission code — `reports:view` (recommended new code) vs. reuse
`orders:view` / `procurement:view`.** [待确认]

- *Rec: add a dedicated `reports:view` permission* (seeded like other permission
  bits), rather than reusing the order-list view permissions. Rationale:
  aggregated tenant-wide totals are a *different* sensitivity than viewing an
  individual order — a tenant may want a salesperson to see their own orders
  (`orders:view@own`) yet **not** see a roll-up of the whole tenant's revenue. A
  separate code lets the tenant grant report access independently. The two
  report facets (sales vs. purchase) can be one code with the sales/purchase
  routes each checking it, or split into `reports:sales` / `reports:purchase`;
  *Rec: one `reports:view` code this phase, split later only if a tenant needs
  asymmetric grants.* If reusing existing codes is preferred instead, sales-
  summary would check `orders:view` and purchase-summary `procurement:view` —
  noted as the fallback.
- Seeding: the new code is added to the permissions seed and granted to the
  appropriate default role(s) (e.g. tenant admin). This is a **seed change, not a
  migration** of schema; flagged for confirmation under the same gate. [待确认]

**`dataScope` is the anti-escalation boundary (restated for security).**

- **Tenant isolation** is enforced by RLS on the base tables — an aggregation
  query physically cannot read another tenant's rows. The report layer neither
  weakens nor re-implements this.
- **Intra-tenant `dataScope`** is pushed into the aggregation `WHERE` *before*
  `GROUP BY` (§D3), so an `own`-scoped caller's `SUM`/`COUNT` are computed only
  from rows they own. Aggregate-then-mask is rejected precisely because it would
  let tenant-wide totals leak through a roll-up cell even when individual rows
  are hidden. The security property: **a value a user may not see never enters
  any aggregate the user receives.**
- The view-permission check runs **before** aggregation; lacking it is a `403`.
  Holding it with `own` scope silently narrows the numbers (not a 403),
  consistent with the list endpoints.

**Amount sensitivity / masking.**

- The base-currency totals are the sensitive payload. Access to them is governed
  by the view-permission + `dataScope` combination above: an `own`-scoped grant
  *is* the masking mechanism — such a caller receives only their own subtotal,
  never the tenant-wide figure. There is no separate field-level redaction;
  scope-before-aggregate already ensures the user only ever receives numbers
  they are entitled to. *Rec: rely on scope-narrowed aggregation as the masking
  boundary; do not return a tenant-wide total to an `own`-scoped caller and then
  blank it client-side.* [待确认]
- No PII beyond customer/supplier display names (already visible to anyone with
  the corresponding view permission) appears in a report; the aggregates are
  counts and money, not contact records.
- Error responses never disclose out-of-scope existence: an `own`-scoped caller
  querying a range with no orders of their own gets an empty aggregate, not a
  hint that other users' orders exist in that range.

---

## 8. Testing & Quality Gate

### 8.1 Coverage to add

Integration tests (sales + purchase, symmetric) exercising the aggregation
through the API in a real RLS + `dataScope` context:

- **Money caliber (§D2).**
  - Cross-currency orders sum on `total_amount_base`, not raw `total_amount`
    (mixed RMB/USD/HKD orders roll up to the correct base total).
  - Same-currency orders (`total_amount_base == total_amount`) aggregate
    identically.
  - **NULL-base rows are excluded from `amountBase`** and counted in
    `unCostedCount` — a null never reads as a zero contribution; the totals line
    surfaces the gap.
  - `amountBase` is returned as a precise decimal string (no float drift).
- **Status caliber (§2.3).**
  - `caliber=realized` sums only `confirmed`+`completed`.
  - `caliber=approved_up` includes `approved`; `pipeline` covers
    `draft`/`pending_approval`/`rejected`; `all` covers everything except the
    always-excluded `cancelled` from summed amounts.
  - `cancelled` is never folded into any summed amount.
  - The per-status breakdown is present regardless of selected caliber.
- **Grouping & time dimensions.**
  - `groupBy=status` / `customer` / `supplier` / `period` each return correct
    group keys, labels (zh-CN status / entity name / period bucket), counts, and
    base totals.
  - `granularity=month` vs `day` bucket correctly; `from`/`to` range is
    inclusive and filters on `created_at`.
- **`dataScope` anti-escalation (§D3) — the security-critical cases.**
  - An `own`-scoped caller's aggregate is computed only from their own orders;
    another user's orders never contribute to any group total or the grand total
    (scope-before-aggregate, not aggregate-then-mask).
  - An `all`-scoped caller sees the full tenant roll-up.
  - **Cross-tenant isolation:** an aggregation in tenant A never includes any
    tenant B rows (RLS), verified with two seeded tenants.
- **Permission gate (§7.2).**
  - Missing report view permission → `403` before any aggregation.
  - Holding it with `own` scope → `200` with narrowed numbers (not a 403).
- **Input validation (§5).**
  - Missing/invalid `from`/`to`, `from > to`, unknown `groupBy`/`granularity`/
    `caliber` → `400` (no silent fallback).
  - Empty result (no in-scope orders in range) → `200` empty aggregate, not an
    error.
- **No audit / no write (§7.1).**
  - A report read appends **no** `audit_logs` row (assert chain length unchanged
    across a report call) and performs no write to the order tables.

Unit tests for the pure pieces: the caliber→status-set mapping and the
base-currency/NULL summation helper, independent of the DB.

### 8.2 Quality gate

- **`pnpm verify` must be fully green** before commit: lint, format:check,
  typecheck (web + api), build, unit, integration, security regression — the
  same gate enforced for 1F-A/1F-B/1F-C. The new integration tests raise the
  integration count; security regression (13/13) must remain unaffected since
  this phase adds no schema, RLS, or grant change.
- **`verifyChain` PASS** is unchanged by definition (reads append nothing); a
  before/after chain-length assertion in the suite guards against an accidental
  write creeping in.
- **Port hygiene** for any browser QA: clear `3001`/`5173` before starting dev
  servers (the recurring stale-listener step), tear down and release ports after.
- Browser QA (if run this phase): load `/reports`, exercise the controls, verify
  base-currency column + caliber label render, confirm the 403 read-only
  fallback for a viewer without the permission, and cross-check a rendered total
  against a direct SQL aggregate on the seeded data. QA data seeded under a
  recognizable prefix and **cleaned up afterward** (footprint → 0), per the
  1F-C QA discipline.

---

## 9. Migration & Rollout

**No migration. No schema change. No down migration.** This phase ships entirely
as application code (a read-only aggregation service + endpoints + a web page)
over the existing schema (§4).

- **Forward "migration": none.** No new table, column, index, RLS policy, or
  grant is created. The migration number sequence is **not advanced** by this
  phase. The only data-layer change under consideration is a **permissions seed
  addition** (`reports:view`, §7.2) — a seed update, not a schema migration —
  and it is itself flagged [待确认] before being applied.
- **Rollback:** trivial and code-only. Reverting the feature is removing the
  endpoints/page (and the seed row, if added); because nothing is persisted or
  denormalized, there is no data to coerce, backfill, or restore, and no risk to
  existing orders. Disabling the route instantly removes the surface with zero
  data-layer footprint.
- **Rollout:** no special ordering, no backfill, no downtime window. The feature
  is inert until the route is reachable and the view permission is granted;
  granting/ungranting `reports:view` is the on/off switch. Pre-existing orders
  are aggregated as-is the moment the endpoint ships — no migration step gates
  availability.
- **Verification commands** (no migration round-trip to run): the
  evidence is `pnpm verify` fully green (§8.2) plus, if QA is run, a rendered
  report total cross-checked against a direct SQL aggregate on seeded data and a
  before/after `audit_logs` count proving the read appended nothing.

---

## 10. Open Questions & Risks

### 10.1 Exit criteria (acceptance)

- Sales-summary and purchase-summary endpoints return correct base-currency
  aggregates across the status / customer / supplier / period dimensions and the
  documented status calibers.
- `dataScope` is enforced **inside** the aggregation (scope-before-aggregate):
  an `own`-scoped caller never receives a number computed from another user's
  orders; cross-tenant isolation holds.
- A report read appends no audit row and writes nothing.
- The `/reports` page renders the base-currency column + caliber label and
  degrades to a clean read-only notice on `403`.
- `pnpm verify` fully green; `verifyChain` PASS (unchanged); QA data (if seeded)
  cleaned to footprint 0.

### 10.2 Consolidated [待确认] items

Per the standing instruction, **each defaults to its recommendation** unless
overridden:

1. **§D1 — on-demand aggregation, no materialized view / summary table.** *Rec:
   on-demand; defer materialization until a measured need exists.*
2. **§2.2 / §D2 — sum `total_amount_base` (base currency); never sum raw
   `total_amount` across groups; never re-convert at read time.** *Rec: yes,
   base-currency caliber, frozen snapshots only.*
3. **§2.2 / §D2 — NULL-base (un-costed) rows excluded from the sum, surfaced as a
   separate count.** *Rec: exclude from sum, report `unCostedCount`.*
4. **§2.3 — status caliber: headline default `realized` = `confirmed`+`completed`;
   caliber is an explicit parameter so commission inherits it by name;
   `cancelled` always excluded from summed amounts.** *Rec: as stated.*
5. **§D3 / §7.2 — `dataScope` pushed into the aggregation `WHERE` before
   `GROUP BY` (scope-then-aggregate), tenant isolation on RLS.** *Rec: yes;
   aggregate-then-mask rejected.*
6. **§7.2 — add a dedicated `reports:view` permission code (seed change, not a
   schema migration), one code with sales/purchase facets this phase.** *Rec:
   new `reports:view`; split into `reports:sales`/`reports:purchase` only if a
   tenant later needs asymmetric grants. Fallback: reuse
   `orders:view`/`procurement:view`.*
7. **§7.1 — report reads emit no `audit_logs` rows.** *Rec: no audit on reads;
   read-access logging, if ever needed, is a separate mechanism, not the
   integrity chain.*
8. **§4 — no new index this phase** (existing tenant/status and tenant/created_at
   indexes suffice). *Rec: defer any index to a separate confirmed migration if
   real data shows a slow grouping.*
9. **§5.2 — request shape:** required `from`/`to`, `groupBy` default `status`,
   `granularity` default `month`, `caliber` default `realized`; optional max
   range cap (e.g. ≤ 24 months). *Rec: as stated; add a range cap to bound query
   cost.*
10. **§5.3 — embed the per-status breakdown alongside non-status groupings**
    (vs. only on `groupBy=status`). *Rec: always embed so calibers stay
    inspectable.*
11. **§6.1 — single `/reports` page with a sales/purchase switch** vs. two
    routes. *Rec: single page, two sections/toggle.*
12. **§6.2 — default date window** (e.g. current month-to-date or trailing N
    months). *Rec: trailing N months for a useful first render; exact N TBD.*

### 10.3 Risks

- **Caliber drift between reports and commission.** The single biggest risk is
  the *reason* this phase precedes commission: if commission later re-derives
  "what counts as revenue" instead of inheriting §2.3's `caliber` and §D2's
  base-currency rule, the two features will disagree and the business breaks.
  Mitigation: the caliber is defined here as the binding source of truth and
  exposed as a named parameter commission reuses verbatim.
- **Aggregate leakage via roll-up.** If `dataScope` were applied after
  aggregation, an `own`-scoped caller's totals could be computed from rows they
  cannot see. Mitigated by scope-before-aggregate (§D3) and an explicit
  anti-escalation test (§8.1).
- **NULL base amounts read as zero.** Un-costed FX rows could silently
  understate totals. Mitigated by excluding them from the sum and surfacing a
  visible `unCostedCount` (§2.2) rather than coercing NULL→0.
- **Query cost at scale.** On-demand aggregation over a wide date range could
  grow costly for large tenants. Mitigated by the existing tenant/status and
  tenant/created_at indexes, an optional range cap (§5.2), and the D1 escape
  hatch (introduce materialization later behind the same contract if a measured
  need appears).
- **Permission too coarse / too fine.** A single `reports:view` may not match
  every tenant's desire to split sales vs. purchase visibility; over-splitting
  adds grant-management burden. Mitigated by shipping one code now with the route
  pair already separable, so a later split is non-breaking.
