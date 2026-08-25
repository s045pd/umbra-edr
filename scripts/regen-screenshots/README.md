# Screenshot Regeneration Pipeline

Automated Playwright pipeline that produces fresh product screenshots for the
Umbra EDR repository.  Screenshots are intentionally **not** bundled in the
source tree (operator privacy); this pipeline lets any contributor regenerate
them from a clean ephemeral environment.

---

## Quick start

```bash
cd scripts/regen-screenshots
./run.sh
```

Output lands in `images/screenshots/` (relative to the repo root).

---

## Prerequisites

| Tool | Required for | Install |
|------|-------------|---------|
| Node.js 18+ | Playwright | https://nodejs.org |
| npm | dependency install | bundled with Node |
| Docker + Docker Compose | full-stack mode | https://docs.docker.com/get-docker/ |

Docker is **optional** — see [Lite mode](#lite-mode-no-docker) below.

---

## Operating modes

### Full-stack mode (default)

```
run.sh
  └─ seed.sh              # generate DB password, npm build, docker compose up
  └─ capture.mjs          # Playwright → http://localhost:8218
  └─ cleanup (trap)       # docker compose down --volumes
```

`seed.sh` generates a random 40-hex-character database password each run and
writes it to `/tmp/umbra-demo-password.txt`.  The demo stack uses **ports that
do not collide with production**:

| Service | Demo port | Production port |
|---------|-----------|-----------------|
| API + GUI | 8218 | 8118 |
| WebSocket | 4443 | 4343 |
| HTTP Proxy | 8180 | 8080 |
| PostgreSQL | 5433 | 5432 |
| Redis | 6380 | 6379 |

The Go server performs GORM AutoMigrate and creates a default admin user on
first boot.  Admin credentials are printed to the container log:

```
umbra-demo-server | default admin user created — username: admin  password: <generated>
```

### Lite mode (no Docker)

If Docker is unavailable (or fails), run:

```bash
./run.sh --lite
```

Lite mode:
1. Runs `npm run build` in `gui-next/`, producing `gui/dist/`.
2. Serves `gui/dist/` on `localhost:9218` via `http-server` (or Python's
   `http.server` as a fallback).
3. Captures the `/login` page from the static bundle.

The screenshot in this mode shows the login UI without a live backend, so the
login form will render but API calls will fail.  For a visually complete
screenshot of the login page that is fine.

`run.sh` falls back to lite mode automatically when `docker` is not on `PATH`.

---

## What is captured

| File | Route | Description |
|------|-------|-------------|
| `login.png` | `/login` | Login page at 1280×800 |

Adding more shots: extend the `shots` array in `capture.mjs`.  Each entry
needs `name`, `path`, `waitFor(page)`, and `file`.

---

## Files

```
scripts/regen-screenshots/
├── README.md                  this file
├── docker-compose.demo.yaml   isolated demo stack definition
├── package.json               Playwright dependency
├── capture.mjs                Playwright screenshot script
├── seed.sh                    password generation + stack startup
└── run.sh                     top-level orchestrator
```

---

## Idempotency

`run.sh` is safe to run multiple times:

- It tears down any existing `umbra-demo` compose project before starting.
- It generates a fresh password on every run.
- `npm install` is skipped if `node_modules` is already present.
- Playwright's `install chromium` is idempotent.

---

## CI usage

In CI environments without Docker, add `--lite` to the run command:

```yaml
- name: Regenerate screenshots
  run: |
    cd scripts/regen-screenshots
    npm install
    npx playwright install --with-deps chromium
    ./run.sh --lite
```

---

## Troubleshooting

**`docker: command not found`**
Run in lite mode: `./run.sh --lite`

**`umbra-demo-server` fails to start**
Check container logs:
```bash
docker compose -f scripts/regen-screenshots/docker-compose.demo.yaml \
  --project-name umbra-demo logs umbra-demo-server
```

**Chromium install fails in restricted network**
Set `PLAYWRIGHT_BROWSERS_PATH` to a directory with a pre-installed Chromium, or
use the system Chromium by setting `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

**`login.png` is blank / very small**
The SPA may have rendered before JavaScript hydration completed.  Increase
`TIMEOUT` at the top of `capture.mjs` and re-run.
