# Phase 1F-B — Finance / Exchange Rate (Planning)

Status: **planning** — gate document. No code, no migration until this scope is approved.

Builds on Phase 1F-A (order line items + server-derived `total_amount` in original
currency). See `docs/phase-1f-a-order-line-items-plan.md`.

---

## 1. Goals & Scope

### Problem

Orders today carry a `currency` (RMB / USD / HKD / EUR) and a `total_amount`
**derived in that original currency** (Σ line_total). There is no way to:

- express any order's value in a single **base/reporting currency** (本位币) for
  cross-currency comparison, totals, or reporting;
- record the **exchange rate** that was effective for an order, so a historical
  order keeps the rate it was transacted at rather than drifting with today's rate;
- compute **profit / margin** by comparing a sales order's base-currency value
  against the matching procurement cost in the same base currency.

### In scope (this phase)

- A tenant-level **base currency** setting (default RMB), used as the reporting unit.
- An **exchange-rate snapshot per order**: the rate from the order's original
  currency to the tenant base currency, captured at create/confirm time and frozen
  on the order so historical value is stable.
- A server-derived **base-currency total** (`total_amount_base`) on each order,
  computed as `total_amount × rate`, rounded with the same BigInt-integer money
  discipline as Phase 1F-A (no floating point). Never client-supplied.
- An exchange-rate **source abstraction** (provider interface) with a manual /
  mock implementation for local dev, mirroring the Phase 1E storage-provider pattern.
- Read/echo of rate + base total in order detail and the web order forms (rate
  visible, base total read-only derived).

### Out of scope (deferred)

- Live FX feeds (real bank/market rate APIs) — provider interface only; real
  providers need approval per CLAUDE.md external-service rule.
- Profit/margin **reporting screens / dashboards** — the base-currency figure is
  the enabler; aggregate reporting is its own later phase.
- Multi-leg / triangulated conversion beyond a single original→base rate.
- Revaluation of open orders as rates move (we freeze the snapshot; no mark-to-market).
- Rounding/precision policy changes to the existing original-currency `total_amount`.

### Open questions (to resolve before exit)

- ~~Does base currency belong on `tenants` or a dedicated `tenant_settings` table?~~
  **Resolved:** reuse the existing KV `tenant_settings` table (key `base_currency`).
- When exactly is the rate frozen — at create, or at first transition out of draft?
- Precision of the stored rate and of `total_amount_base`.

---

## 2. Core Design Decisions

Each decision states the choice and the rationale. These are the load-bearing
calls; remaining sections are placeholders.

### D1. Original currency + amount stays as-is (unchanged from 1F-A)

Orders keep `currency` + `total_amount` in the **original transaction currency**,
derived from line items exactly as today. Phase 1F-B adds base-currency figures
**alongside** these, never replacing them.

**Recommendation:** Keep. The original-currency total is the contractual truth;
base currency is a derived reporting overlay. No change to 1F-A behavior or tests.

### D2. Rate granularity — order-level snapshot, not line-level

Store **one exchange rate per order** (original→base), not one per line item.

**Recommendation:** **Order-level.** An order transacts in a single currency, so
every line shares the same original→base rate; a line-level rate would be redundant
and invite inconsistency. Base value per line, if ever needed for reporting, is
derivable as `line_total × order.rate`. Line-level rates would only matter if a
single order mixed currencies — explicitly out of scope. Simpler model, fewer
columns, one rate to freeze.

### D3. Rate is a frozen snapshot on the order, not a live lookup

Persist the rate **on the order row** (e.g. `fx_rate`, plus `fx_rate_source` and a
captured-at timestamp). Base total is computed from that frozen rate, not by joining
to a live rate table at read time.

**Recommendation:** **Frozen snapshot.** Historical orders must not change value when
rates move; reproducibility and auditability require the rate that was actually used
to live on the order. A live-join model would silently rewrite history. This mirrors
how 1F-A froze `line_total` rather than recomputing on read.

### D4. Rate source — provider abstraction, manual/mock implementation this phase

Define an `ExchangeRateProvider` interface (`getRate(from, to, asOf) → rate`) with a
**manual/mock provider** for now: the rate is either entered by the user on the order
form or returned by a seeded mock table. Real FX feeds slot in behind the same
interface in a later phase.

**Recommendation:** **Provider interface + manual entry as the default
implementation**, with the user-entered rate validated and stored. This matches the
Phase 1E storage-provider precedent, honors the CLAUDE.md rule against wiring real
external services without approval, and keeps local dev fully offline. The form
pre-fills from the mock provider when available but the user can override; the
override is what gets frozen (D3).

### D5. Binding base total to the 1F-A derived total

