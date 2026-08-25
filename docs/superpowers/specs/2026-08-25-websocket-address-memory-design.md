# Extension Download WebSocket Address Memory Design

**Date:** 2026-08-25  
**Status:** User-approved approach A  
**Component:** Umbra GUI extension-download confirmation dialog

## 1. Goal

Make every **Confirm WebSocket address** dialog start with a safe local default
and remember the last address the operator explicitly confirmed.

The exact default is:

```text
ws://127.0.0.1:4343
```

This behaviour applies to both Umbra Sensor and Cookie Sync/ShadowLink package
downloads.

## 2. Behaviour

1. On first use, or when no usable saved value exists, the input is populated
   with `ws://127.0.0.1:4343`.
2. A saved value is validated exactly as stored. Any leading, trailing, or
   internal whitespace makes it unusable and causes default fallback.
3. Opening the confirmation dialog uses the current valid value, which is
   initialized from the most recently saved valid value or the fixed default.
4. When the operator clicks **Download .zip**:
   - trim leading/trailing whitespace from the input;
   - validate the trimmed input;
   - update the shared in-memory address;
   - write the address to `localStorage`; then
   - start the package request.
5. Save before the network request. A transient packaging/download failure must
   not discard the operator's last confirmed address.
6. Cancelling or merely typing in the field does not change the saved value.
7. Umbra Sensor and Cookie Sync downloads share one saved address.
8. `localStorage` is origin-scoped. LAN and public panel origins retain their
   own most recent address, as required by browser storage rules.

## 3. Storage contract

Use one stable, versioned key:

```text
umbra.extensionDownload.websocketUrl.v1
```

Storage access must be defensive:

- missing `window`/`localStorage`, `SecurityError`, quota errors, or other read
  failures fall back to the fixed default;
- invalid/corrupted stored text is ignored;
- write failures do not block an otherwise valid download attempt; and
- storage errors and values are not logged.

Address validation uses `new URL(value)` and requires all of the following:

- no whitespace anywhere in the value being validated;
- protocol is exactly `ws:` or `wss:`;
- hostname is non-empty;
- username and password are empty;
- fragment/hash is empty; and
- any explicit port is syntactically valid and within the range accepted by
  the URL parser.

Paths and query strings remain allowed because WebSocket endpoints may use
them. Validation does not normalize the saved value: after confirmation, save
the operator's exact trimmed text. For stored values, do not trim before
validation; surrounding whitespace means the value is corrupted and the
fixed default is used.

## 4. Code structure

Add a small pure helper module under `gui-next/src/composables/` that owns:

- `DEFAULT_WEBSOCKET_URL`;
- `WEBSOCKET_URL_STORAGE_KEY`;
- WebSocket-address validation;
- defensive load with default fallback; and
- defensive save.

`useExtensionDownload.ts` remains the single owner of dialog/download state.
It initializes `wsUrl` from the helper, populates `draftWsUrl` when the dialog
opens, and persists the trimmed value after confirmation validation and before
`fetch`.

Update the dialog helper text so it states that the default is local and the
last confirmed address is remembered. Remove the current claim that the value
is inferred from the panel URL.

## 5. Testing and CI

Add focused frontend unit tests before implementation. They must prove:

1. missing storage returns `ws://127.0.0.1:4343`;
2. a valid saved `ws://` or `wss://` address is restored;
3. blank, malformed, bare-host, and whitespace-containing values fall back;
4. invalid protocols, missing hosts, embedded credentials, fragments, and
   invalid/out-of-range ports are rejected, while valid paths/queries remain
   allowed;
5. read exceptions fall back without throwing;
6. a valid confirmed value is saved exactly after trimming;
7. write exceptions do not throw or block the caller;
8. typing and cancelling never save;
9. Sensor and Cookie Sync confirmations use the same in-memory value and the
   same storage key; and
10. the download composable saves only after validation, before invoking
    `fetch`, including when `fetch` later fails, and reopening after that
    failure restores the confirmed value.

Use a Node 20/Vite 5-compatible Vitest release (Vitest `2.1.x`) for the
TypeScript unit tests. Add `"test": "vitest run"` to
`gui-next/package.json`, add the compatible dev dependency, and update
`gui-next/package-lock.json`. CI runs the frontend unit tests after `npm ci`
and before `npm run build`; `vitest run` must terminate deterministically.

Fresh verification:

```bash
npm ci --prefix gui-next
npm test --prefix gui-next
npm run build --prefix gui-next
```

The existing Sensor, ShadowLink, and Go test gates remain unchanged.

## 6. Non-goals

- Do not synchronize the address between different browser origins or devices.
- Do not save on every keystroke.
- Do not migrate any older, unrelated storage keys.
- Do not change server-side WebSocket URL substitution or download packaging.
- Do not change the WebSocket address inside an already downloaded extension.
