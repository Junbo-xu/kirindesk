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

This section pins exactly how a commission figure is produced. Every caliber
choice here inherits from upstream phases (1F-B currency, 1F-C status, 1F-D
realized definition) so commission and reports can never disagree on the
numbers. The core formula is deliberately simple:

```
commission(order) = round2( total_amount_base(order) × rate(order) )
```

where `total_amount_base` is the 1F-B frozen base-currency value and `rate` is
resolved from the commission table (below). A salesperson's period commission is
the sum of their per-order commissions.

### 2.1 Basis — base currency, not original currency

**Decision (recommended): the commission basis is `total_amount_base` (the
1F-B–frozen tenant base-currency value), never the original-currency
`total_amount`. [采纳]**

- Commission is money the tenant pays out; it must be expressed in one additive
  currency. A salesperson with a mix of RMB/USD/EUR orders has one commission
  figure in the tenant base currency, exactly as their realized revenue is one
  figure in reports.
- This is the **same basis reports sum** (1F-D §D2). Reusing it guarantees that
  "commission = rate × realized revenue" holds by construction — the revenue
  number commission multiplies is literally the number the report shows.
- **No re-conversion at calc time.** Commission uses the frozen per-order
  snapshot; it never re-applies a live FX rate to a historical order. The base
  value of record is whatever was frozen at order time (1F-B's immutability
  stance), so a commission computed today and re-computed next month over the
  same locked period yields the identical figure.
- **Un-costed (NULL-base) orders carry no commission** and are surfaced
  separately. An order whose `total_amount_base IS NULL` (1F-B could not resolve
  a rate) has no defined basis, so multiplying it would be inventing a number.
  Such orders are **excluded from the commission sum** and reported as an
  "un-costed / uncommissionable" count (mirroring 1F-D §2.2), so the gap is
  visible and actionable rather than silently treated as zero commission on a
  real order. *Rec: exclude from the payout, surface the count.* [采纳]

### 2.2 Granularity — order header, with line items as a deferred refinement

**Decision (recommended): commission is computed at the order-header level on
`total_amount_base`. Line-item-level commission is deferred. [采纳]**

- The shipped rule model (flat percentage per salesperson, §2.3) needs only the
  order's base total and its owner — both header-level facts. Computing
  per-line and re-summing would produce the identical figure for a flat rate, so
  header granularity is the simpler correct choice for this phase.
- **The 1F-A line items remain the finest available basis** and are not
  discarded: a future product-category or per-line rate would drill to them. The
  header-level formula is designed so that introducing line-level rates later is
  an additive refinement (rate resolved per line, line commissions summed to the
  order) rather than a rewrite. *Rec: header now, line-level when a rule needs
  it.* [采纳]
- Rounding is applied **once per order** (`round2` of base × rate), then orders
  are summed, so the per-salesperson total is the sum of already-rounded
  per-order commissions — matching what a per-order commission statement would
  show line by line. *Rec: round per order, then sum.* [采纳]

### 2.3 Rate source — a tenant commission table, salesperson rate + default

**Decision (recommended): the rate comes from a tenant-scoped commission table
holding a percentage rate per salesperson, plus a tenant-level default rate for
salespeople with no explicit row. [采纳]**

- **Rate resolution order for an order:**
  1. an explicit rate row for the order's **owner_user_id** (the salesperson) →
     use it;
  2. otherwise the table's **default rate** → use it;
  3. if neither exists (no table, no default) → **rate 0**, i.e. no commission,
     and the order is flagged as "no applicable rate" so the gap is visible
     rather than silently paying zero on real revenue. *Rec: fall to 0 with a
     surfaced flag, never error the whole calculation.* [采纳]
- **Rate is a percentage** stored as a precise decimal (e.g. `numeric(7,4)`
  meaning up to 999.9999%, normal values like `5.0000` = 5%). Percentages, not
  absolute amounts, because commission scales with order value; absolute
  per-order bonuses are a deferred rule type.
- **Attribution = `owner_user_id`.** The salesperson credited for an order is its
  owner, the same field `dataScope` filters on, so "my commission" and "my
  orders" are consistent. Split/team commission is explicitly deferred (§1).
- **Rate freezing under lock.** When a commission table is **locked**
  (`commission_tables:lock`), the rate set a settled period was computed against
  is snapshotted so the payout is reproducible and cannot shift if rates are
  later edited (mechanism detailed in §3). Until locked, a calculation reflects
  the current table live (consistent with on-demand derivation). *Rec: live
  while unlocked, snapshot-frozen once locked.* [采纳]

### 2.4 Status caliber — only the 1F-D realized set is commissionable

**Decision (recommended): commission is paid only on the 1F-D realized caliber —
`confirmed` + `completed` — inherited verbatim, not redefined here. [采纳]**

- The commissionable orders are exactly the orders 1F-D's `caliber=realized`
  rolls up: `confirmed` + `completed`. Commission passes that caliber **by
  name** to the shared aggregation, so the basis it multiplies is identical to
  the report's headline revenue.
- **`cancelled` never earns commission** (voided commitment), and is excluded by
  construction — it is in no caliber's summed set.
- **Pipeline states earn no commission.** `draft` / `pending_approval` /
  `rejected` represent unrealized or dead orders; paying commission on them
  would pay for work not yet (or never) realized. They are excluded from the
  payout. The commission page may *show* a pipeline figure for visibility (what
  commission *would* be owed if those orders realize), but it is never folded
  into the payable total. *Rec: payable = realized only; pipeline shown
  separately as informational, defaulting off.* [采纳]
- **`approved`-but-not-`confirmed`** is treated as pipeline for payout purposes
  by default (it passed the approval gate but is not yet a realized commitment),
  consistent with 1F-D's `realized` excluding `approved`. A tenant that wants to
  pay on approval can select the `approved_up` caliber, since commission reuses
  the same caliber parameter — but the **default and recommendation is
  `realized`**. *Rec: default `realized`; `approved_up` available because the
  caliber is a shared parameter.* [采纳]

---

## 3. Core Design Decisions

### D1. On-demand derivation vs. persisted commission rows

**Options:**
- (a) **On-demand derivation** — a commission calculation request joins realized
  orders (1F-D caliber) to the commission table, applies the rate, and returns
  per-order + per-salesperson figures. Nothing is stored except the rate model.
- (b) **Persisted commission rows** — every order gets a materialized commission
  record, recomputed on order/table changes.

**Decision (recommended): (a) on-demand derivation for unlocked periods, with a
single deliberate exception — a *snapshot* taken at lock/settle time (D5).
Persist only the rate model (the commission table) and the lock snapshot; derive
everything else live. [采纳]**

