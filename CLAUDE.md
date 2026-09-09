# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other AI tooling
when working in this repository.

## Project Overview

Umbra is a browser-layer EDR (Endpoint Detection and Response) platform for
authorized enterprise monitoring. It consists of:

- **Server** (`umbra-server/`) — Go single binary serving REST API, WebSocket
  relay, and HTTP forward proxy
- **Frontend** (`gui-next/`) — Vue 3 + Vite + Tailwind CSS v4 web panel that
  builds into `gui/dist/`
- **Extensions** (`extension/` = Umbra Sensor, `cookie-sync-extension/` =
  ShadowLink) — Chrome MV3 extensions. Embed-target host extensions live in
  the companion repo [s045pd/umbra-embed-targets](https://github.com/s045pd/umbra-embed-targets);
  fetch them with `./scripts/embed-targets/fetch.sh` when you need the embed
  packaging feature.

This is a public OSS project. **Authorized monitoring environments only** — see
[SECURITY.md](SECURITY.md).

## Architecture

### Go server (`umbra-server/`)

| Package | Purpose |
|---------|---------|
| `cmd/umbra-server` | Entry point — binary `umbra-server` |
| `internal/config` | Env-based configuration; `DATABASE_PASSWORD` is required |
| `internal/db` | GORM models, PostgreSQL migrations |
| `internal/auth` | bcrypt, gorilla/sessions, middleware |
| `internal/api` | chi router, REST endpoints, extension packaging |
| `internal/ws` | WebSocket server (port 4343), RPC handlers |
| `internal/proxy` | HTTP forward proxy (port 8080) |
| `internal/busx` | Redis pub/sub bus for multi-instance fan-out |
| `internal/utils` | Logging, shared helpers |

**Ports:** 8118 (API + GUI), 4343 (WebSocket), 8080 (HTTP forward proxy)

### Frontend (`gui-next/`)

- Vue 3 + Vite + Tailwind CSS v4 (CSS-based config via `@theme` block in
  `src/assets/styles.css`)
- Builds to `../gui/dist/`, served by the Go binary at `/`
- Vite dev proxy forwards `/api/*` and `/favicon.ico` to the running backend

### Extensions

Manifest V3, service workers, content scripts. Extension packaging
(server-side injection, obfuscation, embed) is implemented in
`umbra-server/internal/api/extension.go`.

## Common dev commands

```bash
# One-shot bootstrap (validates Go/Node/Docker, copies .env, fetches deps)
./setup.sh

# Backend
cd umbra-server
make build       # → ./bin/umbra-server
make test        # All Go tests
make test-race   # With race detector
make smoke       # Smoke test (no DB required)

# Frontend
cd gui-next
npm install
npm run dev      # http://localhost:5173, proxies /api → :8118
npm run build    # → ../gui/dist/
npm run typecheck

# Full stack
docker compose up --build  # requires DATABASE_PASSWORD in .env

# Icons
rsvg-convert -w 128 -h 128 images/umbra.svg -o images/umbra-128.png
```

## Coding conventions

- Go: `gofmt`, idiomatic error handling, `errors.Is/As` for wrapping
- TypeScript: strict mode, no `any` without justification
- Tailwind: tokens live in `gui-next/src/assets/styles.css` under `@theme`;
  components consume tokens via class names like `bg-bg-base`, `text-fg-base`,
  `bg-accent`. Don't hardcode hex literals in templates.
- Tests: PRs that change behavior should include tests. `umbra-server` uses
  `testing` + `testify`; frontend has typecheck only by default.

## When working in this repo

- After a completed update: if `umbra-server/` (or the image/stack that
  serves the API/GUI) changed, redeploy the existing Umbra service. If only
  a browser extension changed (`extension/`, `cookie-sync-extension/`), do
  not redeploy the service — reload or redistribute the extension instead.
- The Go module path is `github.com/s045pd/umbra`. The directory is
  `umbra-server/` (not `umbra/`) so it stays distinct from the repo root.
- Database password is intentionally **not** defaulted; the server fails fast
  if `DATABASE_PASSWORD` is unset. Don't add a default.
- Extension manifests describe defensive monitoring; do not introduce
  red-team-toned language ("implant", "victim", "disguise", etc.).
- The MITM root CA (`umbra-server/cassl/`) is auto-generated at first server
  boot. Never commit `*.key`, `*.crt`, or `*.pem` files.

## Companion repos

| Repo | Relationship | Fetched by |
|---|---|---|
| [`s045pd/umbra-embed-targets`](https://github.com/s045pd/umbra-embed-targets) | 12 host extensions used by the embed-packaging feature. Independent project — release cycle separate from umbra-edr. | `scripts/embed-targets/fetch.sh` (clones into gitignored `embed-targets/`) |

The fork structure intentionally keeps embed targets external. If you add new
host extensions, contribute them to `umbra-embed-targets`, not here. Local
`embed-targets/` is gitignored.

## Workflows

### Regenerate the README screenshot

`images/screenshots/login.png` is captured by an isolated demo stack — never
manually touched. To regenerate:

```bash
cd scripts/regen-screenshots
./run.sh             # full stack (Docker + Postgres + Redis + umbra-server)
./run.sh --lite      # static gui-next/ only, no backend (faster, used in CI)
```

If gui-next changes touch the login flow, regen the screenshot in the same PR.
Pipeline auto-handles SPA route fallback (copies `index.html` into `/login/`,
`/dashboard/`, `/settings/` after build).

### Fetch embed targets for the embed-packaging feature

```bash
./scripts/embed-targets/fetch.sh             # clone or fast-forward update
./scripts/embed-targets/fetch.sh --force     # nuke and re-clone
UMBRA_EMBED_TARGETS_REPO=...  fetch.sh       # override source repo
```

Then point the server at the directory: `EXTENSION_SRC_PATH=$(pwd)/embed-targets`.

## Repo layout (top-level)

```
umbra-edr/
├── umbra-server/         # Go backend
├── gui-next/             # Vue frontend (builds to gui/dist/)
├── extension/            # Umbra Sensor (main monitoring extension)
├── cookie-sync-extension/ # ShadowLink — cookie/credential sync sidecar
├── images/
│   ├── umbra.svg + umbra-{16,48,128,512}.png   # brand assets
│   └── screenshots/login.png                    # generated by regen pipeline
├── scripts/
│   ├── embed-targets/fetch.sh                   # pulls companion repo
│   ├── regen-screenshots/                       # docker + Playwright pipeline
│   └── install_*.bat                            # Windows installers (UNDER REVIEW)
├── .github/              # Issue/PR templates, Build&Push.yml workflow
├── .claude/skills/       # Project-level skills for Claude Code sessions
├── docker-compose.yaml   # Local dev stack
├── deploy.sh             # Portainer one-shot deploy (requires ENDPOINT_ID, STACK_ID)
├── setup.sh              # Dev environment bootstrap
└── README.md, LICENSE, CONTRIBUTING.md, SECURITY.md
```

## Endpoint deployment

Two paths, picked by browser. See [docs/deployment.md](docs/deployment.md)
for the full guide.

- **Microsoft Edge**: silent force-install via HKLM `ExtensionInstallForcelist`.
  The server signs CRX v3 packages with a persistent ECDSA P-256 key
  (`cassl/extkey.pem`, generated on first boot) and exposes:
  - `GET /ext/updates.xml` — Edge update manifest
  - `GET /ext/umbra-sensor.crx` — signed extension
  - `GET /ext/install-edge.bat` — turnkey BAT with the live Extension ID and
    URLs already substituted; offline template at `scripts/install_edge_silent.bat`
  Trade-off: `edge://settings` shows "Browser is managed by your organization"
  (which is appropriate disclosure for an EDR).
- **Google Chrome**: manual "Load unpacked" via developer mode. There is no
  silent path on personal Chrome 127+; the helper at
  `scripts/install_chrome_devmode.bat` automates the extract step but the
  four-click load and the per-launch developer-mode warning bubble are
  unavoidable. For silent + locked-in Chrome, use Chrome Browser Cloud
  Management (not yet implemented).

`UMBRA_PUBLIC_URL` env var configures the canonical https URL the server
embeds in the update manifest and BAT. If unset, the server infers it from
request headers (works behind most reverse proxies but pin it explicitly
in production).

## Other known TODOs

- The "Embed download" feature in the web panel depends on
  `umbra-server/tools/` (JS obfuscator). Tools dir uses `bun.lock`; if you
  need to regenerate, install bun and run `bun install` from there.
- Architecture diagram (`images/umbra-diagram.png`) was removed from the
  predecessor and not yet redrawn. Consider creating one when v0.2 ships.
- Chrome Browser Cloud Management (CBCM) enrollment for the Chrome silent
  path is not implemented. Edge covers the silent-deployment use case
  today; CBCM is a v0.2 candidate if Chrome-only fleets show up.

## Brand discipline

This is a **defensive** EDR. Every user-facing string and code identifier must
match that framing:

- Use: monitor, sensor, telemetry, endpoint, enrolled, host extension
- Avoid: implant, victim, disguise, target (as a verb), inject (as marketing
  copy), exfiltrate. Some of these terms appear in legitimate code contexts
  (`InjectScript`, `target_url`) — those are fine. Marketing/UI copy should
  not use them.

The MITM cert subject must say "Umbra MITM Root CA". The extension `name` /
`description` must reference enterprise authorized monitoring. SECURITY.md's
"Authorized Use Only" disclaimer is the project's de facto charter.
