<p align="center">
  <img src="./images/umbra.svg" height="100" width="100" alt="Umbra logo" />
</p>

<h1 align="center">Umbra</h1>
<p align="center"><strong>Browser-layer EDR · Light through shadow</strong></p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

---

> **AUTHORIZED USE ONLY**
>
> Umbra is a dual-use security tool. It must only be deployed in environments
> where you have **explicit legal authorization** to monitor the browsers in
> question — such as corporate-owned devices under an acceptable-use policy,
> security research labs, or CI/CD systems you operate. Deploying Umbra against
> browsers you do not own or are not authorized to monitor may violate the
> Computer Fraud and Abuse Act, the GDPR, and analogous laws in your
> jurisdiction. See [SECURITY.md](SECURITY.md) for the full responsible-use
> statement.

---

## What is Umbra?

Umbra is an enterprise browser-layer EDR (Endpoint Detection and Response)
platform. It provides real-time visibility into browser activity across
endpoints via a Chrome extension that communicates with a central server over
WebSocket. Security and IT teams can capture keystroke logs, screenshots, audio
sessions, cookies, history, and bookmarks from enrolled browsers, and can proxy
HTTP traffic through any enrolled endpoint for investigation.

The system is fully self-hosted: a single Go binary serves the REST API, the
Vue 3 web panel, the WebSocket relay, and the HTTP forward proxy.

---

## Architecture