- **Consistency with reports.** Commission is `rate × realized_revenue`. Reports
  derive realized revenue on demand (1F-D §D1); if commission persisted its own
  copy of order value it could drift from the report. Deriving both from the
  same live orders guarantees they agree.
- **Freshness & correctness.** An order that just moved `confirmed`, or a rate
  the owner just adjusted, is reflected immediately in an unlocked calculation —
  no staleness window, no recompute-on-write fan-out, no denormalized
  commission column on `orders` to keep in sync.
- **Volume.** Commission is computed per period on demand, over the same indexed
  realized-order set reports already scan; a `GROUP BY owner_user_id` with a
  rate join is comfortably fast at target scale. No materialization is needed
  for performance.
- **The lock exception is the only persistence.** A settled period must be
  reproducible (D5), so the rate set (and, per D5, the computed figures) used for
  that period is snapshotted at lock time. That is a deliberate, bounded write —
  not a per-order materialization — and it is the *reason* a locked figure stops
  tracking live data.

### D2. Determinism & idempotency of the calculation

**Decision (recommended): the calculation is a pure, deterministic function of
(period, caliber, scope, applicable rate set) — reading it any number of times
yields the same result and writes nothing. [采纳]**

- A commission **read** (`GET`) is idempotent by construction: it derives from
  immutable inputs (frozen `total_amount_base`, governed status, and either the
  live table or the locked snapshot). Re-issuing the same query returns the same
  numbers; concurrent reads never interfere because none of them mutate state.
- **Rounding is fixed and order-deterministic** (round2 per order, then sum, per
  §2.2), so two callers — or a caller and the report cross-check — compute
  byte-identical totals. No floating point: amounts are integer-cent / decimal
  arithmetic as in 1F-B/1F-D.
- The only **writes** in this phase are rate-table edits and lock/unlock (§7
  audited). Those go through the normal transactional + RLS path; a lock is the
  one place concurrency matters and is handled in D5.

### D3. Concurrency on the writes (table edits & lock)

**Decision (recommended): table edits and lock/unlock are serialized per
commission table via row-level locking inside the tenant-context transaction;
lock is idempotent. [采纳]**

- Editing a rate row and locking the table are short transactional operations.
  Two concurrent edits, or an edit racing a lock, are serialized by
  `SELECT … FOR UPDATE` on the table row so the lock snapshot can never capture a
  half-applied edit. *Rec: take the table row lock before snapshotting.* [采纳]
- **Lock is idempotent:** locking an already-locked table for the same period is
  a no-op success (returns the existing snapshot), not an error — so a retried
  request after a dropped connection cannot double-settle. Unlock is the inverse
  and is the audited, privileged escape hatch (`commission_tables:unlock`).
- **Editing a locked table is rejected** (the whole point of the lock); the rate
  set must be unlocked first, which is an audited action with a clear actor and
  reason. *Rec: reject writes to a locked table with a typed error.* [采纳]

### D4. Recalculation when an order's status or amount changes

**Decision (recommended): for unlocked periods, recalculation is implicit — the
next read re-derives from current data; for locked periods, the snapshot is
authoritative and does not move. [采纳]**

- Because unlocked commission is derived live (D1), there is **no recompute step
  to trigger**. An order that gains/loses realized status, gets its
  `total_amount_base` re-frozen (a 1F-B re-save), or changes owner simply
  contributes differently to the *next* calculation. This is the correct,
  surprise-free behavior while a period is still open.
- **A locked period is immune by design.** Once locked (D5), the period's
  commission is the snapshot; subsequent order or rate changes do **not**
  retroactively alter a settled payout. If a genuine correction is needed, the
  governed path is `unlock → recompute/adjust → re-lock`, every step audited —
  never a silent drift.
- **Cross-period movement is surfaced, not hidden.** If an order that was
  realized in a locked period later changes (e.g. moves to `cancelled` after
  settlement), the change shows up as a **reconciling delta in the current open
  period**, not as a mutation of the locked one. The recommendation is to make
  such after-the-fact reversals visible as current-period adjustments (D6)
  rather than rewriting history. *Rec: locked history is immutable; corrections
  flow through the open period.* [采纳]

### D5. Lock / settle snapshot — what gets frozen

**Decision (recommended): locking a commission table for a period snapshots the
**applicable rate set** and the **computed per-salesperson + per-order figures**
for that period, stored as the period's settled record. The lock marker plus
this snapshot is the only persisted calculation output. [采纳]**

- Freezing **just the rates** would still let a later order-status change move a
  "settled" total (D4). Freezing **the computed figures** makes the settled
  payout truly reproducible and immutable — what was signed off is what is
  stored. *Rec: snapshot both the rate set and the resulting figures.* [采纳]
- The snapshot is written **once, transactionally, under the table row lock**
  (D3), so it reflects a consistent point-in-time. It records the inputs that
  produced it (period bounds, caliber, rate set, the realized order ids + their
  base amounts) so the figure can be **explained**, not just asserted.
- **Scope of a lock is (commission table → period).** A period is locked
  independently; locking one period does not freeze future periods. Unlock
  reverses a specific period's settlement and is audited.
- This is the concrete realization of the latent `commission_tables:lock` /
  `:unlock` permissions already in the seed.

### D6. Refunds / cancellations — clawback via reversing entries, not history edits

**Decision (recommended): a cancellation or downgrade of a previously-commissioned
order is handled by a **reversing (negative) commission entry in the current open
period**, never by editing a locked period's figures. [采纳]**

- **Within an open (unlocked) period:** no special handling is needed — the
  order simply drops out of the realized set on the next derivation, so its
  commission disappears naturally before anything is settled.
- **After a period is locked:** the settled snapshot is immutable (D4/D5). If a
  commissioned order is later `cancelled` (or otherwise leaves the realized
  caliber), the system records a **clawback**: a negative commission entry
  attributed to the same salesperson in the **current** open period, equal to the
  commission previously paid on that order. This preserves the audit trail
  ("commission X was earned in period P, clawed back in period Q") instead of
  rewriting P. *Rec: reversing entries in the current period.* [采纳]
- **Clawback amount uses the originally-settled figure**, read from the lock
  snapshot (D5), so the reversal exactly cancels what was paid — not a
  recomputation at today's rate. *Rec: claw back the snapshotted amount, not a
  re-derived one.* [采纳]
- The clawback mechanism is **defined here but its full implementation may be
  staged**: the minimal shippable behavior is (i) open periods self-correct, and
  (ii) locked periods are immutable with after-the-fact reversals visible as a
  current-period adjustment line. Automated generation of clawback entries on
  status change can follow once lock/settle lands, since it depends on the
  snapshot existing. This staging is called out as a [采纳] sequencing note, not
  a scope cut — the immutability guarantee holds from day one.

