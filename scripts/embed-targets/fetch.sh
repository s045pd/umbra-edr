#!/usr/bin/env bash
# Fetch Umbra embed targets into ./embed-targets/.
#
# The host extensions used by Umbra's "Embed download" packaging feature live
# in a separate public repo (https://github.com/s045pd/umbra-embed-targets).
# This script clones (or updates) that repo into ./embed-targets/ relative to
# the umbra-edr root so the server's EXTENSION_SRC_PATH (default
# /work/extensions inside the container, ./embed-targets locally) is populated.
#
# Bring-your-own-host: if you have your own host extensions, you can drop them
# under ./embed-targets/<name>/ alongside (or instead of) the fetched set. The
# packaging pipeline picks up any directory with a manifest.json in there.
#
# Usage:
#   ./scripts/embed-targets/fetch.sh         # clone or fast-forward update
#   ./scripts/embed-targets/fetch.sh --force # nuke and re-clone
#
# Env overrides:
#   UMBRA_EMBED_TARGETS_REPO  default: https://github.com/s045pd/umbra-embed-targets.git
#   UMBRA_EMBED_TARGETS_REF   default: main
#   UMBRA_EMBED_TARGETS_DIR   default: <repo-root>/embed-targets

set -euo pipefail

REPO_URL="${UMBRA_EMBED_TARGETS_REPO:-https://github.com/s045pd/umbra-embed-targets.git}"
REF="${UMBRA_EMBED_TARGETS_REF:-main}"

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_DIR="${UMBRA_EMBED_TARGETS_DIR:-$ROOT_DIR/embed-targets}"

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
fi

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

if [[ "$force" -eq 1 && -d "$TARGET_DIR" ]]; then
  yellow "[!] --force: removing existing $TARGET_DIR"
  rm -rf "$TARGET_DIR"
fi

if [[ -d "$TARGET_DIR/.git" ]]; then
  green "[+] embed-targets already cloned, fast-forwarding"
  cd "$TARGET_DIR"
  git fetch --quiet origin "$REF"
  git checkout --quiet "$REF"
  git pull --ff-only --quiet origin "$REF"
elif [[ -d "$TARGET_DIR" ]]; then
  red "[!] $TARGET_DIR exists but is not a git checkout."
  red "    Move it aside or pass --force to replace it."
  exit 1
else
  green "[+] Cloning $REPO_URL into $TARGET_DIR"
  git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$TARGET_DIR"
fi

count=$(find "$TARGET_DIR" -maxdepth 2 -name manifest.json | wc -l | tr -d ' ')
green "[+] $count embed target(s) available in $TARGET_DIR"
green "[+] Set EXTENSION_SRC_PATH=$TARGET_DIR when running umbra-server outside Docker."
