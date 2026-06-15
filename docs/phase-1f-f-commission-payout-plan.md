# Phase 1F-F — Commission Payout / Disbursement (Planning)

> Status: **Planning only.** No migration, no code, no commit until this plan is
> reviewed and approved. Mirrors the structure of
> `phase-1f-e-commission-plan.md` and `phase-1f-d-reports-plan.md`.
>
> Builds directly on completed work:
> - **1F-E** — commission calculation, rate tables, and the lock/settle snapshot.
>   A *locked* `commission_settlement` is the immutable, agreed statement of
>   commission owed for a (table, period, caliber). This phase is the next step
>   1F-E deliberately deferred: turning that owed amount into a tracked payout.
> - **1F-C** — order approval/governance pattern (lock as a governance act,
>   superseding-append on reversal, separation of duties), reused here for the
>   payout lifecycle rather than re-invented.
> - **1F-B** — base-currency derivation. Payout amounts are carried in the same
>   base currency as the settlement they draw from; this phase does not re-apply
>   FX or introduce a second currency basis.
> - **Phase 0 / Foundation** — RLS tenant isolation, RBAC, append-only audit,
>   BigInt money math. Every rule below inherits these; they are not re-derived.

## 1. Goals & scope

### What 1F-F is

Phase 1F-F turns the commission **owed** (the frozen figures inside a locked
`commission_settlement` from 1F-E) into commission **disbursed** — a tracked,
auditable record of what has actually been scheduled and marked paid, without
ever recomputing the underlying numbers.

Concretely, this phase delivers:

- **Payout records derived from a locked settlement.** A payout draws its
  per-salesperson amounts directly from the settlement's frozen lines (1F-E
  `commission_settlement_lines`). It never re-derives commission from orders or
  rates — the settlement is the single source of truth, so a payout and its
  settlement can never disagree. Only a *locked* (not unlocked/superseded)
  settlement is payable.
- **A paid / unpaid lifecycle per payout line.** Each salesperson's line in a
  payout moves through an explicit, governed status (e.g. pending → paid, with a
  void/reversal path), so "how much of this settlement has actually gone out" is
  a queryable fact rather than a spreadsheet note. Status transitions are
  validated server-side and are append-only in the audit trail.
- **Payout batches.** Lines are grouped into a batch (one disbursement run for a
  settlement/period) so a finance user can mark a batch paid, record a payout
  date and an external reference (e.g. a bank transfer note / payroll run id the
  user types in), and see batch-level totals — all in base currency.
- **Full audit + governance.** Creating a payout, marking lines/batches paid,
  and any reversal are audited (actor, before/after, reason where it applies)
  and gated by RBAC. Marking paid is a privileged action distinct from viewing.
- **Read surfaces.** A payouts list, a payout/batch detail with per-salesperson
  lines and paid/unpaid state, and graceful 403 fallback — consistent with the
  1F-D/1F-E frontends, tabular and base-currency only.

The guiding invariant: **1F-F records and tracks disbursement; it does not
compute commission and does not move real money.** The amount on a payout line
is copied from a locked settlement line and is immutable thereafter.

### What 1F-F is *not* (out of scope, deferred)

- **Real bank / payroll / payment-rail integration.** No connection to a bank
  API, payroll provider, or payment processor; no generation of NACHA/SEPA/ACH
  files or live transfers. "Marked paid" is a human-entered bookkeeping fact
  with an optional free-text external reference, not a money movement.
- **Tax, withholding, social-contribution, and net-pay calculation.** Payout
  amounts equal the gross commission owed from the settlement. Any deduction,
  withholding, gross-to-net, or statutory contribution logic is out of scope.
- **Recomputing or adjusting commission.** This phase never re-derives, edits,
  or overrides the per-salesperson amounts; they come verbatim from the locked
  1F-E settlement. Correcting a wrong amount is done in 1F-E (unlock → fix rates
  → re-lock), not here.
- **Paying against an unlocked / unsettled period.** Only a locked settlement is
  payable. Draft/pipeline commission, live on-demand summaries, and unlocked or
  superseded settlements are not payable.
- **Clawbacks, draws, advances, and multi-period netting.** Negative payouts,
  recovering a prior overpayment, advancing against future commission, or
  netting one period against another are deferred. A payout is a non-negative
  disbursement of a single settlement.
- **Approval workflow *for* payouts.** As in 1F-E, the lifecycle (create →
  mark paid, with reversal) is the governance mechanism, not a multi-step
  approval chain over payouts.
- **Scheduling / recurring automatic disbursement.** No cron-driven auto-payout;
  a payout is created and marked paid by an explicit user action.
- **Cross-tenant / platform-admin payout analytics.** Single-tenant only, scoped
  via RLS like everywhere else.
- **Export (CSV/Excel/PDF) and charts.** On-screen tabular results only,
  consistent with where 1F-D/1F-E left exports.

### Dependencies (explicit)

- **1F-E locked settlement** — the immutable source of payout amounts and the
  per-salesperson lines; payable only while `status = locked` and not superseded.
- **1F-B base currency** — payout amounts are the settlement's base-currency
  figures, carried unchanged.
- **1F-C governance pattern** — lifecycle transitions, separation-of-duties, and
  superseding-append reversal are modeled on the approval workflow.
- **Phase 0** — RLS, RBAC, append-only audit, BigInt money math.

## 2. Data model

This section pins the tables 1F-F adds and how they relate to the 1F-E
settlement they draw from. The governing rule is stated once and obeyed
everywhere below: **a payout copies (does not reference-and-recompute) the
per-salesperson amounts from a locked settlement, and those copied amounts are
immutable for the life of the payout.** The settlement is the source of the
*owed* number; the payout is the record of the *disbursed* number, and the two
are wired so they can never silently drift.

### 2.0 Shape — a payout batch with per-salesperson lines

A disbursement run is modeled as **one `commission_payouts` header (the batch)
plus N `commission_payout_lines` (one per salesperson)**, mirroring the
settlement header/line split in 1F-E. This is the natural grain: finance creates
one payout for a settled period, then marks individual salespeople paid as money
goes out, and the header carries batch-level totals and the payout run's
metadata (date, external reference).

```
commission_settlements (1F-E, locked)
        │ 1
        │
        │ 0..1   one payout per locked settlement (idempotent, §3)
        ▼
commission_payouts ─────1───────< commission_payout_lines
   (batch header)                   (one per salesperson)
        ▲                                   │
        └─── snapshot of settlement ───────┘ amount copied from the
             totals at creation             matching settlement line
```

### 2.1 `commission_payouts` — the batch header