---

## 4. Data Model

This phase introduces a **rate model** (mutable until locked) and an
**immutable settlement snapshot** (append-only). Everything else — the per-order
and per-salesperson figures for an *open* period — is derived on demand (§3 D1)
and is **not** a table. All money is `numeric(18,2)` in the tenant base currency,
matching 1F-B/1F-D. All tables follow the established conventions: `tenant_id uuid
NOT NULL REFERENCES tenants(id)`, RLS `ENABLE` + `FORCE` with the standard
`tenant_isolation_policy`, `tenant_id`-leading composite indexes, and explicit
privilege grants.

> **Migration note (gate):** these are four new tables (two mutable rate-model
> tables + two immutable settlement tables) → a single new migration
> (next number after `032`, i.e. **`033_commission.sql`**). No migration is
> written until this plan is approved, per the standing gate.

### 4.1 `commission_tables` — the rate model (mutable until locked)

One table per tenant holds the rate rules. Modeled as a parent row + rate rows so
a default and per-salesperson overrides coexist, and so the whole set can be
locked atomically.

```
commission_tables
  id              uuid PK default uuid_generate_v4()
  tenant_id       uuid NOT NULL REFERENCES tenants(id)
  name            varchar(128) NOT NULL          -- e.g. "2026 默认提成表"
  default_rate    numeric(7,4) NOT NULL DEFAULT 0 -- percent; 5.0000 = 5%
  status          varchar(16) NOT NULL DEFAULT 'active' -- active | archived
  created_by      uuid NOT NULL REFERENCES users(id)
  created_at      timestamptz NOT NULL DEFAULT now()
  updated_at      timestamptz NOT NULL DEFAULT now()
  CONSTRAINT chk_commission_tables_default_rate CHECK (default_rate >= 0)
  CONSTRAINT chk_commission_tables_status CHECK (status IN ('active','archived'))

commission_rate_rules
  id                  uuid PK default uuid_generate_v4()
  tenant_id           uuid NOT NULL REFERENCES tenants(id)
  commission_table_id uuid NOT NULL REFERENCES commission_tables(id) ON DELETE CASCADE
  salesperson_user_id uuid NOT NULL REFERENCES users(id)
  rate                numeric(7,4) NOT NULL       -- percent override for this person
  created_at          timestamptz NOT NULL DEFAULT now()
  updated_at          timestamptz NOT NULL DEFAULT now()
  CONSTRAINT uq_commission_rate_rules UNIQUE (tenant_id, commission_table_id, salesperson_user_id)
  CONSTRAINT chk_commission_rate_rules_rate CHECK (rate >= 0)
```

- **Rate precision = `numeric(7,4)`** (percent), distinct from money's
  `numeric(18,2)`: a rate is a multiplier, not an amount, and 4 dp covers
  fractional-percent rates (e.g. 2.5%, 0.75%) without float drift. The derived
  commission amount it produces is `numeric(18,2)` (round2, §2.2).
- **Resolution** (§2.3): a rule row for the order's `owner_user_id` wins; else
  `default_rate`; else 0 with a surfaced "no applicable rate" flag.
- **Relationship to orders/approval:** *none by FK.* Rules reference
  `users(id)` (the salesperson = order `owner_user_id`), not orders. Orders are
  joined only at calc time by `owner_user_id` within the tenant's RLS context.
  This keeps the rate model independent of order lifecycle — editing a rate never
  touches an order, and an order moving status never touches the table.
- **Mutability:** mutable (SELECT/INSERT/UPDATE/DELETE for `kirindesk_app`)
  **while no settlement references the table's rates for an open period**;
  writes are rejected at the service layer when the target period is locked
  (§3 D3), and the lock snapshot (4.2) — not a row flag here — is what makes a
  settled figure immutable.

Indexes:
```
CREATE INDEX idx_commission_tables_tenant       ON commission_tables (tenant_id);
CREATE INDEX idx_commission_rate_rules_tenant   ON commission_rate_rules (tenant_id, commission_table_id);
CREATE INDEX idx_commission_rate_rules_person   ON commission_rate_rules (tenant_id, salesperson_user_id);
```
RLS + grants (standard, mutable):
```
ENABLE/FORCE ROW LEVEL SECURITY; tenant_isolation_policy (USING + WITH CHECK app_current_tenant_id())
GRANT SELECT, INSERT, UPDATE, DELETE ON commission_tables, commission_rate_rules TO kirindesk_app;
```

### 4.2 `commission_settlements` — the immutable lock snapshot (append-only)

Locking a (commission table → period) writes one settlement header plus one
frozen line per salesperson. This is the only persisted *calculation output*
(§3 D5) and the source of truth for a settled payout and for clawbacks (§3 D6).

```
commission_settlements
  id                  uuid PK default uuid_generate_v4()
  tenant_id           uuid NOT NULL REFERENCES tenants(id)
  commission_table_id uuid NOT NULL REFERENCES commission_tables(id)
  period_start        date NOT NULL
  period_end          date NOT NULL
  caliber             varchar(16) NOT NULL DEFAULT 'realized'
  status              varchar(16) NOT NULL DEFAULT 'locked'  -- locked | unlocked
  -- frozen inputs for explainability (§3 D5): the rate set + realized order ids
  -- + their base amounts that produced the figures, captured at lock time.
  snapshot            jsonb NOT NULL
  total_commission_base numeric(18,2) NOT NULL  -- sum of line commissions
  total_basis_base      numeric(18,2) NOT NULL  -- sum of commissionable base revenue
  uncosted_count        integer NOT NULL DEFAULT 0
  locked_by           uuid NOT NULL REFERENCES users(id)
  locked_at           timestamptz NOT NULL DEFAULT now()
  unlocked_by         uuid REFERENCES users(id)
  unlocked_at         timestamptz
  supersedes          uuid REFERENCES commission_settlements(id) -- a superseding row points back at the row it replaces; NULL on an original lock
  CONSTRAINT chk_commission_settlements_period CHECK (period_end >= period_start)
  CONSTRAINT chk_commission_settlements_status CHECK (status IN ('locked','unlocked'))
  CONSTRAINT chk_commission_settlements_caliber CHECK (caliber IN ('realized','approved_up','pipeline','all'))
  CONSTRAINT chk_commission_settlements_totals CHECK (total_commission_base >= 0 AND total_basis_base >= 0)
  -- No plain UNIQUE on (tenant, table, period): superseding append rows (§4.2
  -- unlock model) legitimately repeat that tuple. "At most one *current*
  -- settlement per period" is enforced at the service layer under the §3 D3
  -- SELECT … FOR UPDATE row lock — the current row is the one not referenced by
  -- any other row's `supersedes` — so currentness needs no mutation of the
  -- immutable rows (a forward "superseded" flag would).

commission_settlement_lines
  id                  uuid PK default uuid_generate_v4()
  tenant_id           uuid NOT NULL REFERENCES tenants(id)
  settlement_id       uuid NOT NULL REFERENCES commission_settlements(id) ON DELETE CASCADE
  salesperson_user_id uuid NOT NULL REFERENCES users(id)
  basis_base          numeric(18,2) NOT NULL  -- this person's realized base revenue
  rate_applied        numeric(7,4) NOT NULL   -- the frozen rate used
  commission_base     numeric(18,2) NOT NULL  -- round2(basis_base * rate)
  order_count         integer NOT NULL DEFAULT 0
  uncosted_count      integer NOT NULL DEFAULT 0
  CONSTRAINT uq_commission_settlement_lines UNIQUE (tenant_id, settlement_id, salesperson_user_id)
  CONSTRAINT chk_commission_settlement_lines_amounts
    CHECK (basis_base >= 0 AND rate_applied >= 0 AND commission_base >= 0)
```