`total_amount_base = round2(total_amount × fx_rate)` computed **server-side** in the
same transaction that derives `total_amount`, using BigInt integer scaling (shared
money helper from 1F-A, extended for the rate multiply). It is never accepted from
the client; the web form shows it read-only, just like `total_amount`.

**Recommendation:** **Derive `total_amount_base` server-side from the frozen rate and
the already-derived `total_amount`.** Single source of truth, identical no-float
discipline, and the read-only-derived UX already proven in 1F-A QA. The rate multiply
needs a defined precision (see D2/open questions) — stored rate precision and base
rounding to 2 dp to be pinned in the data-model section. Profit/margin then becomes a
later comparison of sales vs. purchase `total_amount_base` in a common base currency.

---

## 3. Data Model

### 3.1 Table inventory

**No new tables.** Phase 1F-B reuses two foundation tables already created in
Phase 0 and only adds **column additions** to the two order tables. FX is
order-level (D2).

> **Correction (post-planning):** the original plan proposed a new dedicated
> `tenant_settings` table and a new exchange-rate provider table. Both already
> exist from Phase 0 — `014_tenant_settings.sql` (a generic key-value config
> table) and `019_exchange_rates.sql`. The design now reuses both rather than
> colliding with them. See revised D-decisions and §5.

#### Reused: `tenant_settings` (existing KV table, 014)

Existing shape: `id / tenant_id / key varchar(100) / value_json jsonb /
updated_by / UNIQUE (tenant_id, key)`, already RLS-enabled + force + isolation
policy (021).

Base currency is stored as a **row** here, not a new column/table:

| Field | Value |
|---|---|
| `key` | `'base_currency'` |
| `value_json` | a JSON scalar string, e.g. `"RMB"` (read via `value_json #>> '{}'`) |

**Default when absent:** no row ⇒ base currency defaults to `RMB`. The service
layer upserts this row when a tenant sets its base currency; tenant provisioning
may seed it, but absence is safe.

**Recommendation:** reuse the KV `tenant_settings` table. It exists precisely for
per-tenant config, is already under RLS, and avoids a second same-named table.
A `base_currency` allowlist is enforced in the service layer (the KV table has no
per-key CHECK).

#### Changed: `sales_orders` and `purchase_orders` (identical additions to both)

| Column | Type | Notes |
|---|---|---|
| `fx_rate` | `numeric(18,8)` | Original→base rate, frozen snapshot (D3). NULL until captured. |
| `fx_rate_source` | `text` | e.g. `manual` / `mock`; CHECK against an allowlist; NULL until captured. |
| `fx_captured_at` | `timestamptz` | When the rate was frozen. NULL until captured. |
| `total_amount_base` | `numeric(18,2)` | Derived = `round2(total_amount × fx_rate)`, server-only (D5). NULL until captured. |

### 3.2 Precision & money discipline

- **Amounts** (`total_amount`, `total_amount_base`): `numeric(18,2)` — consistent
  with existing `total_amount` and line `line_total`. Base total rounded to 2 dp,
  round-half-up, via the BigInt-integer helper (no float).
- **Rate** (`fx_rate`): `numeric(18,8)` — 8 dp accommodates small-unit currencies and
  inverse rates without meaningful truncation. **[待确认]** 8 dp vs 6 dp; 8 is safer,
  costs nothing at this scale.
- **CHECK constraints:** `fx_rate > 0` when present; `base_currency`/`fx_rate_source`
  against allowlists; `total_amount_base >= 0`. When original currency == base
  currency, `fx_rate` must be exactly `1` (enforced in service; **[待确认]** whether
  to also assert via constraint).
- **Nullability:** all four order FX columns are **nullable** so that drafts and
  pre-existing/historical header-only orders remain valid before a rate is captured.
  Non-draft + captured state consistency is enforced in the service layer, mirroring
  the 1F-A "non-draft requires ≥1 line" rule. **[待确认]** whether confirmed orders
  must have a non-null `fx_rate` (recommended yes).

### 3.3 tenant_id usage

- The KV `tenant_settings` already carries `tenant_id` (RLS key); the
  `base_currency` row is just one more `(tenant_id, key)` entry. No schema change.
- `exchange_rates` already carries `tenant_id`; the provider reads it under tenant
  context. No schema change.
- Order FX columns add **no** new `tenant_id` (the order row already carries it).
- All FX reads/writes occur within the existing `withTenantContext` transaction, so
  `app.current_tenant_id` is set and RLS applies uniformly — no cross-tenant rate or
  settings leakage.

### 3.4 RLS strategy

