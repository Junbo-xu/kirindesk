# KirinDesk

Multi-tenant SaaS platform for foreign trade customer management.

## Prerequisites

- Node.js >= 18
- pnpm >= 9
- Docker & Docker Compose

## Getting Started

```bash
# Copy environment variables
cp .env.example .env

# Install dependencies
pnpm install

# Start infrastructure (PostgreSQL + Redis)
docker compose up -d

# Start all apps in development mode
pnpm dev
```

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