One row per disbursement run, created from exactly one locked settlement.

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` NOT NULL → `tenants(id)` | RLS scope key. |
| `settlement_id` | `uuid` NOT NULL → `commission_settlements(id)` | The locked settlement this payout disburses. |
| `status` | `varchar(16)` NOT NULL DEFAULT `'open'` | Batch lifecycle: `open` → `paid`, plus `void` (§3 D3). CHECK constrained. |
| `total_payout_base` | `numeric(18,2)` NOT NULL | Σ of line amounts at creation; equals the settlement's `total_commission_base`. CHECK `>= 0`. |
| `currency` | `varchar(8)` NOT NULL | Tenant base currency, copied from settlement context; payouts carry no second currency (§1, §9). |
| `payout_date` | `date` NULL | The run's value date; set when the batch is marked paid. |
| `external_ref` | `varchar(128)` NULL | Free-text bank-transfer note / payroll-run id typed by the user. Not validated against any system. |
| `note` | `varchar(500)` NULL | Optional free-text. |
| `created_by` | `uuid` NOT NULL → `users(id)` | |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | |
| `paid_by` | `uuid` NULL → `users(id)` | Actor who marked the batch paid (separation of duties, §7). |
| `paid_at` | `timestamptz` NULL | |
| `voided_by` | `uuid` NULL → `users(id)` | |
| `voided_at` | `timestamptz` NULL | |
| `void_reason` | `varchar(500)` NULL | Required when voiding (§3 D4). |

Constraints:

- `CHECK (status IN ('open','paid','void'))`.
- `CHECK (total_payout_base >= 0)`.
- **Idempotency:** a *partial unique index* on `settlement_id` where
  `status <> 'void'` — at most one live (non-void) payout per settlement, so a
  double-create conflicts rather than producing two batches; a voided
  payout frees the settlement to be paid again (§3 D4/D5).

### 2.2 `commission_payout_lines` — one per salesperson

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid` PK | |
| `tenant_id` | `uuid` NOT NULL → `tenants(id)` | RLS scope key. |
| `payout_id` | `uuid` NOT NULL → `commission_payouts(id)` ON DELETE CASCADE | Parent batch. |
| `settlement_line_id` | `uuid` NOT NULL → `commission_settlement_lines(id)` | The 1F-E line this amount was copied from (traceability). |
| `salesperson_user_id` | `uuid` NOT NULL → `users(id)` | Credited salesperson; same attribution field as 1F-E. |
| `amount_base` | `numeric(18,2)` NOT NULL | **Copied** from the settlement line's `commission_base` at creation; immutable thereafter. CHECK `>= 0`. |
| `status` | `varchar(16)` NOT NULL DEFAULT `'pending'` | Per-line lifecycle: `pending` → `paid`, plus `void`. CHECK constrained. |
| `paid_at` | `timestamptz` NULL | Set when the line is marked paid. |

Constraints:

- `CHECK (status IN ('pending','paid','void'))`.
- `CHECK (amount_base >= 0)`.
- `UNIQUE (payout_id, salesperson_user_id)` — one line per salesperson per batch.

### 2.3 Append-only vs. mutable — what UPDATE is allowed

1F-E settlements are strictly append-only (the migration grants only
`SELECT, INSERT` on `commission_settlements` / `_lines`, and unlock is a
superseding insert). Payouts differ in one deliberate way: **the lifecycle
status fields are mutated in place** (`open`→`paid`→`void` on the header;
`pending`→`paid`→`void` on lines), because a payout *is* a small state machine
and modeling every status flip as a superseding row would bloat the model
without adding integrity the audit log doesn't already provide.

To keep that mutation honest:

- **The money is never mutated.** `amount_base` and `total_payout_base` are
  written once at creation and never updated — only status/metadata columns
  change. This is enforced by the API (no endpoint updates an amount) and
  hardened by a freeze-money-columns DB trigger (§3 D7 / §4.5).
- **Every transition is audited** (§7) with actor + before/after, so the full
  history is reconstructable from the append-only `audit_logs` even though the
  row itself is updated in place.
- **Reversal is `void`, not delete.** A wrong payout is voided (status set to
  `void`, reason required, audited), never hard-deleted; the row and its lines
  remain for the audit trail, and voiding frees the settlement for a fresh
  payout via the partial unique index (§2.1).

The grant for these tables is therefore `SELECT, INSERT, UPDATE` (no `DELETE`),
contrasted with the settlement tables' `SELECT, INSERT` — the difference is
intentional and called out in §4/§7.

### 2.4 What is copied vs. referenced from the settlement

| fact | copied into payout | referenced (FK only) | rationale |
| --- | --- | --- | --- |
| per-salesperson amount | ✅ `amount_base` | — | immutable disbursed figure; must not change if the (already-locked) settlement is later superseded |
| salesperson identity | ✅ `salesperson_user_id` | ✅ `settlement_line_id` | stored for query convenience + scope; FK keeps provenance |
| batch total | ✅ `total_payout_base` | — | batch-level invariant checkable without re-summing |
| caliber / period / table | — | ✅ via `settlement_id` | unchanging on a locked settlement; no need to duplicate |
| order ids behind a line | — | ✅ (in settlement `snapshot`) | already frozen in 1F-E; payout does not re-list them |

Copying the amounts (rather than joining to the settlement at read time) is what
makes a payout robust against any later 1F-E activity: even though a *locked*
settlement cannot change, the copy makes the disbursement record self-contained
and the immutability guarantee local to 1F-F.

### 2.5 RLS, indexes, grants (summary; full DDL in §4)

- **RLS:** both tables get `ENABLE ROW LEVEL SECURITY` + the standard
  `tenant_isolation_policy` (`USING`/`WITH CHECK` on `app_current_tenant_id()`),
  identical to every other tenant table.
- **Indexes:** partial unique on `commission_payouts(settlement_id) WHERE
  status <> 'void'` (idempotency); `commission_payout_lines(payout_id)`;
  `commission_payout_lines(salesperson_user_id)` for "my payouts" reads.
- **Grants:** `SELECT, INSERT, UPDATE` on both payout tables to
  `kirindesk_app` (no `DELETE`), deliberately wider than the settlement tables'
  `SELECT, INSERT` for the in-place status machine (§2.3).

## 3. Key design decisions

Each decision states the recommended choice and the reasoning, in the same
`[采纳]` style as 1F-E §3. Together they resolve every open question §2
deferred here.

### D1. Source of payout amounts — copy from a locked settlement, never recompute

**Decision (recommended): a payout's per-salesperson amounts are copied verbatim
from the `commission_settlement_lines` of a single `status = 'locked'` (and not
superseded) settlement, at creation time, and are immutable thereafter. 1F-F
never derives commission from orders or rates. [采纳]**

- The locked settlement is already the agreed, frozen statement of commission
  owed (1F-E §D5). Disbursement must pay *that* number, so the payout copies it
  rather than re-running any calculation that could diverge. The settlement is
  the single source of truth; the payout is its disbursement ledger.
- **Only a locked settlement is payable.** An `unlocked` settlement, or a locked
  row that has been superseded (a newer row points at it via `supersedes`), is
  not a current agreed figure and cannot be paid. Creation validates that the
  target settlement is the *current locked* row exactly as 1F-E's read path does
  (`status = 'locked'` AND no row supersedes it). *Rec: reject payout creation
  against any non-current-locked settlement with a typed 409.* [采纳]
- Correcting a wrong amount is **out of 1F-F's hands**: unlock the settlement in
  1F-E, fix rates, re-lock, then pay the corrected settlement. 1F-F has no
  amount-editing path at all. *Rec: corrections flow through 1F-E, never the
  payout.* [采纳]

### D2. Batch + lines vs. flat lines — header batch with per-salesperson lines

**Decision (recommended): one `commission_payouts` header (the disbursement
batch) plus one `commission_payout_lines` per salesperson, mirroring the 1F-E
settlement header/line split. [采纳]**