- **`tenant_settings` / `exchange_rates`:** already RLS-enabled + force +
  `tenant_isolation_policy` (USING + WITH CHECK) from `021_rls_policies.sql`, and
  already granted to `kirindesk_app`. **No RLS or GRANT changes in 031** — reusing
  them means inheriting the existing, verified isolation.
- **`sales_orders`/`purchase_orders`:** unchanged — new columns inherit the existing
  table policies. No policy edits needed.

**Recommendation:** add nothing to RLS in this migration; rely on the foundation
policies already in place and covered by the security regression.

### 3.5 Indexes

- `tenant_settings` / `exchange_rates`: existing indexes (KV unique on
  `(tenant_id, key)`; exchange_rates unique on
  `(tenant_id, base_currency, quote_currency, year_month)` + tenant/year_month
  indexes) are sufficient. No additions.
- Order tables: **no new index required** for correctness. A reporting index on
  `(tenant_id, fx_captured_at)` or on `base_currency` is **deferred** to the reporting
  phase that actually queries by them — adding it now would be speculative. Confirmed
  no base-currency filter/sort ships in 1F-B.

### 3.6 Soft delete

- `tenant_settings` / `exchange_rates`: reused as-is; the `base_currency` row is
  update-only (upsert on `(tenant_id, key)`), exchange-rate rows follow their existing
  semantics. No `deleted_at` involvement.
- Order FX columns: governed by the orders' existing `deleted_at`; nothing new.

**Recommendation:** upsert the `base_currency` KV row when a tenant sets it; absence
defaults to RMB, so no provisioning backfill is strictly required (031 backfills only
the same-currency orders, reading base currency with an RMB fallback).

## 4. API Design

_Placeholder — request/response shape changes, where the rate is supplied/frozen,
derivation point in the service, validation rules._

## 5. Exchange Rate Provider

Reuses the existing **`exchange_rates`** table (`019_exchange_rates.sql`):
`tenant_id / base_currency / quote_currency / rate numeric(18,8) / year_month /
source ('manual' default) / UNIQUE (tenant_id, base_currency, quote_currency,
year_month)`. No new table.

- **Interface:** `ExchangeRateProvider.getRate(base, quote, yearMonth) → rate | null`,
  reading `exchange_rates` under tenant context. The order's original currency is the
  `quote_currency`, the tenant base currency is `base_currency`; `year_month` derives
  from the order date (the table is already keyed by month).
- **Default implementation (this phase):** a DB-backed provider over `exchange_rates`
  plus **manual entry** on the order form — if a rate row exists for the period it
  pre-fills; the user may override, and the overridden value is what gets frozen on the
  order (D3). Same-currency needs no lookup (rate = 1).
- **Source tagging:** the order's frozen `fx_rate_source` records `manual` (user-typed)
  or `mock` (seeded/looked-up), or `system` for the same-currency backfill. The
  `exchange_rates.source` column is independent metadata on the rate row itself.
- **Future real providers** (bank/market feeds) slot in behind the same interface and
  populate `exchange_rates`; they need approval per the CLAUDE.md external-service rule
  and are out of scope here.

**Recommendation:** DB-backed provider over the existing `exchange_rates` table with
manual override; do not introduce a parallel rate store.

## 6. Web / Frontend

_Placeholder — rate input + read-only base total on order forms, detail echo._

## 7. Audit & Security

### 7.1 Audit requirements

- Reuse the existing append-only, hash-chained `audit_logs` (app role has INSERT only;
  UPDATE/DELETE denied — already enforced and covered by security regression).
- **Order actions:** the existing `*.created` / `*.updated` snapshots must include the
  new FX fields (`fx_rate`, `fx_rate_source`, `fx_captured_at`, `total_amount_base`) in
  both before/after, so a rate change is auditable. This falls out naturally if the
  snapshot serializes the full response object (as 1F-A does) — **[待确认]** confirm the
  response DTO includes FX fields so they enter the snapshot automatically.
- **New action:** a base-currency-change audit entry when the `base_currency` KV row
  is upserted, with before/after. **[待确认]** action-name convention and resource_type
  string (the resource is the tenant settings row).
- Changing base currency does **not** retroactively rewrite frozen order rates (D3);
  the audit trail makes the settings change explicit instead.

### 7.2 Security

- No new external network calls this phase (manual/mock provider only) — consistent
  with the CLAUDE.md rule on external services.
- Same no-float money discipline (BigInt integer scaling) for the rate multiply, to
  avoid precision/round-trip bugs that could misstate financial value.
- `total_amount_base` and `fx_rate` (when sourced from provider) are server-derived /
  server-validated; the client cannot fabricate base value. A client-supplied manual
  rate is validated (`> 0`, precision bounds) before being frozen.
