# Security Hardening Plan

> Status: Phase 0H planning record. This document fixes the Security Hardening
> Plan into the repository so it does not live only in chat history. It describes
> current controls, known limitations, and a production-before / commercialization-later
> roadmap. It does not claim certification or guaranteed security.
>
> KirinDesk aims to be controllable, auditable, exportable, and
> private-deployment-ready, built on mature security principles over time. We do
> not claim "absolute security", "bank-level security", "military-grade security",
> or "ISO/SOC certified".

## Phase 0H Scope

This phase is documentation only. No code, migration, database change, or
dependency change is part of Phase 0H-Docs.

Goal: record the security posture established through Phase 0G (Auth & RBAC
foundation) and the hardening work that must happen before production and after
commercialization.

The plan is grouped into:

- Controls already implemented and verified.
- Known limitations (L1-L8) with risk ratings.
- Requirements that must be completed before any production deployment.
- Improvements that can be deferred until after commercialization.

## Implementation Status

- **Phase 0I-A — Remove JWT fallback (implemented).** The fallback dev secrets
  are removed. Both `TENANT_JWT_SECRET` and `PLATFORM_JWT_SECRET` are required
  via `requireEnv`; the API fails to start if either is missing. Token
  expiration still defaults to `2h` (expiry is not a secret). Addresses L3.
- **Phase 0I-B — Runtime DB role self-check (implemented).** On startup, before
  listening, the API queries its own database role over `APP_DATABASE_URL` and
  refuses to start if that role is a superuser. The error message does not
  include the connection string or password.
- **Phase 0I-C — Audit logs permission hardening (implemented).** Migration
  `023_revoke_audit_log_modify.sql` revokes `UPDATE, DELETE ON audit_logs FROM
  kirindesk_app`. The app role retains `INSERT` / `SELECT` on `audit_logs`,
  `USAGE` on `audit_logs_id_seq`, and `UPDATE` on `audit_log_chains` (required by
  the hash-chain writer). The `no_modify_audit_logs` trigger and all RLS policies
  are unchanged. Addresses L4.

## Audit Logs Multi-Layer Protection Model

After Phase 0I-C, `audit_logs` is protected against modification by several
independent layers, observed in this order for the application role:

1. **Privilege layer.** The `kirindesk_app` role has no `UPDATE` / `DELETE`
   privilege on `audit_logs`. Such a statement is rejected with
   `permission denied for table audit_logs` before any row is examined.
2. **RLS layer.** `audit_logs` has `FORCE ROW LEVEL SECURITY` and defines only
   SELECT and INSERT policies. There is no UPDATE/DELETE policy usable by the app
   role, so even with the privilege present, an app-role UPDATE/DELETE matches
   zero rows (affects 0 rows, no row becomes visible to modify).
3. **Trigger layer (fallback).** `no_modify_audit_logs` raises
   `audit_logs table is append-only` on any `UPDATE`/`DELETE` that reaches a row.
   This is the backstop if the privilege or RLS layer is ever loosened. It fires
   on the superuser/owner path, where RLS is bypassed and rows are visible.

Inherent limitation (L1 / L2): a PostgreSQL **superuser or table owner** can
disable the trigger and bypass RLS, so none of these layers stop a high-privilege
credential holder. This is a property of the PostgreSQL permission model, not a
code defect. The effective defense is therefore operational: production must
strictly limit who holds `DATABASE_URL`, owner, or superuser credentials, and
should pursue external hash anchoring / WORM storage (see roadmap).

## Current Security Controls Already Implemented

Verified by direct source inspection during Phase 0G and Phase 0H planning.

- **Runtime connection isolation.** The API runtime creates a single `APP_POOL`
  that reads only `APP_DATABASE_URL`; it throws on startup if that variable is
  missing. No superuser pool exists in the runtime. All services
  (Auth, PlatformAuth, Audit, RBAC) inject `APP_POOL`.
- **Restricted app role.** `kirindesk_app` is `NOSUPERUSER NOCREATEDB NOCREATEROLE`
  with privileges scoped to the `public` schema.
- **Row Level Security.** Eleven tenant tables use `ENABLE` + `FORCE ROW LEVEL
  SECURITY` with tenant-isolation policies based on `app_current_tenant_id()`.
  Tenant context is injected per-transaction via `set_config(..., true)` and
  cleared automatically at transaction end.
- **Audit append-only (application layer).** A `BEFORE UPDATE OR DELETE` trigger
  on `audit_logs` raises an exception. Under the app role, UPDATE/DELETE are
  rejected (verified in Phase 0G).
- **Audit hash chain.** Writes take a `FOR UPDATE` row lock on the chain, compute
  a SHA-256 over a fixed field order, insert the row, and advance the chain hash.