- **Why immutable:** a settled payout is a financial fact someone signed off on.
  If a later order/rate change could rewrite it, the figure would not be
  reproducible and the audit trail would be meaningless (§3 D4/D5). So the
  snapshot tables are **append-only at the privilege level** — exactly the
  `order_approvals` pattern: grant only `SELECT, INSERT`, then explicitly
  `REVOKE UPDATE, DELETE`. A "correction" is never an UPDATE; it is an audited
  **unlock** (which sets `status='unlocked'`, `unlocked_by/at` via the one
  permitted controlled path — see note below) followed by a fresh lock, or a
  clawback entry in the open period (§3 D6).
- **Unlock vs. append-only tension:** because `UPDATE` is revoked, `unlock`
  cannot flip `status` in place. The **recommended** shape: unlock **inserts a
  new settlement row** for the same (table, period), with `status='unlocked'`
  and `supersedes` pointing **back** at the row it replaces (a back-pointer on
  the *new* row, never a mutation of the old one — so the immutable rows are
  truly insert-only). The "current" settlement for a period is the row no other
  row supersedes. There is intentionally **no plain `UNIQUE`** on
  (tenant, table, period) — superseding rows repeat that tuple — so single-
  currentness is enforced at the service layer under the §3 D3
  `SELECT … FOR UPDATE` row lock rather than by a constraint that append rows
  would violate. *Rec: model unlock as a superseding append carrying a back-
  pointer, never an in-place mutation, to keep the privilege-level immutability
  guarantee intact.* [采纳]
- **`snapshot jsonb`** holds the explainability payload (period bounds, caliber,
  the resolved rate per salesperson, and the realized order ids + frozen
  `total_amount_base` that fed each line). It exists so a settled figure can be
  *re-derived and explained*, and so clawbacks (§3 D6) can read the
  originally-paid amount, without re-querying orders that may since have changed.
- **Relationship to orders/approval:** like `order_approvals`, **no hard FK to
  orders** (the snapshot intentionally outlives order changes — that is the
  point). Order ids live inside `snapshot` for traceability; integrity comes from
  RLS + the fact that orders are soft-deleted, never hard-deleted.

Indexes:
```
CREATE INDEX idx_commission_settlements_tenant
  ON commission_settlements (tenant_id, commission_table_id, period_start, period_end);
CREATE INDEX idx_commission_settlement_lines_settlement
  ON commission_settlement_lines (tenant_id, settlement_id);
CREATE INDEX idx_commission_settlement_lines_person
  ON commission_settlement_lines (tenant_id, salesperson_user_id);
```
RLS + grants (standard policy, **append-only** privileges):
```
ENABLE/FORCE ROW LEVEL SECURITY; tenant_isolation_policy on both tables
GRANT SELECT, INSERT ON commission_settlements, commission_settlement_lines TO kirindesk_app;
REVOKE UPDATE, DELETE ON commission_settlements, commission_settlement_lines FROM kirindesk_app;
```

### 4.3 What is NOT stored

- **Open-period per-order / per-salesperson figures** — derived live (§3 D1),
  never materialized.
- **A denormalized commission column on `sales_orders` / `purchase_orders`** —
  explicitly avoided to prevent drift from the report's revenue figure.
- **Live FX or re-converted amounts** — commission reads frozen
  `total_amount_base` only (§2.1).

---

## 5. API Design

All endpoints live under `/api/commission`, guarded by `TenantAuthGuard` +
`PermissionGuard`, scoped by RLS + `dataScope`. Reads are gated by
`commission_tables:view`; the privileged writes by `commission_tables:lock` /
`:unlock`; rate-table edits by `commission_tables:view` plus the finance module
gate (a dedicated `commission_tables:update` is **not** added this phase — table
edits reuse the existing `:lock` holder semantics, see §7). Read responses put
amounts in the tenant base currency and echo the caliber, exactly like 1F-D
reports.

### 5.1 Calculation (read-only, derived)

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/commission/summary` | `commission_tables:view` | Per-salesperson commission rollup for a period |
| `GET` | `/api/commission/orders` | `commission_tables:view` | Per-order commission detail (the explainable basis) for a period |

Query parameters (shared; mirror 1F-D so the caliber is passed *by name*):

| Param | Type | Default | Meaning |
|-------|------|---------|---------|
| `from` | date `YYYY-MM-DD` | required | Inclusive period start (filters order `created_at`) |
| `to` | date `YYYY-MM-DD` | required | Inclusive period end |
| `caliber` | enum | `realized` | `realized` \| `approved_up` \| `pipeline` \| `all` — which orders are commissionable (§2.4) |
| `tableId` | uuid | tenant's active table | Which commission table's rates to apply (defaults to the single active table) |
| `salespersonId` | uuid | (all in scope) | Optional filter to one salesperson |

- `from <= to`, valid enums, valid uuids → else `400` (no silent fallback),
  consistent with 1F-D validation.
- If the requested (table, period) is **locked**, the endpoint returns the
  **frozen settlement figures** (§3 D5) and marks `locked: true`; otherwise it
  derives live. Same contract either way — the client cannot tell live from
  frozen except by the `locked` flag.

`GET /api/commission/summary` response:

```jsonc
{
  "caliber": "realized",
  "currency": "RMB",
  "range": { "from": "2026-01-01", "to": "2026-03-31" },
  "tableId": "…",
  "locked": false,                 // true => figures read from a settlement snapshot
  "rows": [
    {
      "salespersonId": "…",
      "salespersonName": "张三",
      "basisBase": "128400.00",    // realized base revenue (matches the 1F-D report)
      "rateApplied": "5.0000",     // percent; resolved per §2.3
      "rateSource": "rule",        // rule | default | none
      "commissionBase": "6420.00", // round2(basisBase * rate%)
      "orderCount": 42,
      "unCostedCount": 1           // commissionable orders with NULL base, excluded
    }
  ],
  "totals": {
    "basisBase": "150250.00",
    "commissionBase": "7512.50",
    "orderCount": 57,
    "unCostedCount": 2
  }
}
```

`GET /api/commission/orders` response: same envelope, but `rows` are per-order
(`orderId`, `orderNumber`, `orderType` sales/purchase, `salespersonId`,
`amountBase`, `rateApplied`, `rateSource`, `commissionBase`, `status`), so the
summary is fully explainable down to each contributing order. `unCostedCount`
orders appear with `amountBase: null` and `commissionBase: "0.00"`, flagged, so
the gap is visible (§2.1).

- Amounts are decimal **strings** (precision preserved, never JS float).
- `rateApplied` is a percent string; `rateSource` exposes whether the rate came
  from a per-salesperson rule, the table default, or none (rate 0).

### 5.2 Rate table management (writes, audited)

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/commission/tables` | `commission_tables:view` | List the tenant's commission tables |
| `GET` | `/api/commission/tables/:id` | `commission_tables:view` | One table + its rate rules |
| `POST` | `/api/commission/tables` | `commission_tables:lock` | Create a commission table |
| `PATCH` | `/api/commission/tables/:id` | `commission_tables:lock` | Edit name / default rate |
| `PUT` | `/api/commission/tables/:id/rules` | `commission_tables:lock` | Replace the per-salesperson rate rules |

