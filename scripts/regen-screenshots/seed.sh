#!/usr/bin/env bash
# seed.sh — Generate a fresh demo password and bring up the demo stack.
#
# Writes the generated password to /tmp/umbra-demo-password.txt and exports
# UMBRA_DEMO_DB_PASSWORD so that docker-compose.demo.yaml can pick it up.
#
# This script is sourced (not executed) by run.sh so the export persists in
# that shell.  You can also source it directly:
#
#   source ./seed.sh
#   docker compose -f docker-compose.demo.yaml up -d
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── Colour helpers ──────────────────────────────────────────────────────────
_cyan()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
_yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }
_red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }

# ── Generate password ────────────────────────────────────────────────────────
PASSWORD_FILE="/tmp/umbra-demo-password.txt"
if command -v openssl &>/dev/null; then
  UMBRA_DEMO_DB_PASSWORD="$(openssl rand -hex 20)"
elif command -v python3 &>/dev/null; then
  UMBRA_DEMO_DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(20))')"
else
  # Fallback: pseudo-random from /dev/urandom
  UMBRA_DEMO_DB_PASSWORD="$(tr -dc 'a-f0-9' </dev/urandom | head -c 40)"
fi
export UMBRA_DEMO_DB_PASSWORD
printf '%s\n' "${UMBRA_DEMO_DB_PASSWORD}" > "${PASSWORD_FILE}"
_green "[seed] demo DB password written to ${PASSWORD_FILE}"

# ── Build the Vue frontend (required before docker compose starts server) ───
_cyan "[seed] building Vue frontend…"
DIST_DIR="${REPO_ROOT}/gui/dist"

if [ ! -f "${REPO_ROOT}/gui-next/node_modules/.package-lock.json" ] && \
   [ ! -d "${REPO_ROOT}/gui-next/node_modules" ]; then
  _yellow "[seed] node_modules absent — running npm install"
  npm --prefix "${REPO_ROOT}/gui-next" install
fi

npm --prefix "${REPO_ROOT}/gui-next" run build
_green "[seed] Vue build complete → ${DIST_DIR}"

# ── Start the demo stack ─────────────────────────────────────────────────────
_cyan "[seed] starting demo stack…"
docker compose \
  -f "${SCRIPT_DIR}/docker-compose.demo.yaml" \
  --project-name umbra-demo \
  up -d --build

_green "[seed] demo stack is up"
_yellow "[seed] API  → http://localhost:8218"
_yellow "[seed] WS   → ws://localhost:4443"
_yellow "[seed] Proxy→ http://localhost:8180"
