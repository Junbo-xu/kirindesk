# KirinDesk

Multi-tenant SaaS platform for foreign trade customer management.

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker & Docker Compose

## Getting Started

```bash
# Copy environment variables
cp .env.example .env

# Install dependencies
pnpm install

# Start healthy infrastructure and create the MinIO bucket
docker compose up -d --wait postgres redis minio
docker compose run --rm minio-init

# Run database migrations
pnpm db:migrate

# Seed initial data
pnpm db:seed

# Start all apps in development mode
pnpm dev
```

## Database Commands

```bash
pnpm db:migrate        # Apply pending migrations
pnpm db:rollback       # Roll back the last migration
pnpm db:seed           # Run seed files (dev seeds only in NODE_ENV=development)
pnpm db:verify-chain   # Verify audit log hash chain integrity
```

## Database Roles

- `DATABASE_URL` uses the `kirindesk` superuser. Used for migrations, seeds, and CLI admin scripts only. **The API runtime must NOT use this.**
- `APP_DATABASE_URL` uses the `kirindesk_app` non-superuser role. Used by application/runtime code. RLS policies are enforced on this role.
- PostgreSQL superusers bypass RLS. Always test RLS behavior with the `kirindesk_app` role.
- The API requires `APP_DATABASE_URL` and performs a startup self-check that rejects a superuser runtime role.

## Authentication

KirinDesk uses dual JWT secrets and server-side session records for tenant/platform isolation:

- `TENANT_JWT_SECRET` — signs and verifies tenant user tokens
- `PLATFORM_JWT_SECRET` — signs and verifies platform admin tokens
- Default token expiry is 2h (development). In production, reduce to 15-30 minutes.
- Logout revokes the current session immediately; every authenticated request rechecks session, account, and tenant status.

## Quality Gate

Run `pnpm verify:fast` during development and `pnpm verify:full` before review. The full gate requires isolated PostgreSQL/Redis/MinIO services and Chromium. See `docs/quality-gate.md` for the exact test-only environment and safety checks.

Dev credentials (local development only, NOT production accounts):
- Tenant user: `admin@dev.local` / `dev-password-123` (tenant slug: `dev-tenant`)
- Platform admin: `platform@dev.local` / `dev-password-123`

These are local dev fixtures created by `pnpm db:seed`. Production platform admins must be created via CLI command.

## Project Structure

- `apps/api` — Backend API (NestJS, port 3001)
- `apps/web` — Customer-facing web app (Vite + React, port 3000)
- `apps/admin` — Admin dashboard (Vite + React, port 3002)
- `packages/` — Shared packages
- `db/` — Database migrations, seeds, policies
- `docs/` — Project documentation

## Ports

| Service    | Port |
|------------|------|
| Web        | 3000 |
| API        | 3001 |
| Admin      | 3002 |
| PostgreSQL | 5432 |
| Redis      | 6379 |
