#!/usr/bin/env bash
# run.sh — Top-level orchestrator for the Umbra screenshot regeneration pipeline.
#
# Usage:
#   cd scripts/regen-screenshots
#   ./run.sh [--lite]
#
# Modes:
#   (default)   Full-stack mode: docker compose demo stack + Playwright capture.
#   --lite      Static-server mode: builds gui-next and serves gui/dist on a
#               local port, then captures screenshots without Docker/DB/Redis.
#               Useful when Docker is unavailable or for CI environments that
#               cannot run a full database.
#
# Output (relative to repo root):
#   images/screenshots/{login,dashboard,endpoint,alerts,settings}.png
#
# Capture never talks to a live operator API. Playwright fulfills /api/v1
# with synthetic example.test fixtures and rewrites the DOM before each shot.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.demo.yaml"

# ── Colour helpers ──────────────────────────────────────────────────────────
_step()  { printf '\n\033[1;34m══ %s\033[0m\n' "$*"; }
_ok()    { printf '\033[0;32m✔  %s\033[0m\n' "$*"; }
_warn()  { printf '\033[0;33m⚠  %s\033[0m\n' "$*"; }
_err()   { printf '\033[0;31m✘  %s\033[0m\n' "$*"; }
_info()  { printf '\033[0;36m   %s\033[0m\n' "$*"; }

# ── Parse flags ──────────────────────────────────────────────────────────────
LITE_MODE=false
for arg in "$@"; do
  case "$arg" in
    --lite) LITE_MODE=true ;;
  esac
done

STATIC_SERVER_PID=""
LITE_PORT=9218

# ── Cleanup trap ─────────────────────────────────────────────────────────────
cleanup() {
  local exit_code=$?

  if [ -n "${STATIC_SERVER_PID}" ]; then
    _info "stopping static server (PID ${STATIC_SERVER_PID})…"
    kill "${STATIC_SERVER_PID}" 2>/dev/null || true
  fi

  if [ "${LITE_MODE}" = "false" ] && command -v docker &>/dev/null; then
    _step "Tearing down demo stack"
    docker compose \
      -f "${COMPOSE_FILE}" \
      --project-name umbra-demo \
      down --volumes --remove-orphans 2>/dev/null || true
    _ok "demo stack removed"
  fi

  if [ "${exit_code}" -ne 0 ]; then
    _err "pipeline exited with code ${exit_code}"
  fi
}
trap cleanup EXIT

# ── Prerequisite checks ───────────────────────────────────────────────────────
_step "Checking prerequisites"

if ! command -v node &>/dev/null; then
  _err "node not found — install Node.js 18+"
  exit 1
fi
_ok "node $(node --version)"

if ! command -v npm &>/dev/null; then
  _err "npm not found"
  exit 1
fi
_ok "npm $(npm --version)"

# ── Install Node deps for capture script ─────────────────────────────────────
_step "Installing Playwright dependencies"
NPM_CACHE="${NPM_CONFIG_CACHE:-/tmp/npm-cache-umbra}"
export NPM_CONFIG_CACHE="${NPM_CACHE}"
if [ ! -d "${SCRIPT_DIR}/node_modules/playwright" ]; then
  npm --prefix "${SCRIPT_DIR}" --cache "${NPM_CACHE}" install
else
  _info "node_modules present — skipping install"
fi

CHROME_BIN="${PLAYWRIGHT_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -x "${CHROME_BIN}" ]; then
  export PLAYWRIGHT_CHROME="${CHROME_BIN}"
  _ok "using system Chrome at ${CHROME_BIN}"
else
  "${SCRIPT_DIR}/node_modules/.bin/playwright" install chromium
  _ok "Playwright Chromium ready"
fi

# ── Full-stack mode ───────────────────────────────────────────────────────────
if [ "${LITE_MODE}" = "false" ]; then
  if ! command -v docker &>/dev/null || ! docker info &>/dev/null; then
    _warn "docker not available — falling back to --lite mode automatically"
    LITE_MODE=true
  fi
fi

