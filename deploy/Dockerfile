# syntax=docker/dockerfile:1
#
# Eventor API — multi-stage image.
#
# Base image: node:22-bookworm-slim (glibc), NOT node:22-alpine.
# Reason: this project has two native dependencies — `sharp` (libvips) and
# `argon2` (node-gyp / prebuilds). Both publish prebuilt binaries for
# linux-x64/arm64 **glibc**; on Alpine (musl) npm/pnpm either pulls the musl
# variant (sharp) or falls back to compiling argon2 from source, which needs
# python3 + build-base in the image. bookworm-slim avoids that whole class of
# "works on my machine" failures for a few extra MB.
#
# Build context is the REPOSITORY ROOT (backend/), not deploy/:
#   docker build -f deploy/Dockerfile -t eventor-api:latest .
#
# Node >= 22.12 and pnpm 12.4.1 are pinned to match package.json
# ("engines.node" and "packageManager").

ARG NODE_IMAGE=node:22-bookworm-slim

# ─────────────────────────────────────────────────────────────
# base — corepack + pnpm pinned, shared by every later stage
# ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /app

# ─────────────────────────────────────────────────────────────
# deps — full dependency tree (dev deps included, needed to build)
# ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# .npmrc is optional; the wildcard keeps the build working when it is absent.
COPY .npmrc* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─────────────────────────────────────────────────────────────
# build — nest build -> dist/
# ─────────────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ─────────────────────────────────────────────────────────────
# prod-deps — runtime dependencies only
# ─────────────────────────────────────────────────────────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
COPY .npmrc* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# ─────────────────────────────────────────────────────────────
# runtime
# ─────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

# wget/curl for HEALTHCHECK, tini for correct signal handling (the app relies on
# enableShutdownHooks() to close the BullMQ worker and the DB pool cleanly).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_ROOT=/data/storage \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# Non-root user, fixed uid/gid so the bind-mounted storage volume keeps a
# predictable owner on the host.
RUN groupadd --gid 1001 eventor \
 && useradd --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin eventor

WORKDIR /app

# pnpm is kept in the runtime image so `pnpm migration:run:prod` can be run
# inside the container (`docker compose exec api pnpm migration:run:prod`).
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate

COPY --chown=eventor:eventor package.json pnpm-lock.yaml ./
COPY --from=prod-deps --chown=eventor:eventor /app/node_modules ./node_modules
COPY --from=build     --chown=eventor:eventor /app/dist        ./dist
# Not compiled, but read at runtime: invoice-pdf.ts resolves the bundled Noto
# Naskh Arabic fonts as ../../assets/fonts/ relative to dist/bookings/, so
# invoice generation fails with ENOENT if assets/ is left out of the image.
COPY --chown=eventor:eventor assets ./assets

# STORAGE_ROOT must be writable by the app user and live outside any web root.
RUN mkdir -p /data/storage && chown -R eventor:eventor /data

USER eventor
EXPOSE 3000

VOLUME ["/data/storage"]

# The API mounts everything under the global prefix /api/v1; the liveness route
# is GET /api/v1/health/live (see src/health/health.controller.ts).
# Use /api/v1/health/ready instead if you want the DB checked too — but note a
# DB blip would then restart the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/health/live || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main"]
