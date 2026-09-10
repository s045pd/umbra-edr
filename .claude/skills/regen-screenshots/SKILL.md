---
name: regen-screenshots
description: Regenerate the Umbra README screenshot via the headless capture pipeline. Use when login UI changes, brand tokens change, or screenshots look stale. Outputs to `images/screenshots/login.png` against an isolated demo stack — never use real operator data.
---

# Regenerate Umbra README screenshot

## When to use

- `gui-next/src/pages/Login.vue` or `gui-next/src/assets/styles.css` changed
  (Tailwind tokens, fonts, colors)
- `images/umbra.svg` brand mark changed
- README screenshot looks stale or branding is inconsistent
- Quarterly cadence as a regression check

## Choosing the mode

The pipeline has two modes — pick based on what's available:

| Mode | When | Requires |
|---|---|---|
| **Full stack** (default) | When you want the screenshot to reflect server-rendered state (admin-created banner, real auth flow). | Docker, working `umbra-server` build, ports 5433/6380/8218/4443/8180 free |
| **Lite** (`--lite`) | When Docker isn't available or you only need the static GUI rendering. CI default. | Node 18+, npm, Playwright (auto-installed by run.sh) |

## Steps

```bash
cd scripts/regen-screenshots

# Pick one:
./run.sh             # Full stack: docker compose up demo stack + capture
./run.sh --lite      # Lite: build gui-next + serve gui/dist + capture
```

The script auto-falls-back to lite if `docker` is not on PATH.

## Verifying the result

After capture:

```bash
file images/screenshots/login.png
# Should report: PNG image data, 1280 x 800, 8-bit/color RGB, non-interlaced

ls -la images/screenshots/login.png
# Should be > 5 KB. Smaller indicates a blank/error page was captured.
```

Open the PNG visually. Login must show:

- Dark midnight grid background
- Centered card with "U" amber-accent monogram (NOT "C")
- "Umbra · edr.console" wordmark
- Empty USERNAME and PASSWORD inputs
- Amber "Sign in" button
- Helper text: "First-time login: use the credentials printed to the server console."

Other frames (`dashboard.png`, `endpoint.png`, `alerts.png`,
`settings.png`) must contain **only** synthetic lab copy
(`*.example.test`, `lab-workstation-04`, …). If a hostname, cookie,
email, or screenshot from a real fleet is visible, discard the PNG.

If anything else appears (404 page, blank black, login form with wrong colors),
the SPA fallback or theme tokens regressed — check `gui-next/src/assets/styles.css`
and that `gui/dist/login/index.html` exists post-build.

## Troubleshooting

- **404 from python http.server**: SPA fallback wasn't applied. The `run.sh`
  script handles this by copying `index.html` into route subdirs. If you ran
  `npm run build` manually, do it yourself: `for r in login dashboard settings; do mkdir -p gui/dist/$r && cp gui/dist/index.html gui/dist/$r/; done`
- **All-black PNG**: Vue Router's auth guard hung on a backend health check.
  The `--lite` mode hits `/login/` directly to avoid the auth guard route.
- **Selector timeout but PNG saved**: best-effort capture took whatever was on
  screen. Open it and check.

## Don't

- Don't take screenshots from a real Umbra server. Before any console
  shot, mock `/api/v1` and rewrite the DOM (see `capture.mjs` `scrubPage`).
  Real operator data must never end up in git.
- Don't commit screenshots from the full-stack mode if the demo seed data is
  identifiable (use the lite mode if unsure).
- Don't reuse `images/screenshots/` for design exploration — those go in a
  branch-local folder you don't commit.
