#!/usr/bin/env bash
set -euo pipefail

# ── Config ──────────────────────────────────────────
PORTAINER_URL="${PORTAINER_URL:-http://127.0.0.1:9000}"
PORTAINER_USER="${PORTAINER_USER:-admin}"
PORTAINER_PASS="${PORTAINER_PASS:-}"
# ENDPOINT_ID and STACK_ID are operator-specific Portainer resource IDs.
# There is no sensible default — set both before running this script.
ENDPOINT_ID="${ENDPOINT_ID:-}"
STACK_ID="${STACK_ID:-}"
IMAGE_TAG="${IMAGE_TAG:-s045pd/umbra-edr:latest}"
SERVER_URL="${SERVER_URL:-http://127.0.0.1:8118}"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Helpers ─────────────────────────────────────────
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m→\033[0m %s\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

# ── Pre-checks ──────────────────────────────────────
[[ -z "$PORTAINER_PASS" ]] && die "Set PORTAINER_PASS env var"
[[ -z "$ENDPOINT_ID"   ]] && die "Set ENDPOINT_ID env var (your Portainer endpoint id)"
[[ -z "$STACK_ID"      ]] && die "Set STACK_ID env var (your Portainer stack id)"
command -v go   >/dev/null || die "go not found"
command -v node >/dev/null || die "node not found"
command -v curl >/dev/null || die "curl not found"

# ── Step 1: Build Vue 3 frontend ────────────────────
info "Building Vue 3 frontend..."
cd "$ROOT_DIR/gui-next"
npm run build --silent
green "Frontend built → gui-next/dist/"

# ── Step 2: Cross-compile Go binary ─────────────────
info "Cross-compiling Go backend (linux/amd64)..."
cd "$ROOT_DIR/umbra-server"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
  -trimpath -ldflags="-s -w" \
  -o /tmp/umbra-server ./cmd/umbra-server
green "Go binary built → /tmp/umbra-server ($(du -h /tmp/umbra-server | cut -f1))"

# ── Step 3: Package Docker context ──────────────────
info "Packaging Docker context..."
TMPDIR=$(mktemp -d)
cp /tmp/umbra-server "$TMPDIR/umbra-server"
if [ -d "$ROOT_DIR/gui-next/dist" ]; then
  cp -r "$ROOT_DIR/gui-next/dist" "$TMPDIR/gui-dist"
elif [ -d "$ROOT_DIR/gui/dist" ]; then
  cp -r "$ROOT_DIR/gui/dist" "$TMPDIR/gui-dist"
else
  die "GUI dist not found (gui-next/dist or gui/dist)"
fi
mkdir -p "$TMPDIR/extensions"
cp -r "$ROOT_DIR/extension" "$TMPDIR/extensions/main"
[ -d "$ROOT_DIR/cookie-sync-extension" ] && cp -r "$ROOT_DIR/cookie-sync-extension" "$TMPDIR/extensions/cookie-sync"
[ -d "$ROOT_DIR/bypass-paywalls-chrome" ] && cp -r "$ROOT_DIR/bypass-paywalls-chrome" "$TMPDIR/extensions/bypass-paywalls"

# Obfuscator bundle is referenced by Dockerfile (`COPY tools/obfuscate.bundle.mjs ...`).
# Without it the remote `docker build` fails at COPY. Source lives under
# umbra-server/tools/ — see CLAUDE.md "Embed download" notes.
if [ -f "$ROOT_DIR/umbra-server/tools/obfuscate.bundle.mjs" ]; then
  mkdir -p "$TMPDIR/tools"
  cp "$ROOT_DIR/umbra-server/tools/obfuscate.bundle.mjs" "$TMPDIR/tools/obfuscate.bundle.mjs"
fi

if [ -d "$ROOT_DIR/embed-targets" ]; then
  for ext_dir in "$ROOT_DIR/embed-targets"/*/; do
    [ -f "$ext_dir/manifest.json" ] && cp -r "$ext_dir" "$TMPDIR/extensions/$(basename "$ext_dir")"
  done
  info "Copied $(ls -d "$ROOT_DIR/embed-targets"/*/ 2>/dev/null | wc -l | tr -d ' ') embed targets"
fi
# Bundled whisper.cpp + tiny multilingual model. Cached under
# /tmp/umbra-whisper. The CLI must be a musl binary built for this
# host CPU (Goldmont / SSE4.2, no AVX, no BMI2). Do not fall back to
# OpenWhispr linux-x64 zips — those SIGILL on Celeron J-series.
info "Preparing whisper.cpp..."
WHISPER_CACHE="${WHISPER_CACHE:-/tmp/umbra-whisper}"
mkdir -p "$WHISPER_CACHE" "$TMPDIR/whisper"
if [ ! -f "$WHISPER_CACHE/ggml-tiny.bin" ]; then
  curl -fsSL -o "$WHISPER_CACHE/ggml-tiny.bin" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
