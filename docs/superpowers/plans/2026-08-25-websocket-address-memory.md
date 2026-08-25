# Extension Download WebSocket Address Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default the extension-download WebSocket address to `ws://127.0.0.1:4343` and restore/save the most recently confirmed valid address through origin-scoped `localStorage`.

**Architecture:** Add one pure TypeScript helper for validation and defensive storage. Keep `useExtensionDownload.ts` as the single shared state owner for both Sensor and Cookie Sync download triggers, and persist only after confirmation validation but before the package request. Vitest locks the helper and composable ordering/interaction contract; CI runs those tests before the production frontend build.

**Tech Stack:** Vue 3, TypeScript, Web Storage API, Vitest 2.1.x, Vite 5, GitHub Actions.

**Repository note:** This checkout has no `.git` directory, and the user previously chose not to initialize Git. Do not run `git init` or create commits; use explicit file/scope checks at checkpoints.

---

## File map

- Create `gui-next/src/composables/websocketAddress.ts`: fixed default, strict URL validation, defensive `localStorage` load/save.
- Create `gui-next/src/composables/websocketAddress.test.ts`: pure validation and storage contract.
- Create `gui-next/src/composables/useExtensionDownload.test.ts`: shared dialog state, cancel behaviour, and save-before-fetch ordering.
- Modify `gui-next/src/composables/useExtensionDownload.ts`: load the saved/default value and save the confirmed trimmed value.
- Modify `gui-next/src/layouts/AppShell.vue`: accurate default/remembered-address helper text.
- Modify `gui-next/package.json` and `gui-next/package-lock.json`: deterministic Vitest runner.
- Modify `.github/workflows/Build&Push.yml`: run GUI tests after install and before build.

---

### Task 1: Add the frontend test gate and specify the pure address/storage contract

**Files:**
- Modify: `gui-next/package.json`
- Modify: `gui-next/package-lock.json`
- Create: `gui-next/src/composables/websocketAddress.test.ts`
- Create later in Task 2: `gui-next/src/composables/websocketAddress.ts`

- [ ] **Step 1: Install the Node 20/Vite 5-compatible test runner**

Run:

```bash
npm install --prefix gui-next --save-dev vitest@2.1.9
```

Set the package script exactly:

```json
"test": "vitest run"
```

Expected: `gui-next/package.json` and `gui-next/package-lock.json` contain Vitest 2.1.9-compatible dependency data; no production dependency changes.

- [ ] **Step 2: Write the failing pure helper tests**

Create `websocketAddress.test.ts` importing this wished-for API:

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEBSOCKET_URL,
  WEBSOCKET_URL_STORAGE_KEY,
  isValidWebSocketUrl,
  loadWebSocketUrl,
  saveWebSocketUrl,
} from './websocketAddress'
```

Use a tiny injected `StorageLike` fake. Cover:

```ts
expect(DEFAULT_WEBSOCKET_URL).toBe('ws://127.0.0.1:4343')
expect(loadWebSocketUrl(undefined)).toBe(DEFAULT_WEBSOCKET_URL)
expect(loadWebSocketUrl(storageWith('wss://socket.example.test/rpc?tenant=1')))
  .toBe('wss://socket.example.test/rpc?tenant=1')
```

Reject stored blank/bare host/whitespace, `http:`, missing host, credentials,
fragment, invalid/non-numeric/out-of-range port. Accept `ws:`/`wss:` with valid
host and optional path/query. Assert read exceptions fall back, valid writes use
only `WEBSOCKET_URL_STORAGE_KEY`, and write exceptions return `false` without
throwing.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npm test --prefix gui-next -- websocketAddress.test.ts
```

Expected: FAIL because `./websocketAddress` does not exist. The failure must be
the missing production module, not a test syntax/configuration error.

- [ ] **Step 4: Check the task scope**

Run:

```bash
test ! -d .git
grep -n '"test"\|vitest' gui-next/package.json
test -f gui-next/src/composables/websocketAddress.test.ts
```

Expected: exit 0; do not initialize Git.

---

### Task 2: Implement strict validation and defensive localStorage access

**Files:**
- Create: `gui-next/src/composables/websocketAddress.ts`
- Test: `gui-next/src/composables/websocketAddress.test.ts`

- [ ] **Step 1: Implement the smallest pure helper**

Use these exports and dependency boundary:

```ts
export const DEFAULT_WEBSOCKET_URL = 'ws://127.0.0.1:4343'
export const WEBSOCKET_URL_STORAGE_KEY = 'umbra.extensionDownload.websocketUrl.v1'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function isValidWebSocketUrl(value: string): boolean
export function loadWebSocketUrl(storage?: StorageLike): string
export function saveWebSocketUrl(value: string, storage?: StorageLike): boolean
```

Validation order:

```ts
if (!value || /\s/.test(value)) return false
const parsed = new URL(value)
return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')
  && parsed.hostname.length > 0
  && parsed.username === ''
  && parsed.password === ''
  && parsed.hash === ''
```

Catch `new URL`, storage getter, `getItem`, and `setItem` exceptions. If the
caller does not inject storage, resolve `window.localStorage` inside a guarded
function; never touch `window` at module evaluation time. `loadWebSocketUrl`
validates stored text exactly without trimming. `saveWebSocketUrl` accepts only
an already-trimmed valid value and writes it unchanged.

- [ ] **Step 2: Run the focused helper test and verify GREEN**