- Editing a table whose rates back a **locked** period is rejected with a typed
  `409` (`commission table is locked for a settled period`) — unlock first
  (§3 D3). *Rec: 409, not 403, since it is a state conflict not an authz failure.*
  [采纳]
- Rate rules are validated: `rate >= 0`, `salespersonId` is a tenant user, no
  duplicate salesperson per table (the `uq_…` constraint).
- Write permission reuses `commission_tables:lock` as the "manage commission
  config" capability (§7) rather than minting a new `:update` code — keeping the
  permission surface aligned with the already-seeded codes.

### 5.3 Lock / settle (privileged, audited)

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `POST` | `/api/commission/settlements` | `commission_tables:lock` | Lock (settle) a (table, period): snapshot rates + figures |
| `GET` | `/api/commission/settlements` | `commission_tables:view` | List settlements (locked/unlocked history) |
| `GET` | `/api/commission/settlements/:id` | `commission_tables:view` | One settlement + its frozen lines + explain payload |
| `POST` | `/api/commission/settlements/:id/unlock` | `commission_tables:unlock` | Unlock (supersede) a settlement, audited, with reason |

`POST /api/commission/settlements` body: `{ tableId, from, to, caliber? }`.
Behavior (§3 D3/D5):

- Takes `SELECT … FOR UPDATE` on the table row, derives the period figures, and
  writes one `commission_settlements` header + per-salesperson
  `commission_settlement_lines`, capturing the rate set + realized order ids +
  frozen base amounts into `snapshot`.
- **Idempotent:** locking an already-locked (table, period) returns the existing
  settlement (`200`), never double-settles (§3 D3).
- Returns the settlement as in `GET /settlements/:id`.

`POST /settlements/:id/unlock` body: `{ reason }` (reason required for the audit
trail). Appends a superseding `unlocked` settlement row (§4.2) — never an
in-place mutation — and audits the action.

### 5.4 Errors

- `400` — invalid/missing `from`/`to`, `from > to`, unknown enum, bad uuid.
- `401` — unauthenticated.
- `403` — lacks the required permission for the action.
- `404` — table/settlement not found in the caller's tenant/scope.
- `409` — editing a locked table, or other state conflicts.
- `dataScope` narrowing never yields a 403 by itself: an `own`-scoped caller
  silently sees only their own commission (smaller numbers / fewer rows),
  consistent with 1F-D and the order list endpoints.

---

## 6. Web / Frontend

This phase ships **read-only** commission pages only. The rate-table management
UI and the lock/unlock UI (write surfaces from §5.2 / §5.3) are deferred to a
later sub-phase — for now those endpoints are exercised by tests and, if needed,
by direct API calls. The frontend reads what the backend derives and never
recomputes commission client-side.

### 6.1 Routes & navigation

Two read-only views, both reachable from the existing left-nav (a single
**提成 (Commission)** entry that opens the summary page; the detail page is
navigated to from a row):

- `/commission` — **提成汇总 (Commission Summary)** — per-salesperson rollup.
- `/commission/orders` — **提成明细 (Commission Detail)** — per-order breakdown.

The nav link is added to `apps/web/src/components/AppLayout.tsx` and the routes to
`apps/web/src/App.tsx`, mirroring how the 报表 (reports) entry was wired in 1F-D.

### 6.2 提成汇总 — Commission Summary page

Calls `GET /api/commission/summary` (§5.1). Mirrors the reports page layout so
the two feel consistent:

