#!/usr/bin/env bash
set -euo pipefail

# Umbra EDR — First-time development environment setup
# Usage: ./setup.sh
# Safe to re-run; all steps are idempotent.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Colour helpers ──────────────────────────────────────────────────────────
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m→\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m! %s\033[0m\n' "$*"; }

# ── Prerequisite checks ────────────────────────────────────────────────────

info "Checking prerequisites..."

# Go 1.25+
if command -v go >/dev/null 2>&1; then
  GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
  GO_MAJOR=$(echo "$GO_VERSION" | cut -d. -f1)
  GO_MINOR=$(echo "$GO_VERSION" | cut -d. -f2)
  if [ "$GO_MAJOR" -lt 1 ] || { [ "$GO_MAJOR" -eq 1 ] && [ "$GO_MINOR" -lt 25 ]; }; then
    red "ERROR: Go 1.25 or higher is required (found go${GO_VERSION})."
    red "       Download from https://go.dev/dl/"
    exit 1
  fi
  green "  Go ${GO_VERSION} — ok"
else
  red "ERROR: Go is not installed. Download from https://go.dev/dl/"
  exit 1
fi

# Node 20+
if command -v node >/dev/null 2>&1; then
  NODE_VERSION=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 20 ]; then
    red "ERROR: Node.js 20 or higher is required (found v${NODE_VERSION})."
    red "       Download from https://nodejs.org/"
    exit 1
  fi
  green "  Node v${NODE_VERSION} — ok"
else
  red "ERROR: Node.js is not installed. Download from https://nodejs.org/"
  exit 1
fi

# npm (bundled with Node but verify)
if command -v npm >/dev/null 2>&1; then
  green "  npm $(npm --version) — ok"
else
  red "ERROR: npm is not found. Reinstall Node.js from https://nodejs.org/"
  exit 1
fi

# Docker (required for the default runtime; warn rather than hard-fail for
# contributors who run the stack manually)
if command -v docker >/dev/null 2>&1; then
  green "  Docker $(docker --version | awk '{print $3}' | tr -d ',') — ok"
else
  warn "Docker not found. Docker Compose is the recommended way to run Umbra."
  warn "Install from https://docs.docker.com/get-docker/"
fi

# rsvg-convert — used to render the SVG logo to PNG (optional)
if command -v rsvg-convert >/dev/null 2>&1; then
  green "  rsvg-convert — ok"
else
  warn "rsvg-convert not found (optional, needed only for icon regeneration)."
  warn "Install with: brew install librsvg  /  apt install librsvg2-bin"
fi

# gh CLI — optional, used by contributors for PR workflows
if command -v gh >/dev/null 2>&1; then
  green "  gh $(gh --version | head -1 | awk '{print $3}') — ok"
else
  warn "GitHub CLI (gh) not found (optional)."
  warn "Install from https://cli.github.com/"
fi

echo ""

# ── Environment file ───────────────────────────────────────────────────────

info "Checking .env..."
if [ ! -f "$ROOT_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  green "  Created .env from .env.example"
  warn "  Open .env and set DATABASE_PASSWORD before starting the server."
else
  green "  .env already exists — skipping"
fi

echo ""

# ── Go dependencies ────────────────────────────────────────────────────────

info "Downloading Go modules (umbra-server/)..."
cd "$ROOT_DIR/umbra-server"
go mod download
green "  Go modules downloaded"

echo ""

# ── Node dependencies ──────────────────────────────────────────────────────

info "Installing Node dependencies (gui-next/)..."
cd "$ROOT_DIR/gui-next"
npm install --silent
green "  Node dependencies installed"

echo ""

# ── Done ───────────────────────────────────────────────────────────────────

green "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit .env and set DATABASE_PASSWORD (required — no default)."
echo ""
echo "  Docker Compose (recommended):"
echo "    docker compose up --build"
echo "    # First launch prints generated admin credentials in the logs."
echo "    # Open http://localhost:8118 and rotate the password."
echo ""
echo "  Local development:"
echo "    # Terminal 1 — Go backend"
echo "    cd umbra-server && make build && ./bin/umbra-server"
echo ""
echo "    # Terminal 2 — Vue frontend (hot-reload)"
echo "    cd gui-next && npm run dev"
echo "    # Open http://localhost:5173"
echo ""
echo "  Run tests:"
echo "    cd umbra-server && make test"
echo "    cd gui-next && npm run typecheck && npm run build"
echo ""