- The real-world unit is "the payout run for this settled period," which carries
  run-level facts (payout date, external reference, batch total) that belong on
  a header, not repeated on every line. Finance acts on the batch ("mark this
  run paid") and occasionally on a line ("this one salesperson is paid").
- Reusing the 1F-E header/line shape keeps the mental model and the code
  patterns consistent across the two phases. *Rec: batch header + lines.* [采纳]
- A batch maps to **exactly one settlement** (D5 idempotency). Combining
  multiple settlements/periods into one payout is deferred (multi-period netting
  is out of scope, §1). *Rec: one settlement per batch.* [采纳]

### D3. Lifecycle / state machine — small, explicit, server-validated

**Decision (recommended): batch `open → paid`, line `pending → paid`, with a
`void` terminal reachable from either, and no other transitions. Transitions are
validated server-side; the client never sets status directly to an arbitrary
value. [采纳]**

- **Batch states:** `open` (created, money not yet out), `paid` (the run has
  been disbursed), `void` (cancelled/reversed, §D6).
- **Line states:** `pending`, `paid`, `void`.
- **Allowed transitions:**
  - line: `pending → paid` (mark paid), `pending → void` / `paid → void` (only
    via voiding the parent batch, D6);
  - batch: `open → paid` (mark batch paid — also marks all its `pending` lines
    `paid` and stamps `payout_date`/`paid_by`/`paid_at`), `open → void` /
    `paid → void` (void, D6).
- **Marking a line paid is allowed while the batch is `open`** so finance can
  pay salespeople individually; when the **last** `pending` line becomes `paid`
  the batch does *not* auto-flip — the batch is marked paid explicitly (which is
  also when the run-level `payout_date`/`external_ref` are captured). This keeps
  "all lines paid" (a derived fact) distinct from "the run is closed" (an
  explicit act). *Rec: explicit batch close, no auto-flip.* [采纳]
- Any transition not in the list (e.g. `paid → open`, `void → anything`) is a
  typed 409. *Rec: reject illegal transitions, never silently no-op.* [采纳]

### D4. Reversal — `void` (in-place status + audit), not a superseding append

**Decision (recommended): reversing a payout sets `status = 'void'` in place
(header and its lines), requires a reason, and is audited; it is not modeled as
a superseding-append row the way 1F-E unlock is. [采纳]**

- 1F-E froze settlements as strictly append-only because a settlement is a
  *financial statement of record* whose every version must survive verbatim. A
  payout is an *operational state machine*; its history is fully reconstructable
  from the append-only `audit_logs` (§7), so an in-place status flip loses no
  auditability while keeping the model small.
- **Void is terminal and reversible only forward:** a voided batch frees its
  settlement (the partial unique index excludes `void`, §2.1), so finance
  creates a fresh payout to redo the run. A voided payout is never un-voided.
  *Rec: void is terminal; redo = new payout.* [采纳]
- **Voiding a `paid` batch is allowed** (e.g. a transfer bounced / was entered
  in error) but is the privileged `reverse` action (§7), reason required, fully
  audited. *Rec: paid→void permitted under the reverse permission with a
  reason.* [采纳]
- This is the one deliberate divergence from 1F-E's append-only stance, and it
  is confined to status/metadata columns — see D7 for why the *money* stays
  immutable regardless.

### D5. Idempotency / no double-pay — one live payout per settlement

**Decision (recommended): a partial unique index on
`commission_payouts(settlement_id) WHERE status <> 'void'` guarantees at most one
live payout per settlement; creation is idempotent under that guard. [采纳]**

- The danger is paying the same settlement twice (a double-submit, a retry).
  The DB-level partial unique index makes a second live payout for the same
  settlement impossible regardless of application bugs or races. *Rec: enforce
  at the DB, not just the service.* [采纳]
- **Creation behavior on conflict:** the service takes the row lock pattern from
  1F-E (D3) — it checks for an existing live payout for the settlement and
  returns it (idempotent) rather than erroring, so a retried create is safe; a
  genuinely concurrent second insert is caught by the unique index and mapped to
  the same idempotent return / a 409. *Rec: idempotent return on an existing
  live payout, index as the backstop.* [采纳]
- A **voided** payout does not block a new one (it is excluded from the index),
  which is exactly how a reversed run is redone (D4). *Rec: void frees the
  settlement.* [采纳]

### D6. Concurrency — serialize batch transitions per payout

**Decision (recommended): mark-paid / void take a `SELECT … FOR UPDATE` on the
`commission_payouts` row before transitioning, so concurrent actions on the same
batch serialize. [采纳]**

- Two finance users hitting "mark paid" and "void" simultaneously must not
  interleave into a half-applied state. Locking the batch row first makes the
  transition check-and-set atomic, the same mechanism 1F-E used for table
  edits/lock (1F-E §D3). *Rec: lock the batch row, then validate + transition.*
  [采纳]
- Line-level mark-paid locks the parent batch row too (not just the line), so a
  line transition and a batch close cannot race into an inconsistent batch.
  *Rec: line transitions also take the batch lock.* [采纳]

### D7. Money immutability — copied once, never updated; hardening

**Decision (recommended): `amount_base` and `total_payout_base` are written only
at creation and never updated by any endpoint; the in-place mutation allowed on
payout tables is restricted to status/metadata columns. Harden with a row-level
guard. [采纳]**

- The integrity claim of 1F-F is "disbursed = owed, frozen." That holds only if
  the copied money columns are truly write-once. No API endpoint updates them
  (only status, paid_at/by, payout_date, external_ref, void_reason change after
  creation). *Rec: no amount-editing endpoint exists.* [采纳]
- **Hardening (recommended): a BEFORE UPDATE trigger** on both payout tables
  that rejects any change to the money columns (`amount_base`,
  `total_payout_base`), so even a future buggy/ad-hoc UPDATE cannot alter a
  disbursed figure. This is preferred over column-level `GRANT` because the app
  role needs UPDATE on the same table's status columns, and a trigger expresses
  "these specific columns are frozen" precisely. *Rec: add the
  freeze-money-columns trigger in the migration (§4).* [采纳]
- Tradeoff noted: a trigger is slightly more migration surface than relying on
  the service alone, but it makes the core invariant defense-in-depth rather
  than convention. [采纳]

### D8. Attribution & scope — `salesperson_user_id`, RLS, dataScope

**Decision (recommended): the credited salesperson is the settlement line's
`salesperson_user_id`, carried onto the payout line; reads honor RLS + the same
`dataScope` model as orders/commission so "my payouts" works. [采纳]**

- Attribution is inherited from 1F-E (which inherited it from order
  `owner_user_id`), so "my orders → my commission → my payout" is one consistent
  identity throughout. *Rec: no new attribution concept.* [采纳]
- **Reads are dataScope-aware:** a salesperson with `own`/`assigned` scope sees
  only their own payout lines; a finance/admin role with broader scope sees the
  batch. **Writes (create / mark paid / void) are privileged finance actions**
  and are not salesperson self-service (§7). *Rec: scoped reads, privileged
  writes.* [采纳]

### D9. What a payout does *not* persist — derive from the settlement

**Decision (recommended): the payout stores only disbursement facts (amounts,
status, run metadata); period/caliber/table/order-ids are reached through the
`settlement_id` FK, not duplicated. [采纳]**

- A locked settlement is immutable, so duplicating its period/caliber/snapshot
  into the payout would add nothing but drift risk. The payout copies *only* the
  money (which must be frozen locally, D7) and references the rest. *Rec: copy
  money, reference context* (the §2.4 table). [采纳]

## 4. Migration

One additive migration, **`db/migrations/034_commission_payout.sql`**, following
the 033 conventions exactly: parents-before-children create order, tenant-leading
indexes aligned with the RLS predicate, `ENABLE` + `FORCE ROW LEVEL SECURITY`
with the standard `tenant_isolation_policy`, and a reverse-order `CASCADE` drop
in the DOWN. Two new tables (`commission_payouts`, `commission_payout_lines`) and
one freeze-money-columns trigger (§3 D7).

It diverges from 033 in one deliberate, documented way: the payout tables keep
**UPDATE** (the in-place status machine, §2.3/§3 D4) rather than revoking it like
the append-only settlement tables — but a trigger freezes the money columns so
the relaxation cannot touch a disbursed amount.

### 4.1 UP — tables

```sql
-- UP
-- Phase 1F-F: commission payout / disbursement.
-- Turns a locked 1F-E commission_settlement into a tracked disbursement record.
-- See docs/phase-1f-f-commission-payout-plan.md §2 / §3 / §4.
--
-- Design notes (per plan):
--   * One batch header (commission_payouts) + per-salesperson lines
--     (commission_payout_lines), mirroring the 1F-E settlement header/line split.
--   * Amounts are COPIED from commission_settlement_lines at creation and are
--     immutable thereafter (§3 D1/D7). A BEFORE UPDATE trigger freezes the money
--     columns; only status/metadata columns may change in place.
--   * Unlike the append-only settlement tables, payouts keep UPDATE for the
--     status machine (open->paid->void / pending->paid->void, §3 D3/D4). No
--     DELETE: reversal is void-in-place, never a hard delete.
--   * At most one live (non-void) payout per settlement, enforced by a partial
--     unique index — the DB-level no-double-pay guard (§3 D5).
--   * Money is numeric(18,2) in the tenant base currency, copied from the
--     settlement; no FX, no second currency (§9).

-- 1. commission_payouts — the disbursement batch header (one per settlement)
CREATE TABLE commission_payouts (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  settlement_id      uuid NOT NULL REFERENCES commission_settlements(id),
  status             varchar(16) NOT NULL DEFAULT 'open',
  total_payout_base  numeric(18, 2) NOT NULL,
  currency           varchar(8) NOT NULL,
  payout_date        date,
  external_ref       varchar(128),
  note               varchar(500),
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_by            uuid REFERENCES users(id),
  paid_at            timestamptz,
  voided_by          uuid REFERENCES users(id),
  voided_at          timestamptz,
  void_reason        varchar(500),
  CONSTRAINT chk_commission_payouts_status
    CHECK (status IN ('open', 'paid', 'void')),
  CONSTRAINT chk_commission_payouts_total CHECK (total_payout_base >= 0),
  -- void must carry a reason (§3 D4); paid must carry actor + timestamp.
  CONSTRAINT chk_commission_payouts_void
    CHECK (status <> 'void' OR void_reason IS NOT NULL),
  CONSTRAINT chk_commission_payouts_paid
    CHECK (status <> 'paid' OR (paid_by IS NOT NULL AND paid_at IS NOT NULL))
);

-- 2. commission_payout_lines — one row per salesperson in the batch
CREATE TABLE commission_payout_lines (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  payout_id            uuid NOT NULL REFERENCES commission_payouts(id) ON DELETE CASCADE,
  settlement_line_id   uuid NOT NULL REFERENCES commission_settlement_lines(id),
  salesperson_user_id  uuid NOT NULL REFERENCES users(id),
  amount_base          numeric(18, 2) NOT NULL,
  status               varchar(16) NOT NULL DEFAULT 'pending',
  paid_at              timestamptz,
  CONSTRAINT chk_commission_payout_lines_status
    CHECK (status IN ('pending', 'paid', 'void')),
  CONSTRAINT chk_commission_payout_lines_amount CHECK (amount_base >= 0),
  CONSTRAINT uq_commission_payout_lines_person
    UNIQUE (payout_id, salesperson_user_id)
);
```

### 4.2 UP — indexes

```sql
-- Indexes (tenant_id leads to align with the RLS predicate).
CREATE INDEX idx_commission_payouts_tenant
  ON commission_payouts (tenant_id, settlement_id);

-- No-double-pay: at most one live (non-void) payout per settlement (§3 D5).
CREATE UNIQUE INDEX uq_commission_payouts_live_settlement
  ON commission_payouts (settlement_id)
  WHERE status <> 'void';

CREATE INDEX idx_commission_payout_lines_payout
  ON commission_payout_lines (tenant_id, payout_id);
CREATE INDEX idx_commission_payout_lines_person
  ON commission_payout_lines (tenant_id, salesperson_user_id);
```

> Note: the partial unique index is scoped to `settlement_id` only (not
> `tenant_id, settlement_id`). `settlement_id` is already globally unique
> (a PK), so this is sufficient and keeps the "one live payout per settlement"
> invariant exact; RLS still isolates reads/writes by tenant.

### 4.3 UP — RLS

```sql
-- RLS: tenant isolation on both tables (same policy as every tenant table).
ALTER TABLE commission_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_payouts
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE commission_payout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payout_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON commission_payout_lines
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
```

### 4.4 UP — grants

```sql
-- Grants. Unlike the append-only settlement tables (SELECT, INSERT only), the
-- payout tables keep UPDATE for the in-place status machine (§2.3 / §3 D4).
-- DELETE is revoked: reversal is void-in-place, never a hard delete. The
-- 000_app_role.sql default grants all four on every new table, so DELETE is
-- explicitly revoked here.
GRANT SELECT, INSERT, UPDATE ON commission_payouts, commission_payout_lines TO kirindesk_app;
REVOKE DELETE ON commission_payouts, commission_payout_lines FROM kirindesk_app;
```

### 4.5 UP — freeze-money-columns trigger (§3 D7)

The defense-in-depth guard: even with UPDATE granted, the money columns are
write-once. A `BEFORE UPDATE` trigger raises if `amount_base` /
`total_payout_base` would change, so a disbursed figure can never be edited —
only status/metadata columns may move.

```sql
-- A disbursed amount is copied from a locked settlement and frozen (§3 D1/D7).
-- UPDATE is granted for the status machine, so this trigger is what makes the
-- money columns write-once at the DB level.
CREATE OR REPLACE FUNCTION prevent_commission_payout_amount_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.total_payout_base IS DISTINCT FROM OLD.total_payout_base THEN
    RAISE EXCEPTION 'commission_payouts.total_payout_base is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_commission_payout_amount
  BEFORE UPDATE ON commission_payouts
  FOR EACH ROW EXECUTE FUNCTION prevent_commission_payout_amount_change();

CREATE OR REPLACE FUNCTION prevent_commission_payout_line_amount_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.amount_base IS DISTINCT FROM OLD.amount_base THEN
    RAISE EXCEPTION 'commission_payout_lines.amount_base is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_commission_payout_line_amount
  BEFORE UPDATE ON commission_payout_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_commission_payout_line_amount_change();
```

### 4.6 DOWN

```sql
-- DOWN
-- Reverse dependency order: triggers/functions, then children before parents.
-- Purely additive migration (no altered columns, no coerced data), so the down
-- is a clean drop. CASCADE clears the RLS policies, indexes, and FKs with their
-- tables.
DROP TRIGGER IF EXISTS freeze_commission_payout_line_amount ON commission_payout_lines;
DROP TRIGGER IF EXISTS freeze_commission_payout_amount ON commission_payouts;
DROP FUNCTION IF EXISTS prevent_commission_payout_line_amount_change();
DROP FUNCTION IF EXISTS prevent_commission_payout_amount_change();
DROP TABLE IF EXISTS commission_payout_lines CASCADE;
DROP TABLE IF EXISTS commission_payouts CASCADE;
```

### 4.7 Migration invariants checklist

- **Additive only** — no `ALTER`/backfill on existing tables; 1F-E tables are
  untouched, so the down is a clean drop with no data coercion.
- **FK direction** — payouts reference `commission_settlements` and payout lines
  reference `commission_settlement_lines`; no FK runs the other way, so 1F-E
  remains independent of 1F-F.
- **Immutability layered** — money frozen by trigger (§4.5), no hard delete
  (grant, §4.4), no double-pay (partial unique index, §4.2). The status machine
  itself is enforced in the service (§5) under a row lock (§3 D6); the DB guards
  the money and the uniqueness.
- **RLS parity** — both tables `FORCE` RLS with the identical
  `tenant_isolation_policy`, matching every other tenant table.

## 5. API design

All endpoints live under `@Controller('api/commission')` — extending the
existing commission controller surface rather than adding a new top-level
namespace — and are guarded by `TenantAuthGuard` + `PermissionGuard` with
`@RequirePermission(resource, action)`, exactly as the 1F-E routes are. Money in
every request/response is a `numeric(18,2)` decimal **string** in the tenant base
currency (never a float), matching 1F-D/1F-E.

The actor model is the 1F-E `RequestActor` (`userId`, `tenantId`, `dataScope`):
reads are dataScope-aware (a salesperson sees only their own lines); writes are
privileged finance actions and are not dataScope self-service (§7, §3 D8).

### 5.0 RBAC permission codes (new)

Three new codes in the finance resource group (`a0000000-…-004`, the same group
that holds `commission_tables:*`), added to `db/seeds/002_permissions.sql`:

| code | action | guards |
| --- | --- | --- |
| `commission_payouts:view` | `view` | list + detail reads |
| `commission_payouts:disburse` | `disburse` | create payout, mark line/batch paid |
| `commission_payouts:reverse` | `reverse` | void a payout (incl. a paid one) |

- These are **separate from `commission_tables:*`**: locking/settling commission
  (1F-E) and disbursing it (1F-F) are different duties and should be separately
  grantable (separation of duties, §7). The `disburse`/`reverse` verbs are new
  but follow the existing `lock`/`unlock`/`approve` precedent of action-specific
  verbs. *Rec: new codes, not a reuse of `commission_tables:lock`.* [采纳]
- Reusing the finance group keeps the permission surface aligned with the
  already-seeded grouping (where `finance:view` and `commission_tables:*` live).

### 5.1 Create a payout from a locked settlement (privileged, audited)

`POST /api/commission/payouts` — `@RequirePermission('commission_payouts',
'disburse')`.

Body: `{ "settlementId": "<uuid>", "note"?: "<string>" }`.

- Validates `settlementId` is a uuid and resolves to the caller's tenant (RLS);
  else `400` / `404`.
- Validates the settlement is the **current locked** row — `status = 'locked'`
  AND no row supersedes it (§3 D1). Otherwise `409`
  (`settlement is not currently locked`).
- **Idempotent (§3 D5):** under a `SELECT … FOR UPDATE` on a serialization point
  (the settlement / existing payout), if a live (non-`void`) payout already
  exists for the settlement, it is returned with `200` rather than creating a
  second; a fresh create returns `201`. The partial unique index is the backstop
  if two creates race.
- On create: copies `total_commission_base` → `total_payout_base`,
  `currency` from settlement context, and inserts one `commission_payout_lines`
  row per `commission_settlement_lines` row, copying `commission_base` →
  `amount_base`, `salesperson_user_id`, and `settlement_line_id`. Header starts
  `open`, lines start `pending`.
- Audited: `commission.payout.created` (actor, resourceId, after-snapshot of the
  batch). Returns the payout as in §5.3.

### 5.2 List payouts (read, dataScope-aware)

`GET /api/commission/payouts` — `@RequirePermission('commission_payouts',
'view')`.

- Optional filters: `settlementId`, `status` (`open|paid|void`).
- **dataScope:** a broad-scope (finance/admin) caller sees all batches; a
  narrow-scope (`own`/`assigned`) caller sees only batches that contain a line
  for them, and `total_payout_base` is **not** narrowed (it is the batch fact) —
  per-person figures come from the detail/lines endpoint. *Rec: list is a
  batch-level read gated by membership for narrow scopes.* [采纳]
- Response: array of batch headers (no lines), newest first:

```jsonc
[
  {
    "id": "…",
    "settlementId": "…",
    "status": "open",
    "totalPayoutBase": "7512.50",
    "currency": "RMB",
    "payoutDate": null,
    "externalRef": null,
    "createdAt": "2026-04-02T03:00:00Z"
  }
]
```

### 5.3 Payout detail with lines (read, dataScope-aware)

`GET /api/commission/payouts/:id` — `@RequirePermission('commission_payouts',
'view')`.

- `404` if not in the caller's tenant/scope.
- **dataScope:** broad scope sees all lines; narrow scope sees only their own
  line(s) within the batch (consistent with "my payouts", §3 D8). The header is
  visible if the caller has any line in the batch.
- Response: batch header + `lines[]`:

```jsonc
{
  "id": "…",
  "settlementId": "…",
  "status": "open",
  "totalPayoutBase": "7512.50",
  "currency": "RMB",
  "payoutDate": null,
  "externalRef": null,
  "note": null,
  "createdAt": "2026-04-02T03:00:00Z",
  "paidAt": null,
  "voidedAt": null,
  "lines": [
    {
      "id": "…",
      "salespersonUserId": "…",
      "salespersonName": "张三",
      "settlementLineId": "…",
      "amountBase": "6420.00",
      "status": "pending",
      "paidAt": null
    }
  ]
}
```

### 5.4 Mark a single line paid (privileged, audited)

`POST /api/commission/payouts/:id/lines/:lineId/pay` —
`@RequirePermission('commission_payouts', 'disburse')`.

- Under a `SELECT … FOR UPDATE` on the **parent batch** row (§3 D6), validates
  the batch is `open` and the line is `pending`; transitions the line
  `pending → paid` and stamps `paid_at`. Illegal source state → `409`.
- Does **not** auto-close the batch even if it was the last pending line (§3 D3).
- Audited: `commission.payout.line_paid`.

### 5.5 Mark the batch paid (privileged, audited)

`POST /api/commission/payouts/:id/pay` —
`@RequirePermission('commission_payouts', 'disburse')`.

Body: `{ "payoutDate": "2026-04-02", "externalRef"?: "<string>", "note"?: "…" }`.

- Under the batch row lock, validates `status = 'open'`; sets `status = 'paid'`,
  marks all still-`pending` lines `paid` (stamping their `paid_at`), and records
  `payout_date`, `external_ref`, `paid_by` (the actor), `paid_at`. Re-paying a
  `paid`/`void` batch → `409`.
- Audited: `commission.payout.paid` (before/after, captures `payoutDate`/ref).

### 5.6 Void / reverse a payout (privileged, audited)

`POST /api/commission/payouts/:id/void` —
`@RequirePermission('commission_payouts', 'reverse')`.

Body: `{ "reason": "<string>" }` — reason **required** (DB CHECK + DTO).

- Under the batch row lock, allowed from `open` **or** `paid` (a mis-entered
  paid run can be reversed, §3 D4); sets `status = 'void'`, all lines `void`,
  stamps `voided_by`/`voided_at`/`void_reason`. Voiding an already-`void` batch
  → `409`.
- Voiding frees the settlement (partial unique index excludes `void`), so a
  corrected run can be created fresh (§3 D5). Reversing is the privileged
  `reverse` action, distinct from `disburse`.
- Audited: `commission.payout.voided` (before/after + reason).

### 5.7 Errors (consistent with 1F-E §5.4)

- `400` — invalid/missing body, bad uuid, missing `reason` on void, missing
  `payoutDate` on pay.
- `401` — unauthenticated.
- `403` — lacks the required permission for the action.
- `404` — payout/settlement not found in the caller's tenant/scope.
- `409` — settlement not currently locked (create); illegal status transition
  (pay/void on a non-eligible state); a concurrent second create caught by the
  unique index that is not idempotently resolvable.
- **`dataScope` narrowing never yields a 403 by itself** (1F-E §5.4): an
  `own`-scoped caller gets their own subset on reads, not an authorization
  error; writes require the `disburse`/`reverse` permission regardless of scope.

### 5.8 Money columns are never in a write path

No endpoint accepts or updates `amount_base` / `total_payout_base`; they are set
only by §5.1 from the settlement. This is the API half of the §3 D7 invariant
(the trigger in §4.5 is the DB half).

## 6. Frontend

This phase ships a **payouts list** and a **payout detail** page, plus the write
actions the lifecycle needs (create from a settlement, mark line/batch paid,
void). It reuses the patterns already established by the 1F-E commission pages
(`apps/web/src/commission/*`): shared `format.ts` / `styles.ts` helpers,
base-currency rendering of server decimal strings, and graceful 403 fallback.
The frontend performs **no money arithmetic** — every amount is copied from a
locked settlement server-side and rendered verbatim.

### 6.1 Routes & navigation

The existing 提成 nav entry already links the commission surfaces; payouts are
reached as a fifth cross-link in the commission sub-nav (alongside 汇总 / 明细 /
规则 / 结算单), and from a settlement detail page via a **「生成发放单」/「查看发放单」**
link. New routes in `apps/web/src/App.tsx`:

- `/commission/payouts` — **发放单列表 (Payouts)** — batch list.
- `/commission/payouts/:id` — **发放单明细 (Payout Detail)** — header + lines +
  actions.

A cross-link to `/commission/payouts` is added to the commission sub-nav line
shared by the 1F-E pages (and the reciprocal link from the settlement detail
page in `CommissionSettlementDetailPage.tsx`).

### 6.2 发放单列表 — Payouts list page

`CommissionPayoutsListPage.tsx`, calling `GET /api/commission/payouts` (§5.2).

- **Filters:** status (`open|paid|void`, default all) and optionally
  `settlementId` (pre-filled when arriving from a settlement).
- **Columns:** 期间/结算单 (settlement reference), 状态 (status — 待发放 /
  已发放 / 已作废, colour-coded), 发放日期 (payoutDate or「—」), 外部凭证
  (externalRef or「—」), 发放合计 (totalPayoutBase, base currency), and a 明细
  link to the detail page.
- Newest first; empty state explains how to create one (lock a settlement, then
  生成发放单). Graceful 403 + error handling identical to the 1F-E list pages.

### 6.3 发放单明细 — Payout detail page

`CommissionPayoutDetailPage.tsx`, calling `GET /api/commission/payouts/:id`
(§5.3).

- **Header block:** linked settlement (期间/口径 via the settlement),
  状态, 发放日期, 外部凭证, 备注, 发放合计 (base currency), plus
  created/paid/voided actor+timestamps where present.
- **Lines table:** 业务员 (salespersonName, falling back to the id),
  计提来源 (settlementLineId provenance, shown subtly), 发放金额 (amountBase,
  base currency), 行状态 (待发放 / 已发放 / 已作废), 发放时间 (paidAt or「—」).
- **No editable amount fields anywhere** — amounts are display-only, reinforcing
  the §3 D7 / §5.8 invariant.

### 6.4 Write actions (disburse / reverse)

The detail page surfaces the lifecycle actions, each mapping to a §5 endpoint
and degrading gracefully on 403:

- **生成发放单** (on the settlement detail page, for a *locked* settlement with no
  live payout): `POST /payouts` (§5.1), then navigate to the new payout. If a
  live payout already exists the idempotent `200` simply opens it.
- **标记该行已发放** (per `pending` line, while batch is `open`):
  `POST /payouts/:id/lines/:lineId/pay` (§5.4); refreshes the line in place.
- **标记整批已发放** (batch `open`): opens a small form for 发放日期 (required) +
  外部凭证/备注 (optional), then `POST /payouts/:id/pay` (§5.5); flips the batch
  and all pending lines to 已发放.
- **作废发放单** (batch `open` or `paid`): requires a 作废原因 (reason), then
  `POST /payouts/:id/void` (§5.6); marks the batch + lines 已作废 and notes the
  settlement is freed to re-issue.

Buttons are shown optimistically; the **server is the authoritative gate**. A
`403` from `disburse`/`reverse` maps to an inline "没有权限发放/作废" message (the
same 403/404/409 → inline-message mapping the 1F-E form pages use), a `409`
(illegal transition / settlement not locked) to a clear state-conflict message.

### 6.5 Permissions & graceful 403 fallback

Reads are gated by `commission_payouts:view`, writes by
`commission_payouts:disburse` / `:reverse` (§5.0). A user lacking the read
permission sees a graceful "没有权限查看发放单" notice rather than an error screen
(the 1F-D/1F-E convention). UI control hiding is cosmetic; correctness comes
from the backend check.

### 6.6 Base-currency display & no client-side computation

Every monetary figure is the tenant **base currency**, labelled from the
response (`currency`), formatted via the shared `formatAmount` helper. The page
applies no rate, no rounding, no summation beyond echoing the server's
`totalPayoutBase` — there is nothing to compute, because a payout only ever
displays amounts the backend copied from a locked settlement.

### 6.7 API client & types

`apps/web/src/lib/api-client.ts` gains `commissionPayouts()`,
`commissionPayout(id)`, `createCommissionPayout({ settlementId, note })`,
`payCommissionPayoutLine(id, lineId)`, `payCommissionPayout(id, body)`, and
`voidCommissionPayout(id, reason)` — following the existing commission method
group. `apps/web/src/lib/types.ts` gains the matching `CommissionPayout`,
`CommissionPayoutLine`, `CommissionPayoutDetail`, and the create/pay input types,
reusing `Currency` and the payout status unions.

## 7. Security, RBAC & audit

Payouts move commission from "owed" to "disbursed," so they touch money
attribution even more directly than 1F-E. The posture follows the same
trust-first rules in CLAUDE.md: reads are not audited, every **write** is
auditable, the disbursed money is immutable at the database level, disbursing is
separated from settling and from reversing, and dataScope is pushed into reads so
a narrower scope can never see another salesperson's payout.

### 7.1 RBAC & separation of duties

Three new finance-group codes (§5.0), deliberately distinct from
`commission_tables:*`:

| permission | grants | duty |
| --- | --- | --- |
| `commission_payouts:view` | list + detail reads | finance/ops + (scoped) the salesperson |
| `commission_payouts:disburse` | create, mark line/batch paid | the person who pays |
| `commission_payouts:reverse` | void a payout (incl. paid) | the person who can reverse a payment |

- **Settling ≠ disbursing.** `commission_tables:lock`/`:unlock` (1F-E) decide
  *what is owed*; `commission_payouts:disburse` decides *that it was paid*. A
  tenant can grant these to different roles so the person who locks the
  commission figures is not necessarily the person who marks money out. *Rec:
  separate codes, separately grantable.* [采纳]
- **Disbursing ≠ reversing.** Voiding a *paid* batch (correcting a mistaken or
  bounced disbursement) is the higher-trust `reverse` action, separable from
  routine `disburse`, so a single role cannot both pay and silently un-pay
  without holding both grants. *Rec: reverse is its own permission.* [采纳]
- Writes are **privileged finance actions, not salesperson self-service**: a
  salesperson with only scoped `view` can see their own lines but cannot create,
  pay, or void anything (§3 D8).

### 7.2 Audit events (writes only)

Read endpoints (`GET /payouts`, `/payouts/:id`) write **no audit rows**
(consistent with 1F-D/1F-E reads). Every state-changing operation appends to the
existing Phase 0 append-only hash-chain audit table, each row carrying
`actorId`, `actorType`, `tenantId`, `resourceType`, `resourceId`, and a
before/after payload where applicable:

| Event | Trigger | Key payload |
| --- | --- | --- |
| `commission.payout.created` | POST /payouts | payout id, settlement id, total, line count, currency |
| `commission.payout.line_paid` | POST /payouts/:id/lines/:lineId/pay | line id, salesperson, amount, before/after status |
| `commission.payout.paid` | POST /payouts/:id/pay | before/after batch status, `payoutDate`, `externalRef`, lines auto-paid |
| `commission.payout.voided` | POST /payouts/:id/void | before/after status, **required reason**, who/when |

Notes:
- The void audit row records the **reason** (required by §5.6 + DB CHECK) and the
  prior status, so an `open→void` vs a `paid→void` reversal is distinguishable
  and attributable.
- Marking paid captures the run metadata (`payoutDate`, `externalRef`) so the
  external bookkeeping reference that ties this batch to a real transfer is in
  the chain, not just the row.
- This phase adds **no new audit infrastructure**, only new event types on the
  existing chain.

### 7.3 Immutable disbursed amounts

Unlike 1F-E's fully append-only settlement tables, payout tables keep `UPDATE`
for the status machine — so immutability of the **money** is enforced by a
narrower, layered mechanism (§3 D7 / §4):

- **Money columns are frozen by a `BEFORE UPDATE` trigger** (§4.5):
  `amount_base` and `total_payout_base` cannot change after creation; any UPDATE
  that would alter them raises. Status/metadata columns are the only mutable
  surface.
- **No endpoint is in the money write path** (§5.8): amounts are written only by
  `POST /payouts` from the locked settlement. The API offers no way to edit an
  amount, so the trigger is defense-in-depth, not the only guard.
- **No DELETE** (grant revoked, §4.4): a wrong payout is `void`-ed in place, not
  removed, so the row and its lines survive for the audit trail. Reversal is a
  forward state transition, never a history rewrite.
- The disbursed figure is therefore a permanent "what was paid, copied from which
  locked settlement line" record — the FK `settlement_line_id` keeps provenance
  even though the amount is stored locally and frozen.

### 7.4 dataScope & tenant isolation (anti-escalation)

- **Tenant isolation** is enforced by PostgreSQL RLS on both payout tables (§4):
  every query runs inside `withTenantContext(...)`, and `tenant_isolation_policy`
  (via `app_current_tenant_id()`, with `FORCE ROW LEVEL SECURITY`) makes
  cross-tenant reads/writes structurally impossible — the same pattern as every
  other tenant table.
- **dataScope is applied to reads before results are returned**, mirroring the
  1F-E/1F-D rule: a salesperson with `own` scope sees only payout *lines* whose
  `salesperson_user_id = $self` (and only batches containing such a line); the
  filter restricts the line set, it never masks an already-summed figure. A
  broad (`all`) finance/admin scope sees the full batch and all lines.
- **dataScope narrowing never yields 403 by itself** (§5.7): a narrower scope
  returns fewer/zero rows, not an authorization error. 403 is reserved for
  missing the `commission_payouts:view` / `:disburse` / `:reverse` permission.
- **Writes are not dataScope self-service:** create/pay/void require the
  privileged permission regardless of scope; a scoped salesperson cannot disburse
  to themselves. Server-side checks are authoritative — UI control hiding is
  cosmetic (CLAUDE.md §4).

### 7.5 Concurrency & no-double-pay

- **Batch transitions are serialized** by `SELECT … FOR UPDATE` on the
  `commission_payouts` row before any mark-paid / void (§3 D6); line-level
  mark-paid also takes the parent batch lock, so a line transition and a batch
  close cannot interleave into an inconsistent state.
- **Creation is idempotent** (§3 D5 / §5.1): under the same row-lock pattern, an
  existing live payout is returned rather than duplicated, and the **partial
  unique index** (`commission_payouts(settlement_id) WHERE status <> 'void'`,
  §4.2) is the DB-level backstop that makes a second live payout for one
  settlement impossible even under a race — the structural guarantee against
  double-paying a settlement.
- A **voided** payout is excluded from that index, so a reversed run can be
  re-created cleanly without weakening the no-double-pay invariant for live
  payouts.

## 8. Testing & quality gate

Testing follows the 1F-D/1F-E pattern: integration tests against a real
PostgreSQL with RLS enforced (the DB is never mocked for isolation tests), plus
targeted unit tests for the lifecycle state machine and the amount-copy logic.
Because 1F-F does **no money arithmetic** (amounts are copied, not computed), the
test weight shifts from money-math correctness (covered in 1F-E) to
**immutability, lifecycle integrity, no-double-pay, and scope** — the invariants
that make a disbursement record trustworthy. The phase is not done until
`pnpm verify` is fully green.

### 8.1 Amount copy & immutability

- **Exact copy at creation:** creating a payout from a locked settlement yields
  one line per settlement line with `amount_base` equal to the settlement line's
  `commission_base` (decimal-string equality), and `total_payout_base` equal to
  the settlement's `total_commission_base`. No re-derivation, no rounding — the
  numbers are identical strings.
- **Trigger freezes money (§4.5 / §7.3):** an `UPDATE` that changes
  `amount_base` or `total_payout_base` as `kirindesk_app` is **rejected by the
  trigger** — verified by a test expecting the exception, not a silent success.
  A status-only UPDATE on the same row succeeds, proving the trigger is
  column-scoped, not a blanket lock.
- **No DELETE:** `DELETE` on either payout table as `kirindesk_app` fails (grant
  revoked, §4.4); reversal must go through `void`.
- **Independence from later settlement activity:** the payout's amounts are
  unchanged by anything that happens to 1F-E afterward (the settlement is locked
  anyway, but the copy makes the record self-contained).

### 8.2 Lifecycle state machine

- **Legal transitions only (§3 D3):** `pending → paid`, `open → paid`,
  `open|paid → void` succeed; every illegal source state (`paid → open`,
  `void → *`, paying a line in a non-`open` batch, re-paying a `paid` batch,
  re-voiding a `void` batch) returns `409`, never a silent no-op.
- **Batch pay cascades:** `POST /payouts/:id/pay` flips the batch to `paid`,
  marks all still-`pending` lines `paid`, and stamps `payout_date` / `paid_by` /
  `paid_at`; an already-`paid` line is left as-is.
- **No auto-close:** marking the last `pending` line paid does **not** flip the
  batch to `paid` (§3 D3) — asserted explicitly.
- **Void cascades + reason required:** void flips the batch and all lines to
  `void`, requires a reason (DB CHECK + DTO; missing reason → `400`), and stamps
  `voided_by` / `voided_at` / `void_reason`.

### 8.3 No-double-pay & idempotency

- **Partial unique index (§4.2):** a second live (non-`void`) payout for the same
  settlement is impossible — an attempted concurrent insert is rejected by the
  index.
- **Idempotent create (§5.1):** calling `POST /payouts` twice for the same locked
  settlement returns the same payout (the second is a `200` re-return, not a new
  batch), proven by id equality and a single row in the table.
- **Void frees the settlement:** after voiding, a fresh `POST /payouts` for the
  same settlement succeeds and creates a new live payout — the index permits it
  because the prior row is `void`.

### 8.4 Only-locked-payable

- **Unlocked / superseded settlement is not payable (§3 D1):** `POST /payouts`
  against an `unlocked` settlement, or a locked row that has been superseded,
  returns `409` (`settlement is not currently locked`).
- **Current-locked resolves correctly:** after an unlock→relock cycle in 1F-E,
  the payout binds to the *current* locked row, not the superseded one.

### 8.5 dataScope & tenant isolation (anti-escalation)

- **Scoped reads (§7.4):** an `own`-scope salesperson sees only payout lines
  where `salesperson_user_id = $self`, and only batches containing such a line;
  a broad-scope finance user sees all batches and all lines. The line set is
  filtered, never masked after the fact.
- **Cross-tenant impossible:** with RLS active, a read under tenant A returns
  zero of tenant B's payouts; a write (create/pay/void) under A cannot touch B.
- **Narrowing ≠ 403:** a scoped salesperson with `commission_payouts:view` gets a
  (possibly empty) result, not a 403; 403 is reserved for the missing permission
  (§5.7).
- **Writes are not self-service:** a scoped salesperson lacking
  `commission_payouts:disburse`/`:reverse` cannot create/pay/void even their own
  lines → 403.

### 8.6 API contract, permissions & audit

- **Envelopes:** list/detail return the documented shape (§5.2/§5.3) with all
  amounts as base-currency decimal strings and the `currency` field present.
- **Permission gating:** `:view` for reads, `:disburse` for create/pay, `:reverse`
  for void — each asserted to 403 without the grant and succeed with it.
- **Separation of duties (§7.1):** a principal with `disburse` but not `reverse`
  can pay but gets 403 on void, and vice versa.
- **Error contract:** 400 / 401 / 403 / 404 / 409 per §5.7, including the
  settlement-not-locked and illegal-transition 409s.
- **Audit (§7.2):** reads write **no** audit rows; create / line_paid / paid /
  voided each append the documented event with actor + before/after (and the
  reason on void) — asserted present for writes, absent for reads.

### 8.7 Security regression additions

The `scripts/security-regression.mjs` DB/RLS block (currently 13 checks) gains
payout-specific assertions, so the security suite proves the new invariants
independently of the integration tests:

- `UPDATE commission_payouts SET amount_base/total_payout_base …` as the app role
  is **denied by the trigger**.
- `DELETE` on `commission_payouts` / `commission_payout_lines` as the app role is
  **denied** (grant revoked).
- A payout row is invisible under the wrong / no tenant context (RLS), mirroring
  the existing users/audit_logs checks.

### 8.8 Quality gate — `pnpm verify` fully green

The phase is complete only when the full gate passes, matching prior phases:

- `lint` — ESLint clean
- `format` — Prettier clean (`prettier --write` to fix, then re-verify)
- `typecheck` — no TS errors (API + web)
- `build` — API + web build succeed
- `unit` — state-machine + amount-copy unit tests pass
- `integration` — the payout integration suite passes alongside the existing
  suites (count increases from the current 219 baseline)
- `security` — RLS / immutability security suite passes (currently 13/13), with
  the new payout immutability + isolation assertions (§8.7) included

No commit until every stage above is green; if a stage fails, report the exact
failure and the smallest safe fix before proceeding. (Note: the security
startup check needs port 3001 free — clear any stray dev server first.)

## 9. Money & precision

1F-F introduces **no new money math** — this is the deliberate consequence of §3
D1/D7. The detail:

- **Amounts are copied, never computed.** Every `amount_base` /
  `total_payout_base` is a verbatim copy of a `numeric(18,2)` value the 1F-E
  settlement already computed (per-order round-then-sum, in BigInt cents). 1F-F
  applies no rate, no rounding, no summation beyond echoing the settlement total.
- **One additive base currency.** Payout amounts are in the tenant base currency
  carried from the settlement; there is no FX, no second currency, and no
  re-conversion (§1, carried from 1F-B's frozen base values).
- **Integer-cent representation if any arithmetic is needed.** The only
  arithmetic 1F-F could perform is a sanity re-sum of line amounts to assert they
  equal `total_payout_base`; if done, it uses the existing BigInt cents helper
  (the `order-money.ts` pattern), never floats. The expectation is exact
  decimal-string equality with the settlement.
- **Precision matches upstream.** `numeric(18,2)` for money everywhere, identical
  to 1F-B/1F-D/1F-E, so a payout total and its settlement total are the same
  value at the same precision by construction.

## 10. Rollout & scope boundaries

### 10.1 Delivery order

Per the phase discipline used throughout 1F (DB → backend → frontend, each gated
green before the next), 1F-F lands as a sequence of small, separately-verifiable
commits:

1. **Plan approval (no code before this).** Migration and code are written only
   after this plan is reviewed and approved (CLAUDE.md current-phase rule).
2. **Migration `034_commission_payout.sql`** (§4) — apply UP locally, verify the
   two tables, indexes (incl. the partial unique index), RLS policies, grants
   (UPDATE present, DELETE absent), and the two freeze-money triggers exist.
   Verify DOWN once (apply → rollback → re-apply) to prove reversibility.
3. **Seed permissions** — add `commission_payouts:view` / `:disburse` /
   `:reverse` to `db/seeds/002_permissions.sql` in the finance group, and grant
   them to the Dev Admin role seed (unlike 1F-E, these codes are **new**, so a
   seed change *is* required — §5.0).
4. **Backend** — the payout module (service + controller + DTOs) extending the
   existing commission controller; `pnpm verify` to green (§8.8), commit.
5. **Security-regression additions** (§8.7) — the trigger-denies-amount-UPDATE,
   DELETE-denied, and RLS-invisibility checks added to
   `scripts/security-regression.mjs`; re-verify, commit.
6. **Frontend** — the payouts list + detail pages and the write actions (§6),
   plus the reciprocal link from the settlement detail page; re-verify, commit.
7. **Browser QA** — manually exercise the full lifecycle against the dev stack
   (create from a locked settlement → mark a line paid → mark batch paid → void
   → re-create), and the 403 paths for a viewer-only and a disburse-only
   principal. Noted as pending until done, consistent with how 1F-A/1F-E tracked
   browser QA separately from the gate.

### 10.2 Commit discipline

Explicit `git add` of the migration + seed + module + pages + plan doc; never
`git add .`; no `.env` / `dist` / logs; push to `origin/main` only after the full
`pnpm verify` gate is green (clear any stray dev server on port 3001 first, §8.8).

### 10.3 Scope boundaries (recap of §1, for the implementer)

In scope: payout records copied from a locked settlement; batch + per-line
paid/unpaid/void lifecycle; create / mark-paid / void endpoints; list + detail
pages; RBAC (`view`/`disburse`/`reverse`) + audit + RLS + money-freeze triggers.

Explicitly **out** of scope (deferred, do not build): real bank/payroll/payment
integration, tax/withholding/net-pay, recomputing or editing commission amounts,
paying unlocked/superseded settlements, clawbacks/draws/advances/multi-period
netting, an approval workflow over payouts, scheduled/auto disbursement,
cross-tenant analytics, and exports/charts.

### 10.4 Risks & mitigations

- **Drift between disbursed and owed.** Mitigated structurally: amounts are
  copied and frozen by trigger (§3 D7 / §4.5), and only a current-locked
  settlement is payable (§3 D1) — there is no path for a payout to disagree with
  its settlement.
- **Double-pay.** Mitigated by the partial unique index + idempotent create
  (§3 D5 / §4.2 / §7.5) — a structural DB guarantee, not just service logic.
- **Privilege creep (one role pays and un-pays unnoticed).** Mitigated by
  splitting `disburse` and `reverse`, with void always audited and reason-bound
  (§7.1 / §7.2).
- **In-place status mutation weakening auditability.** Mitigated by the
  append-only `audit_logs` chain capturing every transition with before/after
  (§7.2), so the full history survives despite the row being updated in place.

