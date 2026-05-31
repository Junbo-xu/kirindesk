# Quality Gate

This document describes KirinDesk's local quality gate and the future CI
strategy. The gate combines the checks built in Phase 0J (lint, format,
typecheck, build, unit / integration / security tests) into a small set of
repeatable commands.

> **Prerequisite for `verify:full`:** PostgreSQL must already be running
> locally (`docker compose up -d postgres`). The verify scripts never start or
> stop containers themselves — see [Data safety boundary](#data-safety-boundary).

## Overview

Two layers, split by whether they need Docker / a database:

| Layer         | When to run                               | Needs Docker/DB |
| ------------- | ----------------------------------------- | --------------- |
| **fast gate** | Frequently, after each change             | No              |
| **full gate** | Before commit, phase switch, auth/db work | Yes (postgres)  |

- **fast gate** keeps the inner loop quick: static checks + build + unit tests,
  no database.
- **full gate** adds the integration and security suites that lock in the
  tenant-isolation, RLS, and append-only-audit invariants. These need a live
  PostgreSQL and an isolated `kirindesk_test` database.

## Commands

| Command             | Expands to                                                      |
| ------------------- | --------------------------------------------------------------- |
| `pnpm verify:fast`  | `lint && format:check && typecheck && build && test:unit`       |
| `pnpm verify:full`  | `verify:fast && test:integration && test:security`              |
| `pnpm verify`       | alias for `verify:full` (default is the complete gate)          |

`verify:full` runs serially with `&&` (fail fast). `test:integration` runs
**before** `test:security` because the security script reuses the
`kirindesk_test` database that the integration setup builds and seeds.

<!-- PLACEHOLDER_WHEN -->

## When to run which

### Run `verify:fast`

Day-to-day, after each change. It is the quick feedback loop and touches no
database, so it is safe to run anytime without Docker.

### Run `verify:full`

- Before any commit that includes code.
- Before switching phases.
- After any change to **auth, RBAC, audit, or database** code. These directly
  affect tenant isolation, the audit hash chain, and RLS, which the security
  regression suite is specifically designed to protect. A green `verify:full`
  is the evidence that those invariants still hold.

### docs-only changes

If `git diff --name-only` shows only Markdown / `docs/` files, the full gate is
unnecessary. At most run `pnpm format:check` (and only if a `.ts` file under the
formatter's glob changed). Pure `.md` edits need no build or tests — confirm the
diff is docs-only and proceed.

<!-- PLACEHOLDER_SAFETY -->

## Data safety boundary

The quality gate must never touch development or production data.

- **`verify:full` uses `kirindesk_test` only.** The integration setup and the
  security script both assert `current_database() = 'kirindesk_test'` before any
  write, and refuse to run otherwise.
- **`kirindesk_dev` is never written.** No gate connects to it, cleans it, or
  seeds it.
- **No production database, ever.** Connection config is env-first
  (`TEST_DATABASE_URL` / `TEST_APP_DATABASE_URL`) with a local-dev fallback that
  is hardcoded to `localhost .../kirindesk_test`. Production connection strings
  never appear on the gate path. The API runtime reads `APP_DATABASE_URL` only,
  and the security suite proves the API refuses to start under a superuser role.
- **`test:integration` rebuilds `kirindesk_test` every run** (DROP / CREATE /
  migrate / seed a minimal fixture), so each run is fully isolated.
- **`test:security` depends on `test:integration` running first.** It reuses the
  `kirindesk_test` that integration built; its precondition check reports
  "run `pnpm test:integration` first" if the database or fixture is missing.

### Docker is not auto-started

`verify:full` does **not** start or stop containers. If PostgreSQL is not
running, it fails with a clear hint:

```
docker compose up -d postgres
```

This is deliberate: the gate never mutates your local environment (no implicit
`docker compose up`, no container teardown). Start postgres yourself, then run
the gate.

<!-- PLACEHOLDER_CI -->

## CI strategy (draft)

This is a **draft only**. No CI is configured yet: there is no git remote, no
`.github/workflows`, and no `gh` setup. This section is the plan for when a
remote exists. Nothing here is active.

When CI is set up, a single workflow runs the same gate on push / PR:

1. Checkout, set up Node + pnpm, `pnpm install`.
2. `pnpm verify:fast` (no database needed).
3. Start a PostgreSQL service, then `pnpm test:integration` and
   `pnpm test:security`.

Only **one service** is needed today: `postgres`. Nothing in the current test
path uses Redis, so it is omitted until a later phase introduces it.

Sketch (illustrative, not committed anywhere — do not copy into `.github/`
during Phase 0J):

```yaml
# DRAFT — not active. For reference only.
name: ci
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: kirindesk
          POSTGRES_PASSWORD: ci_test_password   # CI test value, NOT production
          POSTGRES_DB: kirindesk_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U kirindesk"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      # Test-only connection strings, injected into the test process. The
      # runtime never receives a global DATABASE_URL / APP_DATABASE_URL here.
      TEST_DATABASE_URL: postgresql://kirindesk:ci_test_password@localhost:5432/kirindesk_test
      TEST_APP_DATABASE_URL: postgresql://kirindesk_app:ci_app_test_password@localhost:5432/kirindesk_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify:fast
      - run: pnpm test:integration
      - run: pnpm test:security
```

<!-- PLACEHOLDER_CI2 -->

### CI constraints

- **No deploy.** CI runs the verify gate only. It must not deploy, publish, or
  push anywhere. Deployment is a separate, future, explicitly-approved phase.
- **Test secrets only.** All credentials in CI are throwaway test values. No
  production secret is ever placed in CI config or repository secrets.
- **`kirindesk_app` password is migration-owned.** Migration `000_app_role.sql`
  creates the restricted role with a fixed password
  (`kirindesk_app_dev_password`). The `TEST_APP_DATABASE_URL` in CI must use
  that same password so the role can log in. (The draft above uses a
  placeholder; align it with the migration when CI is actually wired up, or
  parameterize the role password in the migration first.)
- **Isolated test DB.** CI uses its own ephemeral `kirindesk_test` inside the
  service container — never a shared dev or production database.
- **No remote / secrets yet.** Until a remote and CI secrets exist, this draft
  cannot run. Do not create `.github/workflows` during Phase 0J just to have it
  sit dead.

## Future Claude Code Agent Team / Workflows

Planning notes only. Nothing here is enabled in Phase 0J.

- Agent Team is initially limited to **read-only** work: review, test-result
  analysis, risk re-checks, and documentation tidying.
- Agents must **not** auto-create migrations, change the database, commit to
  Git, deploy, or modify `CLAUDE.md` / `.claude/`.
- Workflows / Hooks are initially limited to **reminders and checks**: they do
  not auto-modify files, do not auto-commit, and do not auto-run destructive
  commands.
- A dedicated **Phase 0J-F — Agent Team / Workflow Plan** should be planned
  after Phase 0J Closure.
- No agent, workflow, hook, or `.github` configuration is created in this phase.
