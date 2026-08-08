# syntax=docker/dockerfile:1
ARG KIRINDESK_BUILD_COMMIT=unknown
# Phase 3A — KirinDesk API image (private deployment).
# Multi-stage: a full-workspace build stage (also reused as the one-shot migrate
# container, since it has tsx + the database package + db/migrations), and a
# minimal non-root runtime stage that only ships apps/api/dist + prod deps.

# ── base: node + pnpm via corepack ──────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo

# ── build: install the whole workspace and compile the API ──────────────────
# This stage intentionally keeps dev dependencies (nest CLI, tsx) so it can both
# build the API and run database migrations/seeds (see the `migrate` usage in
# docker-compose.prod.yml, which targets this stage).
FROM base AS build
# Copy manifests first for better layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Now copy the sources needed to build the API and to run migrations.
COPY apps/api apps/api
COPY packages/database packages/database
COPY db db
RUN pnpm --filter @kirindesk/api build

# ── deploy: produce a self-contained prod bundle for the API ────────────────
FROM build AS deploy
RUN pnpm --filter @kirindesk/api --prod deploy /prod/api

# ── runtime: minimal, non-root, runs the compiled API ───────────────────────
FROM node:22-alpine AS runtime
ARG KIRINDESK_BUILD_COMMIT
LABEL org.opencontainers.image.revision=$KIRINDESK_BUILD_COMMIT
ENV NODE_ENV=production
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
WORKDIR /app
RUN apk add --no-cache chromium font-noto font-noto-cjk
# pnpm deploy emits node_modules + package.json; bring in the compiled dist too.
COPY --from=deploy /prod/api/node_modules ./node_modules
COPY --from=deploy /prod/api/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
# Run as the built-in non-root `node` user.
USER node
EXPOSE 3001
CMD ["node", "dist/main"]
