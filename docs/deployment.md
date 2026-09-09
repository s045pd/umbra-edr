# Umbra Sensor — Endpoint Deployment Guide

This guide covers how to push the Umbra Sensor extension to employee
machines. There are two paths, picked by the browser the employee uses:

| Browser | Path | Silent? | Cannot be disabled? | One-time UAC? |
|---|---|---|---|---|
| **Microsoft Edge** | Enterprise policy via HKLM registry | yes | yes | yes (one click) |
| **Google Chrome** | Manual "Load unpacked" with developer mode | no — manual steps | no, user can disable | no |

> **Chrome reality check**: on personal (non-domain) PCs, Chrome 127+
> blocks every silent install vector that used to exist (External
> Extensions JSON, Preferences injection, `file://` forcelist). The
> only paths to silent + locked-in are Chrome Browser Cloud Management
> (CBCM) enrollment or publishing to the Chrome Web Store. For small
> deployments where neither fits, recommend Edge.

---

## Prerequisites

1. **umbra-server reachable over HTTPS** from employee machines. The
   Edge auto-update flow polls every few hours and will not accept HTTP.
2. **Stable hostname** (e.g. `umbra.acme.example`). Pin a real cert via
   Let's Encrypt or your internal CA. Self-signed certs on the public
   endpoints will silently break Edge auto-update.
3. **`UMBRA_PUBLIC_URL` env var** set on the server, e.g.
   `UMBRA_PUBLIC_URL=https://umbra.acme.example`. Without this the
   server falls back to inferring from request headers, which gets
   wrong results behind some reverse proxies.
4. **First server boot persists `cassl/extkey.pem`**. Back this file
   up. If you lose it, the Extension ID changes and every Edge
   forcelist policy you've already pushed is invalidated.

After first boot, look in the server log for:

```
ext signing key ready  ext_id=lhgbdcfeijjdoaplekhmgfojiagjabhi  path=/work/cassl/extkey.pem
```

That `ext_id` is what Edge will request. Note it; it shows up in
`/ext/updates.xml` as the `appid` attribute.

## Coordinated Sync/Clone rollout

Sensor installation is only one stage of the browser snapshot release. For
Umbra server `0.2.0-dev`, Sensor `0.2.2`, and ShadowLink `3.0.11`, use this
strict order:

1. deploy the server migration and snapshot API;
2. deploy Sensor `0.2.2` (the version bump is required so managed Edge endpoints actually fetch the snapshot-capable package);
3. wait for and verify a complete, full-history, non-truncated trusted cache
   for each endpoint that needs cached Sync; then
4. deploy ShadowLink `3.0.11`. Clone still requires the source browser to be online.

Do not distribute ShadowLink first. Old periodic bot arrays are Sync-only and
never authorize Clone. The complete status, recovery, sanitization, and
rollback procedure is in
[ShadowLink Sync/Clone Operations Guide](shadowlink-sync-clone-operations.md).

---

## Path A — Microsoft Edge silent force-install