| Component | Stack | Location | Port |
|-----------|-------|----------|------|
| **Server** | Go · chi · GORM · nhooyr/websocket | `umbra-server/` | 8118 (API + GUI) · 4343 (WS) · 8080 (proxy) |
| **Frontend** | Vue 3 · Vite · Tailwind CSS v4 · TypeScript | `gui-next/` | builds to `gui/dist/` |
| **Main Extension** | Chrome MV3 · service worker · content scripts | `extension/` | — |
| **Cookie Sync** | Chrome MV3 standalone extension | `cookie-sync-extension/` | — |
| **Embed Targets** | 12 host extensions (separate public repo, fetched on demand) | [`s045pd/umbra-embed-targets`](https://github.com/s045pd/umbra-embed-targets) | — |

**Services (Docker Compose):** PostgreSQL 15 · Redis (Alpine)

For deeper documentation see:
- [`umbra-server/README.md`](umbra-server/README.md) — Go server layout, Makefile targets, test approach
- [`gui-next/README.md`](gui-next/README.md) — Vue 3 frontend design, components, routes

---

## Quick Start

### Docker Compose (recommended)

Requires Docker and Docker Compose.

```bash
git clone https://github.com/s045pd/umbra-edr.git
cd umbra-edr
cp .env.example .env
# Edit .env — set DATABASE_PASSWORD to a strong password (required)
docker compose up --build
```

The first launch prints generated admin credentials to stdout:

```
umbra-server | default admin user created — username: admin  password: <generated>
```

Open [http://localhost:8118](http://localhost:8118) and rotate the password immediately.

> **Note:** `DATABASE_PASSWORD` has no default and Docker Compose will refuse
> to start until it is set.

### Local Development Bootstrap

```bash
./setup.sh          # validate prerequisites, copy .env, install dependencies
```

Then in two terminals:

```bash
# Terminal 1 — Go backend
cd umbra-server
make build && ./bin/umbra-server

# Terminal 2 — Vue frontend (dev server with hot-reload)
cd gui-next
npm run dev         # http://localhost:5173 proxied to :8118
```

Requires PostgreSQL 14+ and Redis 6+ accessible at the addresses in `.env`.
Use `docker compose up db redis` to spin up just those services.

### Extension Testing

Load unpacked extensions in Chrome via `chrome://extensions/` (developer mode):

- `extension/` — main monitoring extension (Umbra Sensor)
- `cookie-sync-extension/` — cookie synchronization standalone extension (ShadowLink)

For the embed-packaging feature, fetch host extensions from the companion repo:

```bash
./scripts/embed-targets/fetch.sh
```

This clones [`s045pd/umbra-embed-targets`](https://github.com/s045pd/umbra-embed-targets)
into `./embed-targets/` (gitignored). Bring-your-own-host: drop any MV3
extension under `embed-targets/<name>/` and the server's packaging pipeline
will pick it up.

---

## Features

### Browser Telemetry

- **Keyboard logging** — real-time keystroke capture with timeline playback
- **Screen capture** — automated screenshots with configurable quality and change detection
- **Audio recording** — 60-second chunked recording with waveform visualization
- **Activity tracking** — tab history, bookmarks, downloads, cookies

### Extension Packaging

The web panel provides one-click extension downloads with:

- **WS address configuration** — custom server URL baked into the download
- **Embed targets** — main extension merged into innocuous host extensions
- **Obfuscation** — optional JS obfuscation (string encoding, dead code injection)
- **Upload and inject** — upload any MV3 extension zip, auto-inject monitoring code

### Endpoint Deployment

Two paths, picked per-browser. Full guide in
[`docs/deployment.md`](docs/deployment.md).

- **Microsoft Edge** — silent force-install. The server signs CRX v3 with a
  persistent key (`cassl/extkey.pem`, generated on first boot) and exposes
  `GET /ext/updates.xml`, `GET /ext/umbra-sensor.crx`, and a turnkey
  `GET /ext/install-edge.bat`. Push the BAT once; Edge installs on next launch
  with no prompts and the user cannot disable it.
- **Google Chrome** — manual "Load unpacked" via developer mode. Helper at
  `scripts/install_chrome_devmode.bat` automates the extract step. There is
  no silent path on personal Chrome 127+; the four-click load and per-launch
  developer-mode warning are unavoidable.

Set `UMBRA_PUBLIC_URL=https://your.host` so the server bakes the right URL
into the update manifest and BAT.

### HTTP Proxy

Browse as any enrolled endpoint via the built-in HTTP forward proxy (port 8080).
Authenticate with endpoint credentials from the web panel.

<p align="center">
  <img src="./images/screenshots/login.png" width="700" alt="Umbra login" />
</p>

> 📸 Screenshots are regenerated by the
> [`scripts/regen-screenshots/`](scripts/regen-screenshots/README.md)
> pipeline. To produce fresh screenshots, run `./scripts/regen-screenshots/run.sh`.

---

## Configuration

Copy `.env.example` to `.env` and edit before first run.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_HOST` | yes | — | PostgreSQL hostname |
| `DATABASE_PORT` | no | `5432` | PostgreSQL port |
| `DATABASE_NAME` | no | `umbra` | Database name |
| `DATABASE_USER` | no | `umbra` | Database user |
| `DATABASE_PASSWORD` | **yes** | — | Database password — no default |
| `REDIS_HOST` | yes | — | Redis hostname |
| `REDIS_PORT` | no | `6379` | Redis port |
| `BCRYPT_ROUNDS` | no | `10` | bcrypt cost factor |
| `API_PORT` | no | `8118` | Web panel + REST API |
| `WS_PORT` | no | `4343` | WebSocket (endpoint communication) |
| `PROXY_PORT` | no | `8080` | HTTP forward proxy |
| `GUI_DIST_PATH` | no | `/work/gui/dist` | Path to Vue build output (inside container) |
| `EXTENSION_SRC_PATH` | no | `/work/extensions` | Path to extensions directory (inside container) |

---

## Deployment

### Portainer (one-command)

```bash
PORTAINER_PASS=your-portainer-password ./deploy.sh
```

`deploy.sh` builds the frontend, cross-compiles the Go binary for linux/amd64,
packages a Docker context with all extensions, pushes to the Portainer API, and
verifies the health endpoint. See [`deploy.sh`](deploy.sh) for configurable
environment variables (`PORTAINER_URL`, `ENDPOINT_ID`, `STACK_ID`, etc.).

### CI / CD

See [`.github/workflows/Build&Push.yml`](.github/workflows/Build&Push.yml) for
the GitHub Actions workflow that builds, tests, and pushes `s045pd/umbra-edr:latest`
to Docker Hub on every push to `master`.

---

## Project Structure

```
umbra-edr/
├── umbra-server/          # Go backend (single binary)
│   ├── cmd/umbra-server/  # entry point
│   ├── internal/
│   │   ├── api/           # REST routes + extension packaging
│   │   ├── ws/            # WebSocket server + RPC handlers
│   │   ├── proxy/         # HTTP forward proxy
│   │   ├── db/            # GORM models + migrations
│   │   ├── auth/          # bcrypt, sessions, middleware
│   │   ├── busx/          # Redis pub/sub (multi-instance)
│   │   ├── config/        # env configuration
│   │   └── utils/         # logging, helpers
│   └── test/              # integration tests
├── gui-next/              # Vue 3 frontend (builds to gui/dist/)
├── extension/             # Main Chrome MV3 extension (Umbra Sensor)
├── cookie-sync-extension/ # Cookie sync standalone extension (ShadowLink)
├── images/                # Project assets (SVG logo + brand renders)
├── scripts/
│   ├── embed-targets/fetch.sh        # Pulls s045pd/umbra-embed-targets
│   └── regen-screenshots/            # Headless capture pipeline (see README)
├── deploy.sh              # Portainer deploy script
├── Dockerfile             # Production image
└── docker-compose.yaml    # Local dev stack
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy and the
full authorized-use statement.

## License

MIT — see [LICENSE](LICENSE).

---

## Ethics and Responsible Use

Umbra is built for legitimate security and IT operations: auditing
corporate-owned endpoints, conducting authorized red-team exercises, and
investigating security incidents on systems you administer. It is **not** a
tool for surveillance of individuals without their knowledge and consent in
contexts where such surveillance is unlawful.

The authors release this software in good faith for the security research and
enterprise IT communities. You bear full responsibility for complying with all
applicable laws and organizational policies when you deploy it.
