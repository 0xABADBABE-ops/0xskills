---
name: zai-docker-deploy
description: Turn a Z.ai "ZAI delivery" CI-CL workspace .tar (a Next.js app shipped with .zscripts/build.sh + start.sh + Caddyfile, no Dockerfile) into a runnable Docker image — build, boot, bootstrap, deploy, run. Use when handed a workspace-*.tar with .zscripts/ and asked to run it in Docker.
---

# ZAI delivery → Docker

## When to Use
- Given a `workspace-*.tar` (or extracted git snapshot) that is a Z.ai "ZAI" CI-CL deployment — recognizable by `.zscripts/build.sh`, `.zscripts/start.sh`, `Caddyfile`, `next.config.ts` with `output: "standalone"`.
- Asked to write a Docker image, boot it, bootstrap + deploy the attached artifact, and run it in a container.

## How a ZAI delivery works
- **Build** (`.zscripts/build.sh`): `bun install` → `next build` (standalone) → bundle `next-service-dist/` + `db/custom.db` (SQLite) + `Caddyfile` + `start.sh` into a deploy artifact. Skips `python-runtime` (no `*.py`/`requirements.txt`) and `mini-services` (empty dir) when absent.
- **Run** (`start.sh`): `bun server.js` on `:3000` → `caddy run` on `:81` (reverse proxy → `localhost:3000`). DB at `/app/db/custom.db`. Runtime needs only **bun + caddy + python** — node is not required (`bun server.js` runs the standalone server).

## Procedure
1. Extract: `tar -xf workspace-*.tar -C <dir>`.
2. Confirm structure: `package.json`, `bun.lock`, `.zscripts/build.sh`, `.zscripts/start.sh`, `Caddyfile`, `prisma/schema.prisma`, `db/custom.db`.
3. Copy `templates/Dockerfile`, `templates/.dockerignore`, `templates/docker-compose.yml` into `<dir>` verbatim. Change only `image`/`container_name` and the host port.
4. Build — bootstrap (bun install + prisma generate) and deploy (build.sh → artifact) both happen here: `docker compose build`.
5. Boot + run: `docker compose up -d`.
6. Verify: `docker compose logs -f <service>` (look for `Next.js 服务器已启动` and Caddy `serving initial configuration`), then `curl -sI http://localhost:8081` and `curl -sI http://localhost:3000` — both 200.
7. Bootstrap/dev (optional, hot reload, needs local bun): `bun install && bun run db:push && bun run dev`.

## Pitfalls
- Do not mount an empty named volume over `/app/db` on first boot — it hides the packaged `db/custom.db` and `start.sh` aborts ("未找到打包后的数据库文件"). Seed the volume first or omit it.
- Runtime `DATABASE_URL` must be `file:/app/db/custom.db` (absolute, in-container). The build-time `.env` value `file:/home/z/my-project/db/custom.db` is wrong at runtime.
- Caddy listens on `:81` inside the container — map it (`8081:81`); the app is not served on host `:3000` through Caddy.
- **Caddy 502 = `localhost` resolving to `::1`.** Docker pre-sets `HOSTNAME` to the container hostname, so `start.sh`'s `HOSTNAME="${HOSTNAME:-0.0.0.0}"` fallback never applies and Next binds IPv4-only, while the delivery Caddyfile dials `[::1]:3000`. The Dockerfile template forces `HOSTNAME=0.0.0.0` and rewrites `localhost:` → `127.0.0.1:` in `/app/Caddyfile`.
- AI stages (`analyze`/`interview`/`matrix`/`document`/`registry-verify`) call `z-ai-web-dev-sdk` (`ZAI.create()`) and need Z.ai platform creds (`.z-ai-config` / injected env) — absent in local Docker. UI, audit CRUD, catalog, and the SQLite DB all work; only LLM calls error offline.
- Keep `output: "standalone"` in `next.config.ts` — `build.sh` self-heals if missing, but fails on purpose if a different `output` is declared.
- Python/uv and mini-services are optional — the build skips them cleanly when absent. Don't force uv into the runtime.
- Run `next build` under bun (the ZAI toolchain), not a bare node image — the `build` npm script already does `next build` + static/public copy.
- Add `db:generate` before `next build` — `next build` imports `@prisma/client` and fails "did not initialize" otherwise.
- Windows host: use Docker Desktop (Linux containers). The `.sh` scripts run inside Linux regardless of host OS.

## Templates
`templates/Dockerfile`, `templates/docker-compose.yml`, `templates/.dockerignore` — copy verbatim; only change names/ports.