This is the recommended path for any employee on Edge. After this is
applied:
- Extension installs on next Edge launch with **zero install prompts**.
- User **cannot disable or remove** it from `edge://extensions`.
- No "review this extension" recurring popup (those are for sideloads;
  force-installed extensions don't trigger them).
- Auto-update on Edge's normal cadence (a few hours).
- Trade-off: `edge://settings` shows a "Browser is managed by your
  organization" badge. For an EDR this is appropriate disclosure.

### Option A1 — Server-generated BAT (turnkey)

```
https://umbra.acme.example/ext/install-edge.bat
```

This endpoint serves a fully-substituted BAT with your Extension ID,
update URL, and host already baked in. Ship that file to the target
machine and run it.

The BAT will:

1. Self-elevate via UAC (one click). Subsequent re-runs after admin
   approval are silent.
2. Write three HKLM policies: `ExtensionInstallForcelist`,
   `ExtensionInstallAllowlist`, `ExtensionInstallSources`.
3. Block any sideloaded externals (`ExternalExtensionsBlocked=1`).
4. Trigger `gpupdate /target:computer /force` (no-op on non-domain
   machines but cheap).
5. Exit silently with code 0.

For mass deployment via RMM / Intune / SCCM / login script, you can
bake the same registry writes into your tool's native deployment
recipe. The BAT is the manual / single-machine equivalent.

### Option A2 — Static template (offline distribution)

For ops folks who want to template the script themselves (no server
reachable yet, deploying via fleet management), use:

```
scripts/install_edge_silent.bat
```

Substitute the two placeholders:

- `<EXTENSION_ID>` — the 32-char `a`-`p` string from your server log
- `<UMBRA_HOST>` — your public host without scheme or path
  (e.g. `umbra.acme.example`)

### Verifying the install (Edge)

On the target machine, after restarting Edge:

```
edge://extensions       → Umbra Sensor listed, no Disable / Remove
edge://policy           → ExtensionInstallForcelist shows your ID
edge://management       → "Edge is managed by …"
```

Server side, look in the access log for polls of `/ext/updates.xml`
and a single fetch of `/ext/umbra-sensor.crx` per machine per version.

---

## Path B — Google Chrome manual install (developer mode)

Use this when the employee is on Chrome and you've decided not to
enroll in CBCM. There is no fully silent path here — the four-click
manual install plus a permanent developer-mode warning bubble are
both unavoidable on personal Chrome.

### Steps

1. **Admin downloads the ZIP** from the Umbra panel:
   `Settings → Extension Download → Standalone`.
2. **Send the ZIP and the helper to the employee**:
   - `umbra-extension.zip` (whatever name the panel exported)
   - `scripts/install_chrome_devmode.bat`
3. **Employee drags the ZIP onto the BAT** (or runs
   `install_chrome_devmode.bat <zip>`). This:
   - Extracts the ZIP to `%LOCALAPPDATA%\Umbra\extension`
   - Opens `chrome://extensions`
4. **Employee finishes the four manual clicks Chrome forces:**
   - Toggle **Developer mode** (top right)
   - Click **Load unpacked**
   - Pick `%LOCALAPPDATA%\Umbra\extension`
   - Done

### What the employee will see

- A **"Disable developer mode extensions" warning bubble** every time
  Chrome launches. **This cannot be suppressed on personal Chrome.**
  Microsoft removed the suppression flag years ago.
- The extension is listed in `chrome://extensions` with a Remove
  button. The user **can** disable or remove it. If that's a problem,
  Edge is the right path.

### When Chrome is mandatory

If Chrome is non-negotiable (corporate standard, browser-specific
workflow that doesn't run on Edge), the only way to get the same
silence + lock as Edge is **Chrome Browser Cloud Management**:

- Free at <https://chromeenterprise.google/browser/management/>
- No domain join, no Workspace required
- The flow: register on `admin.google.com` → get an enrollment token →
  push it via registry to `HKLM\Software\Policies\Google\Chrome\CloudManagementEnrollmentToken`
- Once enrolled, push `ExtensionSettings` policy (force_installed +
  self-hosted update_url) from the cloud console
- Same trade-off as Edge: `chrome://management` shows "Managed by
  your organization"

The server now emits a ready-to-upload policy pack (force-install the
signed Sensor and **disable QUIC** so HTTP/3 cannot skip the MITM
proxy):

```
https://umbra.acme.example/ext/chrome-policy.json
https://umbra.acme.example/ext/edge-policy.json
https://umbra.acme.example/ext/chrome-policy.reg
```

Upload the JSON in CBCM / Google Admin as a custom Chrome policy, or
import the `.reg` on Windows. `QuicAllowed=false` is required for the
forward proxy to see HTTPS; without it Chrome prefers HTTP/3 and the
CONNECT tunnel never happens.

Settings in the operator panel also links these files.

---

## Operational notes

### Backing up `extkey.pem`

The server-side ECDSA key at `cassl/extkey.pem` is the **identity** of
the extension. Treat it like the MITM CA key — if you lose it:

- Every Extension ID derived from the old key becomes orphan
- Every `ExtensionInstallForcelist` policy already pushed to the
  fleet stops working
- You have to re-deploy the BAT to every machine after a fresh key
  generates a new ID

Back up `cassl/` (both `rootCA.*` and `extkey.pem`) to your password
manager / secret store the day you stand up the server.

### Bumping the extension version

Edge gates re-downloads on the `version` field in
`extension/manifest.json` (packaged into the server as
`extensions/main/manifest.json`). After you change extension code:

1. Bump `version` in `extension/manifest.json`
   (e.g. `"0.1.0"` → `"0.1.1"`)
2. Restart umbra-server (or wait for it to read the manifest on next
   `/ext/updates.xml` poll)
3. Edge will see the higher version on its next poll (within hours)
   and silently update the extension across the fleet

No client-side action is required.

### Disabling the public endpoints

If you want to stage the server but not yet serve auto-installs,
either:

- Don't ship the Edge BAT, OR
- Block `/ext/*` at your reverse proxy

The server itself currently has no flag to disable the endpoints —
they are gated only by the presence of a signing key, which is
auto-generated.
