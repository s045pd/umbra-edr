# Deploying umbra-server

Drop-in replacement for the Node.js backend. The Chrome extensions and Vue GUI need no changes.

## Local

```bash
make build         # binary into ./bin/umbra-server
make test          # go test ./...
make test-race     # go test -race ./...
make smoke         # boot in stub mode and curl /health, /version
```

## Docker Compose

From the repo root:

```bash
docker compose up --build
```

First start writes `default admin user created` to logs with the auto-generated admin password.

## Portainer Deploy

From the repo root:

```bash
PORTAINER_PASS=xxx ./deploy.sh
```

The script builds the Vue 3 frontend, cross-compiles the Go binary (linux/amd64), packages everything into a Docker context, builds the image on the remote host via Portainer API, redeploys the stack, and verifies health.

## Ports

| Port | Purpose |
|------|---------|
| 8118 | REST API + Vue GUI |
| 4343 | WebSocket bot endpoint |
| 8080 | HTTP forward proxy (mapped to 8119 externally) |

## Environment Variables

All variables match the original Node.js server so existing Portainer stacks keep working:

```
DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD
REDIS_HOST, REDIS_PORT
BCRYPT_ROUNDS (default 10)
API_PORT (8118), WS_PORT (4343), PROXY_PORT (8080)
GUI_DIST_PATH (default /work/gui/dist)
EXTENSION_SRC_PATH (path to extensions directory)
MEDIA_DIR     # screenshot/audio blob root (default unset = keep in Postgres)
TRANSCRIBE_CMD # optional `cmd <audio-file>` whose stdout becomes a transcript
SKIP_DB=1     # smoke-only: boot with no DB / RPC
```

## Health Check

- `GET /health` returns `{"success":true}`
- `GET /version` returns the build version

## Rollback

If you need to roll back to a previous server image, update the image tag in Portainer (or your orchestrator) and restart the stack. The database volume is preserved across image rollbacks.