fi
if [ ! -x "$WHISPER_CACHE/whisper-cli" ]; then
  die "whisper-cli missing at $WHISPER_CACHE/whisper-cli — build whisper.cpp with -march=goldmont -mno-avx -mno-bmi2 (musl) and place the binary there"
fi
cp "$WHISPER_CACHE/whisper-cli" "$TMPDIR/whisper/whisper-cli"
cp "$WHISPER_CACHE/ggml-tiny.bin" "$TMPDIR/whisper/ggml-tiny.bin"
chmod +x "$TMPDIR/whisper/whisper-cli"
green "whisper.cpp ready ($(file -b "$TMPDIR/whisper/whisper-cli" | cut -c1-80))"

cp "$ROOT_DIR/Dockerfile" "$TMPDIR/Dockerfile"
# macOS tar otherwise injects ._* AppleDouble files that break COPY.
COPYFILE_DISABLE=1 tar cf /tmp/umbra-deploy.tar -C "$TMPDIR" .
rm -rf "$TMPDIR"
green "Context packaged → /tmp/umbra-deploy.tar ($(du -h /tmp/umbra-deploy.tar | cut -f1))"

# ── Step 4: Authenticate with Portainer ─────────────
info "Authenticating with Portainer..."
JWT=$(curl -sf -X POST "$PORTAINER_URL/api/auth" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$PORTAINER_USER\",\"password\":\"$PORTAINER_PASS\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['jwt'])")
[[ -z "$JWT" ]] && die "Failed to get Portainer JWT"
green "Authenticated"

# ── Step 5: Build image on remote Docker ────────────
info "Building Docker image on remote server..."
BUILD_OUT=$(curl -sf -X POST \
  "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/build?t=$IMAGE_TAG&t=umbra-server:latest&networkmode=host" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/x-tar" \
  --data-binary @/tmp/umbra-deploy.tar \
  --max-time 900)

if echo "$BUILD_OUT" | grep -q '"errorDetail"'; then
  red "Build failed:"
  echo "$BUILD_OUT" | grep '"error"' | tail -1
  exit 1
fi
green "Image built and tagged: $IMAGE_TAG"

# ── Step 6: Stop old container ──────────────────────
info "Stopping old umbra container..."
OLD_ID=$(curl -sf "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/containers/json?filters=%7B%22ancestor%22%3A%5B%22$IMAGE_TAG%22%5D%7D" \
  -H "Authorization: Bearer $JWT" \
  | python3 -c "import sys,json; cs=json.load(sys.stdin); print(cs[0]['Id'] if cs else '')" 2>/dev/null || true)

if [[ -n "$OLD_ID" ]]; then
  curl -sf -X DELETE \
    "$PORTAINER_URL/api/endpoints/$ENDPOINT_ID/docker/containers/$OLD_ID?force=true" \
    -H "Authorization: Bearer $JWT" >/dev/null 2>&1 || true
  green "Old container removed"
else
  info "No old container found, skipping"
fi

# ── Step 7: Redeploy stack ──────────────────────────
info "Redeploying Portainer stack..."
COMPOSE=$(curl -sf "$PORTAINER_URL/api/stacks/$STACK_ID/file" \
  -H "Authorization: Bearer $JWT" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['StackFileContent'])")

BODY=$(python3 -c "
import json
compose = '''$COMPOSE'''
print(json.dumps({'StackFileContent': compose, 'Env': [], 'Prune': False, 'PullImage': False}))
")

RESULT=$(curl -sf -X PUT \
  "$PORTAINER_URL/api/stacks/$STACK_ID?endpointId=$ENDPOINT_ID" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d "$BODY")

STATUS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('Status',0))" 2>/dev/null || echo "0")
[[ "$STATUS" == "1" ]] || die "Stack deploy returned status=$STATUS"
green "Stack redeployed"

# ── Step 8: Verify health ──────────────────────────
info "Waiting for health check..."
for i in $(seq 1 30); do
  if curl -sf "${SERVER_URL}/health" | grep -q '"success":true'; then
    green "Health check passed!"
    echo ""
    green "Deploy complete. New image running at ${SERVER_URL}"
    exit 0
  fi
  sleep 2
done

die "Health check timed out after 60s"
