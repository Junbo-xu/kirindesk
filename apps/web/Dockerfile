# syntax=docker/dockerfile:1
ARG KIRINDESK_BUILD_COMMIT=unknown
# Phase 3A — KirinDesk Web image (private deployment).
# Builds the Vite/React static bundle, then serves it from nginx. nginx also
# reverse-proxies /api to the API container so the app is same-origin and the
# existing relative `/api` client paths work unchanged (plan §1.1).

# ── build: compile the static bundle ────────────────────────────────────────
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @kirindesk/web...
COPY apps/web apps/web
RUN pnpm --filter @kirindesk/web build

# ── runtime: nginx serving the static bundle + /api reverse proxy ───────────
FROM nginx:1.27-alpine AS runtime
ARG KIRINDESK_BUILD_COMMIT
LABEL org.opencontainers.image.revision=$KIRINDESK_BUILD_COMMIT
# Site config lives in the repo so the proxy target is reviewable/versioned.
COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
# nginx:alpine already defines a sane CMD; keep the default.