- **Controls:** date range (`from` / `to`, default trailing 6 months like
  reports), caliber selector (default `realized`; pipeline / approved_up
  available but visibly labelled "not payable"), and a rate-table selector
  (`tableId`, defaults to the tenant's active table).
- **Table columns:** 业务员 (salespersonName), 计提基数 (basisBase, base
  currency), 提成率 (rateApplied, shown as a percent), 提成金额
  (commissionBase, base currency), 订单数 (orderCount), 未计价订单
  (unCostedCount).
- **Rate-source annotation:** when `rateSource` is `default` or `none`, the row
  is annotated (e.g. a "默认费率" / "无费率" tag) so a zero/fallback rate is never
  silently mistaken for a configured one.
- **Totals row:** sums `basisBase` and `commissionBase` across visible rows,
  echoing the backend `totals{}` envelope rather than re-summing client-side.
- **Locked-period banner:** when the response carries `locked: true`, a banner
  states the figures are a frozen settlement snapshot (with the lock date), so
  the user knows the numbers won't move even if underlying orders change.
- **Uncosted note:** a footnote surfaces `unCostedCount` (orders with NULL
  `total_amount_base`) — consistent with the reports caliber, these are excluded
  from the basis and flagged, never silently dropped.

### 6.3 提成明细 — Commission Detail page

Calls `GET /api/commission/orders` (§5.1). Per-order breakdown for explainability:

- **Controls:** same date range + caliber + `tableId`, plus an optional
  `salespersonId` filter (used when arriving from a summary row).
- **Columns:** 订单号 (orderNumber), 业务员 (salespersonName), 状态 (status),
  计提基数 (total_amount_base, base currency), 提成率 (rateApplied), 提成金额
  (per-order `commissionBase`), 计提口径 (caliber the order fell under).
- Orders with NULL base are listed but visibly marked 未计价 with no commission,
  matching the summary's uncosted handling.
- Amounts render exactly as the decimal strings the API returns (no client-side
  float math).

### 6.4 Permissions & graceful 403 fallback

Both pages are gated server-side by `commission_tables:view` (§5.1). The
frontend follows the **same 403 convention established by the 1F-D reports
page**: a user lacking the permission sees a graceful fallback message
(e.g. "没有权限查看提成") instead of an error screen or a blank table. UI hiding
is cosmetic only — the authoritative gate is the backend permission check; the
page degrades cleanly whether or not the nav link is shown.

### 6.5 Base-currency display & no client-side computation

All monetary figures are shown in the tenant **base currency** (the
`total_amount_base` caliber from 1F-B), labelled with the `currency` field from
the response envelope. The frontend performs **no commission arithmetic** — rate
application, rounding, and rollups all come from the backend; the page only
formats and lays out what it receives. This keeps a single source of truth and
avoids client/server drift.

### 6.6 API client & types

`apps/web/src/lib/api-client.ts` gains `commissionSummary(...)` and
`commissionOrders(...)` methods (query-string helpers like the reports
`reportQs`), and `apps/web/src/lib/types.ts` gains the matching
`CommissionSummary` / `CommissionOrders` response types — following the 1F-D
reports pattern.

---

## 7. Audit & Security

Commission touches money attribution, so the security posture follows the
trust-first rules in CLAUDE.md: reads never enter the audit chain, every **write**
(lock / unlock / rate-table change) is auditable, snapshots are immutable at the
database-grant level, and dataScope is pushed into aggregation so a narrower
scope can never escalate.

### 7.1 Audit events (writes only)

Read endpoints (`GET /summary`, `/orders`, `/tables`, `/settlements`) write **no
audit rows** — consistent with the 1F-D reports caliber (reads are not audited).
Only state-changing operations append to the audit chain, each carrying
`actorId`, `actorType`, `tenantId`, `resourceType`, `resourceId`, and a
before/after payload where applicable:

| Event | Trigger | Key payload |
| --- | --- | --- |
| `commission_table.created` | POST /tables | new table id, name, default_rate |
| `commission_table.updated` | PATCH /tables/:id | before/after of changed fields |
| `commission_rules.replaced` | PUT /tables/:id/rules | before/after full rule set |
| `commission.locked` | POST /settlements | settlement id, period, caliber, totals, snapshot digest |
| `commission.unlocked` | POST /settlements/:id/unlock | superseded settlement id, **required reason**, who/when |

Notes:
- The unlock audit row records the **reason** (required by §5.3) and the id of the
  superseding settlement, so the full lock→unlock→relock history is reconstructable
  from the chain plus the append-only settlement rows.
- Rate-table writes capture before/after so a rate change that shifts future
  commission is attributable to an actor and timestamp.
- Audit rows reuse the existing append-only hash-chain audit table (Phase 0);
  this phase adds no new audit infrastructure, only new event types.

### 7.2 Immutable lock snapshots

`commission_settlements` and `commission_settlement_lines` are **append-only at
the grant level** (§4): `GRANT SELECT, INSERT` then `REVOKE UPDATE, DELETE FROM
kirindesk_app`. Consequences:

- A locked settlement's figures **cannot be edited or deleted** by normal
  application logic — the snapshot of rates + computed commission + basis is a
  permanent record of "what was settled, under which rates, for which period."
- **Unlock is a superseding append, not an in-place mutation** (§3 D4 / §4): the
  original locked row stays; a new row marks the period unlocked, referencing the
  superseded id. History is never rewritten.
- Corrections (refunds / cancellations after lock) flow as **reversing entries in
  the current open period** (§3 D6), never as edits to locked history — so the
  immutable snapshot stays a faithful as-of record.
- The snapshot is self-contained: it stores the rate set actually applied and the
  per-salesperson figures, so re-deriving is never required to explain a locked
  period even if rate tables or order calibers change afterward.

### 7.3 dataScope & tenant isolation (anti-escalation)

- **Tenant isolation** is enforced by PostgreSQL RLS on all four commission
  tables (§4): every query runs inside `withTenantContext(...)`, and
  `tenant_isolation_policy` (via `app_current_tenant_id()`) makes cross-tenant
  reads/writes structurally impossible — the same pattern as orders/files.
- **dataScope is pushed into the aggregation WHERE clause, before GROUP BY** —
  identical to the 1F-D reports anti-escalation rule. A salesperson with `own`
  scope sees only commission derived from `owner_user_id = $self` orders; the
  restriction filters the basis rows *before* they are summed, never masks an
  already-computed total. `all` scope sees the full tenant rollup; `assigned`
  scope is filtered to the assigned set. There is no "compute everything then
  hide rows" path.
- **dataScope narrowing never yields 403 by itself** (§5.4): a narrower scope
  returns fewer/zero rows, not an authorization error. 403 is reserved for
  missing the `commission_tables:view` / `:lock` / `:unlock` permission.
- **Server-side authority:** rate application, caliber selection, and rollups are
  all computed server-side; the frontend cannot influence which orders count or
  which rate applies. UI hiding is cosmetic — the permission + dataScope checks
  on the backend are authoritative (CLAUDE.md §4).
- **Lock concurrency safety:** `POST /settlements` takes `SELECT … FOR UPDATE` on
  the period row (§3 D3) so two concurrent lock attempts cannot produce divergent
  snapshots; the operation is idempotent (re-locking an already-locked period
  returns the existing snapshot rather than appending a second one).

---

## 8. Testing & Quality Gate

Testing follows the 1F-D pattern: integration tests against a real PostgreSQL with
RLS enforced (no mocking the DB for isolation tests), plus targeted unit tests for
the money math. The phase is not done until `pnpm verify` is fully green.

### 8.1 Money math — BigInt, zero float drift

- **Per-order round-then-sum:** `commission(order) = round2(total_amount_base ×
  rate)` is computed per order in integer cents via the shared BigInt helper
  (the `order-money.ts` pattern), then summed — proving the documented caliber
  (§2) and that results are deterministic and idempotent (§3 D2).
- **No float anywhere:** assert that a basis like `0.10 + 0.20` style accumulation
  and rate application (`numeric(7,4)` percent) never produces `…0000001`
  artifacts; totals equal the exact decimal-string expectation.
- **Rounding boundary:** half-cent cases (e.g. `× rate` landing on `x.005`) round
  consistently with the documented rule, and the rounded per-order figures sum to
  the reported total (sum-of-rounded == reported total, no re-rounding the sum).
- **Rate sources:** rule rate vs `default_rate` vs no-rate (0 + `rateSource:none`
  flag) each produce the expected commission; a `none` rate yields 0, never a
  silent NULL or a crash.

### 8.2 Immutable lock snapshots

- **Grant-level immutability:** attempting `UPDATE` / `DELETE` on
  `commission_settlements` / `commission_settlement_lines` as `kirindesk_app`
  fails (REVOKE in §4) — verified by a test that expects the operation to be
  rejected, not silently succeed.
- **Lock freezes figures:** after lock, changing an underlying order's
  status/amount does **not** move the locked period's reported numbers; the
  frozen snapshot is returned with `locked: true` (§3 D4, §5.1).
- **Unlock is superseding append:** unlock leaves the original locked row intact
  and appends a superseding row referencing it; the lock→unlock history is fully
  reconstructable (§4, §7.2). No in-place mutation occurs.
- **Reversing entries, not edits:** a post-lock refund/cancellation is modelled as
  a reversing entry in the current open period (§3 D6); locked history is
  untouched.

### 8.3 dataScope & tenant isolation (anti-escalation)

- **Scope pushed before GROUP BY:** an `own`-scope user's summary/detail reflects
  only `owner_user_id = $self` orders — the basis is filtered before aggregation,
  never masked after (§7.3). `all` sees the full rollup; `assigned` sees the
  assigned set.
- **No mask-after-aggregate path:** a test asserts the `own`-scope total equals a
  fresh sum over only that user's orders (not the full total with rows hidden).
- **Cross-tenant impossible:** with RLS active, a query under tenant A returns
  zero of tenant B's commission rows; writes (lock) under A cannot touch B.
- **Narrowing ≠ 403:** an `own`-scope user with `commission_tables:view` gets a
  (possibly empty) result, **not** 403; 403 is reserved for the missing
  permission (§5.4). A user lacking `commission_tables:view` gets 403.

### 8.4 Concurrent locking

- **Two concurrent locks:** simultaneous `POST /settlements` for the same period
  do not produce two divergent snapshots — `SELECT … FOR UPDATE` serialises them
  (§3 D3); one wins, the other observes the locked state.
- **Idempotent re-lock:** re-locking an already-locked period returns the existing
  snapshot rather than appending a second settlement row.

### 8.5 API contract & permissions

- Read endpoints return the documented envelope (caliber, currency, range,
  tableId, locked, rows[], totals{}) with amounts as decimal strings.
- Permission gating: `commission_tables:view` for reads, `:lock` / `:unlock` for
  writes; rate-table writes on a locked period → 409 (§5.2).
- Error contract: 400 (bad params) / 401 (unauth) / 403 (missing perm) / 404
  (unknown id) / 409 (locked-period conflict, duplicate lock) per §5.4.
- Reads write **no audit rows**; lock/unlock/rate-changes **do** append the
  documented audit events (§7.1) — assert chain entries exist for writes and are
  absent for reads.

### 8.6 Quality gate — `pnpm verify` fully green

The phase is complete only when the full gate passes, matching prior phases:

- `lint` — ESLint clean
- `format` — Prettier clean (run `prettier --write` to fix, then re-verify)
- `typecheck` — no TS errors
- `build` — API + web build succeed
- `unit` — money-math + helper unit tests pass
- `integration` — commission integration suite passes alongside the existing
  suites (count increases from the current 154 baseline)
- `security` — RLS / isolation security suite passes (13 baseline), with the new
  commission immutability + dataScope assertions included

No commit until every stage above is green; if a stage fails, report the exact
failure and the smallest safe fix before proceeding.

---

## 9. Migration & Rollout

### 9.1 Migration file & numbering

One new migration: **`db/migrations/033_commission.sql`**. The current highest is
`032_order_approvals.sql`, so `033` is the next free number and does **not**
collide with `031_finance_exchange_rate.sql` / `032`. It follows the exact UP/DOWN
single-file convention used by 030–032 (a `-- UP` section, then a `-- DOWN`
section in reverse order).

The migration creates all four tables from §4 in one file (they share a
lifecycle, and `commission_settlements` carries a hard FK to `commission_tables`,
so they belong in one ordered migration):

1. `commission_tables` — mutable rate model.
2. `commission_rate_rules` — mutable per-salesperson overrides (FK →
   `commission_tables` `ON DELETE CASCADE`).
3. `commission_settlements` — immutable append-only header.
4. `commission_settlement_lines` — immutable append-only detail (FK →
   `commission_settlements` `ON DELETE CASCADE`).

No changes to existing tables, no order-status enum widening, no backfill — this
is purely additive (unlike 032). No new permission seeds are required (§10.1:
`commission_tables:view/lock/unlock` already seeded).

### 9.2 UP — application order

Within `033_commission.sql`, statements run top-to-bottom:

1. `CREATE TABLE commission_tables` (+ CHECK constraints from §4.1).
2. `CREATE TABLE commission_rate_rules` (+ UNIQUE + CHECK + FK CASCADE).
3. `CREATE TABLE commission_settlements` (+ CHECK; no plain UNIQUE on
   (tenant, table, period) — currentness is service-enforced, §4.2).
4. `CREATE TABLE commission_settlement_lines` (+ UNIQUE + CHECK + FK CASCADE).
5. Indexes (§4): `idx_commission_tables_tenant`,
   `idx_commission_rate_rules_tenant`, `idx_commission_rate_rules_person`,
   plus the settlement lookup indexes (tenant-leading composites).
6. **RLS** on all four: `ENABLE` + `FORCE ROW LEVEL SECURITY` and
   `CREATE POLICY tenant_isolation_policy … USING (tenant_id =
   app_current_tenant_id()) WITH CHECK (…)` — identical to 032.
7. **Grants**:
   - Mutable pair: `GRANT SELECT, INSERT, UPDATE, DELETE ON commission_tables,
     commission_rate_rules TO kirindesk_app;`
   - Immutable pair: `GRANT SELECT, INSERT ON commission_settlements,
     commission_settlement_lines TO kirindesk_app;` then `REVOKE UPDATE, DELETE
     … FROM kirindesk_app;` — the append-only enforcement (the `000_app_role.sql`
     default grants UPDATE/DELETE on every new table, so the REVOKE is required,
     same as 032).

FK dependency dictates the order: parents (`commission_tables`,
`commission_settlements`) before children (`commission_rate_rules`,
`commission_settlement_lines`).

### 9.3 DOWN — reversible rollback

The `-- DOWN` section drops in **reverse dependency order** so no FK blocks the
drop. Because the migration is purely additive (no altered columns, no coerced
data), the down is a clean, deterministic reversal with no data-coercion step
(unlike 032's status-coercion):

```
DROP TABLE IF EXISTS commission_settlement_lines;
DROP TABLE IF EXISTS commission_settlements;
DROP TABLE IF EXISTS commission_rate_rules;
DROP TABLE IF EXISTS commission_tables;
```

Children before parents; `ON DELETE CASCADE` FKs are dropped with their tables.
RLS policies and grants are dropped implicitly with the tables. Rolling back
removes all commission rate models and lock snapshots for the environment — safe
in dev; in any shared/staged environment this is a destructive data loss and must
be confirmed before running (CLAUDE.md §5).

### 9.4 Rollout steps

1. **Confirm gate (no migration without approval):** the migration is written and
   run only after this plan is approved (CLAUDE.md §5 / §10 current-phase rule).
2. **Apply UP locally** against the dev PostgreSQL via the project's migration
   runner; verify the four tables, indexes, RLS policies, and grants exist
   (`\d+` + a privilege check that UPDATE/DELETE are absent on the immutable
   pair).
3. **No seed change** — confirm `commission_tables:view/lock/unlock` are already
   granted to Dev Admin (existing seed); no new seed migration.
4. **Backend then frontend** (per phase discipline): land the commission module
   (service + controller + DTOs), run `pnpm verify` to green (§8.6), commit;
   then the read-only pages, re-verify, commit.
5. **Verify DOWN** in dev once (apply → rollback → re-apply) to prove the down is
   reversible before the phase is considered done.
6. **Commit discipline:** explicit `git add` of the migration + module + plan
   doc; never `git add .`; no `.env`/`dist`/logs; push to `origin/main` only after
   the full gate is green.

---

## 10. Open Questions & Risks

All open points are resolved by adopting the recommended option (marked
`[采纳推荐: …]`) per the standing instruction. Each risk is listed with its
mitigation.

### 10.1 Resolved open questions (recommendations adopted)

- **Commission basis currency** — `[采纳推荐: 本位币 total_amount_base]`. Commission
  is derived on the base-currency caliber (1F-B), not original currency, so a
  single tenant rollup is currency-consistent. Original-currency reporting is
  out of scope this phase.
- **Granularity** — `[采纳推荐: 订单头 header-level]`. Commission is computed on the
  order's `total_amount_base`, not per line item. Line-item-level commission is
  deferred (§2 out-of-scope).
- **Default caliber** — `[采纳推荐: realized = confirmed + completed]`. Inherited
  verbatim from 1F-D; cancelled never counts; pipeline / approved_up are
  selectable but labelled "not payable."
- **Rate resolution order** — `[采纳推荐: per-salesperson rule → default_rate →
  0-with-flag]`. A missing rate yields commission 0 with `rateSource: none`, never
  an error or a silent NULL.
- **Rate units** — `[采纳推荐: numeric(7,4) percent]` (e.g. `5.0000` = 5%). Enough
  precision for fractional-percent schemes without float.
- **Persistence model** — `[采纳推荐: on-demand derivation + lock snapshot only]`.
  Only the rate model and lock snapshots are persisted (§3 D1); unlocked periods
  recompute on read. No materialized views this phase.
- **Unlock semantics** — `[采纳推荐: superseding append, not in-place UPDATE]`
  (§4, §7.2). Reason required on unlock.
- **Refund / cancellation after lock** — `[采纳推荐: reversing entries in the
  current open period]` (§3 D6); locked history never edited.
- **No hard FK to orders** — `[采纳推荐: order ids stored in snapshot jsonb]`. Keeps
  the immutable settlement decoupled from later order mutation/soft-delete; the
  snapshot is the as-of record.
- **Management UI scope** — `[采纳推荐: read-only pages this phase; rate-table &
  lock/unlock UI deferred]` (§6). Write endpoints exist and are tested; the UI for
  them lands in a later sub-phase.
- **Permission mapping** — `[采纳推荐: reuse existing seeds]`:
  `commission_tables:view` for reads, `commission_tables:lock` for rate-table
  management + lock, `commission_tables:unlock` for unlock. No new permission
  seeds required.

### 10.2 Risks & mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Rate change retroactively shifts unlocked periods** | An edit to a rate table moves commission for any not-yet-locked period | Unlocked = explicitly recomputed on read (§3 D4); lock the period to freeze figures before they are treated as final; rate changes are audited (§7.1) so shifts are attributable |
| **Stale rate inside a locked snapshot** | A locked period keeps an old rate even after the table is corrected | By design — the snapshot is the as-of record (§7.2). To restate, unlock (superseding append, reason required) and relock; history is preserved, not overwritten |
| **NULL `total_amount_base` (uncosted orders)** | Orders without a base amount silently drop from the basis | Excluded from basis **and surfaced** as `unCostedCount` in summary + flagged 未计价 in detail (§6.2/§6.3), mirroring the 1F-D caliber — never silently dropped |
| **dataScope mask-after-aggregate escalation** | A narrow-scope user could see tenant-wide totals if scope were applied post-aggregation | Scope pushed into WHERE before GROUP BY (§7.3); tested by asserting own-scope total == fresh sum over own orders only (§8.3) |
| **Concurrent lock divergence** | Two simultaneous locks create conflicting snapshots | `SELECT … FOR UPDATE` on the period row + idempotent re-lock (§3 D3, §8.4) |
| **Float drift in money math** | Rounding artifacts in commission totals | BigInt integer-cents, round-per-order-then-sum, decimal-string serialization (§8.1) |
| **Caliber drift from 1F-D** | Commission caliber diverging from reports revenue caliber confuses reconciliation | Caliber inherited verbatim from 1F-D (realized = confirmed + completed); not re-defined here (§2) |
| **Cross-tenant leakage** | Commission rows leaking across tenants | RLS on all four tables, every query inside `withTenantContext`; security suite asserts zero cross-tenant rows (§7.3, §8.3) |
| **Misread fallback rate** | A 0/default rate mistaken for a configured one | `rateSource` flag (`rule` / `default` / `none`) annotated in the UI (§6.2) |
| **Orphan/duplicate settlement rows** | Append-only model could accumulate rows | Idempotent lock returns existing snapshot rather than appending; unlock references the superseded id so the chain is linear and reconstructable (§8.4) |

### 10.3 Deferred (explicitly out of scope this phase)

Payout execution, tiered/graduated commission schemes, commission on
non-realized orders as payable, line-item-level commission, manual per-order
overrides, an approval workflow for commission tables, cross-tenant commission,
and export — all deferred to later sub-phases (§1 out-of-scope). The
management/lock UI is deferred to a follow-up sub-phase (§6, §10.1).