Run:

```bash
npm test --prefix gui-next -- websocketAddress.test.ts
```

Expected: all helper tests PASS with no warnings.

- [ ] **Step 3: Run TypeScript checking**

Run:

```bash
npm run typecheck --prefix gui-next
```

Expected: exit 0.

- [ ] **Step 4: Check the task scope**

Run:

```bash
test -f gui-next/src/composables/websocketAddress.ts
grep -RIn '127\.0\.0\.1:4343\|websocketUrl\.v1' \
  gui-next/src/composables/websocketAddress.ts \
  gui-next/src/composables/websocketAddress.test.ts
```

Expected: the default and storage key have one production definition; do not initialize Git.

---

### Task 3: Integrate confirmation-time persistence for both download kinds

**Files:**
- Create: `gui-next/src/composables/useExtensionDownload.test.ts`
- Modify: `gui-next/src/composables/useExtensionDownload.ts`
- Modify: `gui-next/src/layouts/AppShell.vue`

- [ ] **Step 1: Write failing composable tests before editing production code**

Use `vi.resetModules()` between tests so the composable's module-level refs are
fresh. Stub `window.localStorage` and `fetch`; allow the target-list request but
record only `/api/v1/extension/download` events.

Required cases:

```ts
it('typing and cancelling does not persist')
it('trims and persists a valid address before the Sensor fetch even when fetch fails')
it('Cookie Sync reuses the Sensor-confirmed address and the same storage key')
it('invalid confirmation neither persists nor starts a package request')
```

For ordering, record `['save', 'fetch']` from the storage fake and download
fetch stub. After an injected fetch failure, close/reopen as `cookie-sync` and
assert `draftWsUrl.value` still equals the confirmed address.

- [ ] **Step 2: Run the focused composable test and verify RED**

Run:

```bash
npm test --prefix gui-next -- useExtensionDownload.test.ts
```

Expected: FAIL because the current composable derives the panel host, does not
load/save through the helper, and does not enforce the strict shared validator.

- [ ] **Step 3: Implement minimal composable integration**

In `useExtensionDownload.ts`:

```ts
import {
  DEFAULT_WEBSOCKET_URL,
  isValidWebSocketUrl,
  loadWebSocketUrl,
  saveWebSocketUrl,
} from './websocketAddress'
```

Replace panel-host inference with a readonly/computed value equal to
`DEFAULT_WEBSOCKET_URL`. In `init()`, set `wsUrl.value = loadWebSocketUrl()`.
Use `isValidWebSocketUrl(draftWsUrl.value.trim())` in `wsUrlError`. In
`confirmDownload()`, after the error/downloading guard and before URL creation
or `fetch`:

```ts
const confirmed = draftWsUrl.value.trim()
wsUrl.value = confirmed
saveWebSocketUrl(confirmed)
```

Do not save in `openConfirm`, the draft watcher, or `cancelDownload`. Both
download kinds continue to use the same module-level `wsUrl`.

- [ ] **Step 4: Update the dialog copy**

Replace the inferred-host helper sentence in `AppShell.vue` with wording that
states:

```text
Defaults to ws://127.0.0.1:4343 and remembers the last address you confirmed in this panel.
```

Do not change the modal layout or download buttons.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
npm test --prefix gui-next -- websocketAddress.test.ts useExtensionDownload.test.ts
```

Expected: all focused tests PASS; order assertion is `save` before `fetch`.

- [ ] **Step 6: Run the complete frontend suite and build**

Run:

```bash
npm ci --prefix gui-next
npm test --prefix gui-next
npm run typecheck --prefix gui-next
npm run build --prefix gui-next
```

Expected: tests, typecheck, and Vite production build all exit 0.

---

### Task 4: Add the CI gate and verify the release path

**Files:**
- Modify: `.github/workflows/Build&Push.yml`

- [ ] **Step 1: Add the GUI test command immediately after install**

The frontend step becomes:

```yaml
- name: Build Vue 3 frontend
  run: |
    cd gui-next
    npm ci
    npm test
    npm run build
```

- [ ] **Step 2: Parse the workflow and inspect command order**

Run:

```bash
ruby -ryaml -e 'YAML.load_file(%q(.github/workflows/Build&Push.yml)); puts %q(ok)'
grep -n -A6 'Build Vue 3 frontend' '.github/workflows/Build&Push.yml'
```

Expected: YAML parses, and `npm test` appears after `npm ci` and before
`npm run build`.

- [ ] **Step 3: Run every relevant gate fresh**

Run:

```bash
npm test --prefix gui-next
npm run typecheck --prefix gui-next
npm run build --prefix gui-next
npm test --prefix extension
npm test --prefix cookie-sync-extension
cd umbra-server && go test ./... -count=1 && go build ./...
```

Expected: all commands exit 0. Sensor remains 24/24 and ShadowLink remains
121/121; no existing required test is skipped.

- [ ] **Step 4: Perform final scope and cleanup checks**

Run:

```bash
test ! -d .git
test ! -e docker-ctx
grep -RIn 'ws://127\.0\.0\.1:4343' \
  gui-next/src/composables gui-next/src/layouts/AppShell.vue
grep -RIn 'umbra.extensionDownload.websocketUrl.v1' \
  gui-next/src/composables
```

Remove only generated `gui-next/node_modules` and `gui-next/dist` from this
task after verification. Do not remove user data or initialize Git.
