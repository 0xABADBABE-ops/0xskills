# syntax=docker/dockerfile:1

# ============================================================================
# ZAI delivery -> Docker image
#
# Stage 1 "build"   : replays the ZAI CI sandbox (`.zscripts/build.sh`) inside
#                     a Linux build env (bun + python + uv + perl), producing
#                     the deploy artifact at /tmp/build_fullstack_<BUILD_ID>.
# Stage 2 "runtime" : the ZAI deploy runner — artifact mounted at /app, booted
#                     by the artifact's own `start.sh` (Next.js :3000 + Caddy :81).
# ============================================================================

# ---- build ----------------------------------------------------------------
FROM oven/bun:1.3 AS build

ARG BUILD_ID=local
ENV BUILD_ID=$BUILD_ID \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/home/z/my-project/db/custom.db

# build.sh / python-runtime-build.sh / database-runtime-build.sh need:
#   bash, perl (standalone self-heal), python3 + uv (python runtime), curl, tar.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash curl ca-certificates perl python3 python3-pip procps \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /home/z/my-project
COPY . .

# Prisma client must exist before `next build` compiles db.ts. build.sh then
# does bun install (no-op) + `next build` + standalone self-heal + db push.
RUN bun install \
    && bun run db:generate \
    && bash .zscripts/build.sh

# ---- runtime --------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime

ARG BUILD_ID=local

# start.sh needs: bun (server.js), caddy (reverse proxy), python (if the
# artifact carries a python-runtime), ps/kill (procps) for graceful shutdown.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates caddy python3 procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /tmp/build_fullstack_${BUILD_ID} /app
# Local-Docker adaptation: the delivery Caddyfile reverse-proxies `localhost`,
# which resolves to ::1 here, but Next binds IPv4 only. Point Caddy at 127.0.0.1.
RUN chmod +x /app/start.sh \
    && sed -i 's/localhost:/127.0.0.1:/g' /app/Caddyfile

# HOSTNAME is pre-set by Docker to the container hostname; start.sh uses
# HOSTNAME (not the 0.0.0.0 fallback) to bind Next. Force all-interfaces IPv4.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0
EXPOSE 81 3000
ENTRYPOINT ["/app/start.sh"]