# ── Lite mode: build frontend + static server ─────────────────────────────────
if [ "${LITE_MODE}" = "true" ]; then
  _step "Lite mode: building Vue frontend"

  GUI_NEXT="${REPO_ROOT}/gui-next"
  DIST_DIR="${GUI_NEXT}/dist"

  if [ ! -d "${GUI_NEXT}/node_modules" ]; then
    _info "running npm install in gui-next…"
    npm --prefix "${GUI_NEXT}" --cache /tmp/npm-cache-umbra install
  fi

  npm --prefix "${GUI_NEXT}" --cache /tmp/npm-cache-umbra run build
  _ok "Vue build → ${DIST_DIR}"

  # SPA route fallback: vue-router uses createWebHistory() so /login is a
  # client-side route, not a real file. Static servers without SPA support
  # (python http.server, basic http-server) will 404 on /login. Copy
  # index.html into each top-level SPA route directory so any static server
  # serves the same SPA bundle when those URLs are requested.
  DEMO_BOT="11111111-1111-4111-8111-111111111111"
  for route in login alerts settings audit "bots/${DEMO_BOT}"; do
    mkdir -p "${DIST_DIR}/${route}"
    cp "${DIST_DIR}/index.html" "${DIST_DIR}/${route}/index.html"
  done
  _ok "SPA route fallback files written"

  # Start a tiny static file server.
  _step "Starting static file server on port ${LITE_PORT}"
  if command -v npx &>/dev/null; then
    npx --yes http-server "${DIST_DIR}" \
      --port "${LITE_PORT}" \
      --silent \
      --no-dotfiles \
      &
    STATIC_SERVER_PID=$!
  elif command -v python3 &>/dev/null; then
    (cd "${DIST_DIR}" && python3 -m http.server "${LITE_PORT}" &>/dev/null) &
    STATIC_SERVER_PID=$!
  else
    _err "neither npx nor python3 available — cannot start static server"
    exit 1
  fi

  _ok "static server PID ${STATIC_SERVER_PID}"

  # Give the server a moment to bind.
  sleep 1

  CAPTURE_BASE_URL="http://localhost:${LITE_PORT}"

# ── Full-stack mode: docker compose demo ────────────────────────────────────
else
  _step "Full-stack mode: tearing down any stale demo stack"
  docker compose \
    -f "${COMPOSE_FILE}" \
    --project-name umbra-demo \
    down --volumes --remove-orphans 2>/dev/null || true
  _ok "stale stack removed"

  _step "Seeding and starting demo stack"
  # shellcheck source=seed.sh
  source "${SCRIPT_DIR}/seed.sh"

  _step "Waiting for server health"
  MAX_WAIT=120
  elapsed=0
  until curl -sf "http://localhost:8218/health" &>/dev/null; do
    if [ "${elapsed}" -ge "${MAX_WAIT}" ]; then
      _err "server did not become healthy within ${MAX_WAIT}s"
      docker compose -f "${COMPOSE_FILE}" --project-name umbra-demo logs --tail 50
      exit 1
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  _ok "server healthy"

  CAPTURE_BASE_URL="http://localhost:8218"
fi

# ── Run Playwright capture ────────────────────────────────────────────────────
_step "Capturing screenshots"
UMBRA_BASE_URL="${CAPTURE_BASE_URL}" \
UMBRA_OUT_DIR="${REPO_ROOT}/images/screenshots" \
  node "${SCRIPT_DIR}/capture.mjs"

_step "Verifying output"
MISSING=0
for name in login dashboard endpoint alerts settings; do
  EXPECTED="${REPO_ROOT}/images/screenshots/${name}.png"
  if [ ! -f "${EXPECTED}" ]; then
    _err "${name}.png not found at ${EXPECTED}"
    MISSING=1
    continue
  fi
  SIZE=$(wc -c < "${EXPECTED}")
  if [ "${SIZE}" -lt 5120 ]; then
    _warn "${name}.png is suspiciously small (${SIZE} bytes) — may be a blank page"
  else
    _ok "${name}.png exists (${SIZE} bytes)"
  fi
done
if [ "${MISSING}" -ne 0 ]; then
  exit 1
fi

_ok "Screenshot regeneration complete"
_info "Output: ${REPO_ROOT}/images/screenshots/"
ls -lh "${REPO_ROOT}/images/screenshots/"