- **Audit INSERT actor constraints.** RLS INSERT policies split by actor type so
  tenant users, platform admins, and the internal system writer can only insert
  rows consistent with their context.
- **Dual JWT secrets.** Tenant tokens use `TENANT_JWT_SECRET`; platform tokens
  use `PLATFORM_JWT_SECRET`. Each strategy validates `payload.type` and rejects
  cross-type tokens. Expiration is enforced.
- **Login anti-enumeration.** Failed logins still run a dummy bcrypt comparison
  and return a uniform error. Disabled accounts are rejected for both tenant and
  platform logins.
- **System context is single-sourced.** The `system` actor context is set in
  exactly one place: the audit chain writer.

## Known Limitations and Backlog

These are recorded limitations, not active bugs. L1, L2, and L7 are inherent to
the PostgreSQL permission model and the current single-database design; they are
addressed by operational controls and future roadmap items rather than an
application code fix.

- **L1 — superuser/owner can bypass audit append-only.** A PostgreSQL superuser
  or table owner can run `ALTER TABLE audit_logs DISABLE TRIGGER ...`, modify or
  delete rows, then re-enable the trigger. Append-only strength therefore depends
  on who holds high-privilege credentials, not on the trigger alone.
- **L2 — superuser can bypass RLS.** `FORCE ROW LEVEL SECURITY` binds the table
  owner, but a superuser always bypasses RLS. Tenant isolation is effective for
  the app role, not for a holder of superuser credentials.
- **L3 — JWT fallback dev secrets.** The code falls back to predictable dev
  secrets when the JWT environment variables are unset. In production this could
  silently sign/verify tokens with a weak, guessable secret. Must be removed
  before production.
- **L4 — app role has UPDATE/DELETE on audit_logs.** The app role currently
  holds table-level UPDATE/DELETE on `audit_logs`, so append-only relies solely
  on the trigger. Defense-in-depth is missing: privileges should not grant
  UPDATE/DELETE in the first place.
- **L5 — audit_logs currval workaround.** The chain writer uses
  `currval('audit_logs_id_seq')` instead of `RETURNING id`, a workaround for a
  RLS SELECT-policy conflict. It is correct under current logic but fragile and
  should be revisited.
- **L6 — production credentials in repo.** Development credentials (including the
  app role password) appear in `.env.example` and in a migration file. Production
  credentials must never be stored in migration files or the repository.
- **L7 — audit hash chain has no external anchor.** The chain detects in-chain
  tampering that is not recomputed, but a superuser could disable the trigger,
  rewrite rows, recompute the whole chain, and refresh the stored chain hash so
  it is self-consistent again. Without an external anchor (off-site / WORM /
  third-party timestamp), tamper-resistance does not hold against a superuser.
- **L8 — no login rate limiting or lockout.** Anti-enumeration via dummy bcrypt
  is in place, but there is no throttling, account lockout, or anomaly alerting,
  so large-scale probing is not actively mitigated.

## Risk Rating

| ID | Limitation | Risk | Trigger condition |
|----|------------|------|-------------------|
| L3 | JWT fallback dev secrets | High (production-before) | Production env missing JWT secrets |
| L6 | Credentials in repo / migration | High (production-before) | Deploying current repo values to production |
| L1 | superuser bypass of append-only | Medium (architectural) | Superuser credential leak / misuse |
| L2 | superuser bypass of RLS | Medium (architectural) | Same as L1 |
| L4 | app role UPDATE/DELETE on audit_logs | Medium | Trigger disabled or dropped |
| L7 | hash chain has no external anchor | Medium | High-privilege insider threat |
| L5 | currval workaround | Low | Write path logic changed |
| L8 | no rate limiting / lockout | Low | Large-scale probing |

## Production-Before Requirements

All of the following must be completed before any production deployment.

- Remove JWT fallback and fail startup if JWT secrets are missing in production
  (L3). No predictable default secret may be used.
- Move production credentials out of the repo and migration files into a secret
  management system (L6).
- Ensure the runtime API only uses `APP_DATABASE_URL` / `kirindesk_app`.
- Ensure `DATABASE_URL` (superuser) is restricted to migration / seed / CLI
  environments only and is never injected into the app container.
- Ensure the production app container never receives superuser / owner
  credentials.
- Add a runtime startup self-check that fails to start if the current database
  role is a superuser.
- Separate runtime / migration / owner database roles.
- Revoke the app role's UPDATE/DELETE privileges on `audit_logs`, leaving only
  INSERT/SELECT, so append-only is enforced by both privileges and trigger (L4).
- Define a backup and restore plan, including restore rehearsal. Audit data
  should use WORM / immutable storage where possible.