- RLS + tenant context as in §3.4; no cross-tenant rate or settings exposure.

## 8. Testing & Quality Gate

### 8.1 Coverage to add

- **Rate freeze:** capturing a rate stores `fx_rate`/`source`/`captured_at`; a later
  base-currency change to the tenant does not alter the already-frozen order.
- **Base derivation:** `total_amount_base == round2(total_amount × fx_rate)` across
  representative values; round-half-up boundary cases; original==base ⇒ rate 1 and
  base==total.
- **Precision edges:** large amounts, 8-dp rates, rounding at the 0.005 boundary.
- **Nullability/state:** draft with no rate is valid; **[待确认]** confirmed order
  rate-required rule (if adopted) returns 400 when missing.
- **Isolation:** tenant A cannot read/update tenant B's `base_currency` KV row or
  `exchange_rates` (existing RLS); cross-tenant order rate not visible.
- **Audit/chain:** FX fields present in snapshots; `verifyChain` still green after
  FX activity; base-currency change recorded.

### 8.2 Quality gate

- Full `pnpm verify` green (lint / format / typecheck / build / unit / integration /
  security). Integration count expected to rise from 154.
- Browser QA (Playwright, as in 1F-A): rate entry → base total auto-computes read-only
  → save → detail echo → base-currency setting reflected. **[待确认]** exact QA matrix
  finalized in §6.

## 9. Migration & Rollout

### 9.1 Forward migration (next number after 030 → **031**) — implemented

`031_finance_exchange_rate.sql` reuses existing tables and only:

1. Adds the four nullable FX columns + CHECK constraints to `sales_orders` and
   `purchase_orders`. Nullable ⇒ no table-rewrite blocking, existing rows stay valid.
2. **Backfill:** for orders whose `currency` equals the tenant base currency (read
   from KV `tenant_settings` key `base_currency`, default RMB), freeze `fx_rate=1`,
   `fx_rate_source='system'`, `fx_captured_at=now()`, `total_amount_base=total_amount`.
   Cross-currency historical orders are left NULL (no invented rates).

No `tenant_settings` / `exchange_rates` creation, no RLS/GRANT statements (those tables
already exist with RLS from 014/019/021). No settings-row backfill is needed because
base currency defaults to RMB when absent.

### 9.2 Rollback (down migration)

- `031` DOWN: drop the four FX columns from both order tables (constraints drop with
  them). Foundation tables `tenant_settings` / `exchange_rates` are **not** touched.
  Forward is additive-only (columns + same-currency backfill), so down is a clean
  structural revert losing only the FX columns/data (acceptable for an unreleased phase).
- Follows the repo's paired `-- UP` / `-- DOWN` convention (028/029/030).

### 9.3 Verification commands

```
pnpm db:migrate                 # apply 031 against dev DB
pnpm db:rollback                # exercise 031 down, confirm clean revert
pnpm db:migrate                 # re-apply, confirm idempotent/repeatable
pnpm db:verify-chain            # audit hash chain intact
pnpm verify                     # full gate (lint/format/typecheck/build/unit/integration/security)
```

Plus a direct RLS spot-check on the reused tables under no/wrong/right tenant context
(the existing `021` policies already cover this; integration suite asserts it).

## 10. Open Questions & Risks

Consolidated remaining items for sign-off before implementation:

- ~~**Settings location**~~ — **resolved:** reuse KV `tenant_settings` (key
  `base_currency`).
- ~~**Rate source / new table**~~ — **resolved:** reuse existing `exchange_rates`.
- **Freeze timing:** capture rate at create vs at first transition out of draft;
  whether confirmed orders must have a non-null `fx_rate` (recommended yes).
- **Rate precision:** `numeric(18,8)` (recommended) vs `(18,6)`.
- **Same-currency rule:** enforce `fx_rate=1` via constraint vs service-only.
- **Backfill policy:** leave historical FX NULL except same-currency orders
  (recommended) vs full NULL.
- **Settings row creation:** at tenant provisioning (recommended) vs lazy-on-read.
- **Reporting index:** confirm none needed in 1F-B (deferred to reporting phase).
- **Audit specifics:** `tenant_settings.updated` action/resource_type naming; confirm
  FX fields flow into order snapshots via the response DTO.

### Risks

- **Precision/rounding** misstatement of financial value — mitigated by reusing the
  proven BigInt money helper and explicit boundary tests.
- **Frozen-vs-live confusion** — a user may expect base totals to track current rates;
  D3 freezes them by design. Surface the captured-at timestamp in UI to make this clear.
- **Scope creep into reporting** — base currency invites dashboards; hold the line,
  this phase only produces the per-order base figure.
