---
name: release-checklist
description: Pre-publish and pre-release-tag checklist for umbra-edr. Use when about to push the first public commit, when cutting a v0.x.0 tag, or before merging a feature branch that touches user-facing surfaces.
---

# Release checklist

## Pre-first-public-push (run once)

The repository goes public at `s045pd/umbra-edr`. Before `gh repo create --public --push`:

- [ ] No `.git` directory exists yet (history starts fresh)
- [ ] `git config user.email` set to `s045pd@users.noreply.github.com` (no Gmail leak)
- [ ] `git status --short` is clean before the initial `git add -A`
- [ ] `git add -A --dry-run | grep -E "\.env$|\.DS_Store$|node_modules|\.key$|\.crt$|\.pem$|\.claude/settings"` returns empty
- [ ] Sanitizer scan: `Agent({ subagent_type: "opensource-sanitizer", ...})` returns PASS or PASS-WITH-WARNINGS where every warning is acknowledged
- [ ] `cd umbra-server && go build ./... && go test ./...` passes
- [ ] `cd gui-next && npm install && npm run build` passes
- [ ] `images/screenshots/login.png` shows the correct Umbra login page (regen if needed via `regen-screenshots` skill)
- [ ] `gh repo view s045pd/umbra-edr 2>&1 | head -2` returns "Could not resolve" (target name available)
- [ ] `gh auth status` shows the right account (`s045pd`)

Then:

```bash
cd /path/to/umbra-edr
git init -b main
git config user.email "s045pd@users.noreply.github.com"
git config user.name "s045pd"
git add -A
git commit -m "feat: initial Umbra release

Browser-layer EDR for authorized enterprise monitoring. Forked from a
private predecessor and rebranded; this is the first public release.

Authorized monitoring environments only. See SECURITY.md."

gh repo create s045pd/umbra-edr \
  --public \
  --description "Umbra · Browser-layer EDR · Light through shadow. Authorized monitoring only." \
  --source=. \
  --remote=origin \
  --push

gh repo edit s045pd/umbra-edr \
  --add-topic edr \
  --add-topic browser-monitoring \
  --add-topic chrome-extension \
  --add-topic go \
  --add-topic vue
```

Verify:

```bash
gh repo view s045pd/umbra-edr
gh api repos/s045pd/umbra-edr/commits --jq '.[].commit.author.email'
# Should print s045pd@users.noreply.github.com — never the Gmail address.
```

Then smoke-clone and build to confirm a third party can:

```bash
mkdir -p /tmp/umbra-smoke && cd /tmp/umbra-smoke
git clone https://github.com/s045pd/umbra-edr.git
cd umbra-edr
bash setup.sh
cd umbra-server && make build && make test
cd ../gui-next && npm install && npm run build
cd /tmp && rm -rf umbra-smoke
```

## Per-release (v0.x.0 tag)

- [ ] Update version in `umbra-server/internal/version/version.go` and
      `extension/manifest.json` and `cookie-sync-extension/manifest.json`
- [ ] Run `regen-screenshots` skill if any UI changed
- [ ] CHANGELOG entry in commit body or a top-level `CHANGELOG.md`
- [ ] `git tag -a v0.x.0 -m "..." && git push origin v0.x.0`
- [ ] GitHub Release notes via `gh release create`

## Per-PR (feature branches)

- [ ] `cd umbra-server && go test ./...` passes
- [ ] `cd gui-next && npm run typecheck && npm run build` passes
- [ ] No predecessor-brand strings in tracked source/docs
- [ ] No new `*.key`, `*.crt`, `*.pem` files in tracked content
- [ ] Brand discipline (see CLAUDE.md "Brand discipline" section) — no
      `implant`, `victim`, `disguise` in user-facing copy
- [ ] If touching `gui-next/src/pages/Login.vue` or `assets/styles.css`,
      regen the README screenshot