## Commercialization-Later Improvements

These can be deferred until after commercialization without blocking an initial
production deployment, provided the production-before requirements are met.

- External audit hash anchoring / WORM storage to make full-chain recomputation
  detectable from outside the database (addresses L1 / L7).
- A separate audit schema or a dedicated audit database, physically isolating
  audit data from business data.
- A `NOLOGIN` owner role for sensitive audit tables, so no one routinely holds a
  login able to disable the trigger.
- Login throttling, account lockout, and anomaly alerting (addresses L8).
- Token refresh and revocation mechanism (current tokens only expire after a
  fixed window with no active revocation).
- Revisit the `audit_logs` `currval` workaround: consider restoring
  `RETURNING id` paired with a system SELECT policy (addresses L5).

## Audit Append-Only Limitation

The `audit_logs` append-only guarantee is effective against the application
layer: under the `kirindesk_app` role, UPDATE and DELETE are rejected by the
`no_modify_audit_logs` trigger.

It is not absolute against a PostgreSQL superuser or table owner. Such a role can
disable the trigger, change or delete rows, recompute the hash chain, and
re-enable the trigger (L1 / L7). This is an inherent property of the PostgreSQL
permission model, not a defect in the current code.

The real defenses are operational and architectural, not a single trigger:

- The application must never hold superuser credentials.
- `DATABASE_URL` (superuser) access must be tightly controlled and limited to
  migration / seed / CLI environments.
- Future work should add external hash anchoring / WORM storage and isolated
  audit storage so that tampering by a high-privilege actor is externally
  detectable.

## Runtime Database Credential Rules

- The runtime API uses `APP_DATABASE_URL` (the `kirindesk_app` role) only.
- `DATABASE_URL` (superuser) is for migration, seed, and CLI/admin scripts only.
- The production app container must never receive superuser or owner credentials.
- A startup self-check should confirm the runtime DB role is not a superuser and
  refuse to start otherwise.
- Migration, runtime, and owner roles should be separated so that day-to-day
  application access cannot perform DDL or disable protections.

## Production Role Naming Caveat

- The local migration `023_revoke_audit_log_modify.sql` hard-codes the role name
  `kirindesk_app`.
- If a production environment uses a different application role name, the revoke
  will not match the real role and the hardening will not take effect. This must
  be handled in the deployment strategy.
- Recommended: keep the runtime application role named `kirindesk_app` in
  production, or provide a controlled deployment script that applies the
  equivalent `REVOKE UPDATE, DELETE ON audit_logs` against the actual role.
- Do not hand-edit a migration after it has been applied: the migration runner
  records a checksum and will refuse to run if an applied file's content changes.
  To change an applied migration, roll it back first.

## Deployment Security Checklist

To be satisfied before a production deployment:

- [ ] The app container is injected with `APP_DATABASE_URL` only.
- [ ] The app container is never injected with `DATABASE_URL`.
- [ ] `DATABASE_URL` is used only for migration / seed / CLI operations.
- [ ] Production secrets are not stored in the repository.
- [ ] Production database passwords are not written into migration files.
- [ ] Runtime / migration / owner database roles are separated.
- [ ] Superuser is reserved for emergency operations and never enters the
      day-to-day application environment.
- [ ] A backup and restore plan (including restore rehearsal) is completed.
- [ ] Audit data uses, or has a roadmap toward, WORM / external hash anchoring.

## Auth/RBAC Hardening Checklist

Already implemented and verified:

- [x] Dual JWT secrets with full tenant / platform separation.
- [x] Token type validation; cross-type tokens rejected.
- [x] Token expiration enforced.
- [x] Login anti-enumeration via dummy bcrypt and uniform error responses.
- [x] Disabled accounts rejected (tenant and platform).
- [x] RBAC permission checks run inside tenant RLS context.
- [x] `system` actor context confined to the audit chain writer.

To be hardened:

- [x] Remove JWT fallback secrets; fail startup if secrets are missing in
      production (L3). — Done (Phase 0I-A).
- [ ] Add login throttling / account lockout / anomaly alerting (L8).
- [ ] Add token refresh / revocation mechanism.

## Next Recommended Phase

Phases 0I-A (L3), 0I-B (startup self-check), and 0I-C (L4 audit log permission
hardening) are implemented. The remaining work is deployment-process and
roadmap, not application code:

Recommended sequence:

1. L3 + startup self-check (code only, no schema change). — Done (Phase 0I-A / 0I-B).
2. L6 + secret management + role separation (deployment process).
3. L4 (new migration). — Done (Phase 0I-C).
4. Backup / restore plan and rehearsal.
5. Commercialization-later improvements as the roadmap allows.

Do not proceed to any of these execution steps without explicit approval.
