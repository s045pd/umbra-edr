# Cookie Sync Direct Download Design

**Date:** 2026-08-25  
**Status:** User-approved correction

## Problem

The GUI currently sends both Umbra Sensor and Cookie Sync downloads through the
same **Confirm WebSocket address** dialog. This is incorrect: only the Sensor
package needs a WebSocket server address embedded into the downloaded package.
Cookie Sync (ShadowLink) talks to Umbra through the HTTP/HTTPS server URL entered
inside the extension login screen, while the server itself handles its Sensor
WebSocket connection.

## Required behavior

1. **Extension / Umbra Sensor** keeps the existing confirmation dialog.
   - Default: `ws://127.0.0.1:4343`.
   - Restore and save the most recently confirmed value using the existing
     `localStorage` key.
   - Continue sending `ws_url`, selected embed target, and optional
     `obfuscate=1` to the package endpoint.
2. **Sync / Cookie Sync** downloads immediately.
   - Do not open the WebSocket confirmation dialog.
   - Do not read, validate, or write the saved WebSocket address.
   - Request exactly the Cookie Sync package selection through
     `/api/v1/extension/download?embed=cookie-sync`; do not send `ws_url` or
     `obfuscate`.
3. Both header and Settings-page download buttons must follow the same behavior.
4. Existing backend packaging remains unchanged because the cookie-sync branch
   already builds the plain Cookie Sync extension and ignores Sensor settings.

## Error and state handling

- Sensor download errors continue to render inside its modal.
- Cookie Sync direct-download errors use the existing shared download state; the
  button must not trigger or leave the Sensor modal open. Cookie Sync has its
  own visible loading/error state outside the Sensor modal.
- Common fetch, response validation, filename selection, blob creation, and
  browser save logic should be shared to avoid two divergent download paths.
- Loading the saved WebSocket address is lazy and happens only when a Sensor
  operation needs it (the download confirmation or Upload & Test Inject);
  creating the composable or downloading Cookie Sync must not access that
  `localStorage` key.

## Tests and acceptance

- A unit test must first fail because the new direct Cookie Sync action does not
  exist.
- The corrected unit test must prove that Cookie Sync:
  - performs one package fetch,
  - has `embed=cookie-sync`,
  - omits `ws_url` and `obfuscate`,
  - does not write the WebSocket `localStorage` key,
  - does not read the WebSocket `localStorage` key,
  - does not open the confirmation dialog.
- A stale/open Sensor dialog is closed before Cookie Sync begins, and direct
  download failures remain visible outside that modal.
- Sensor persistence, validation, and failed-storage behavior remain covered.
- Sensor regression tests verify saved/default addresses, `ws_url`, selected
  embed, conditional `obfuscate=1` behavior, and lazy address loading for
  Upload & Test Inject.
- Full GUI, Sensor extension, Cookie Sync extension, and Go test/build suites
  must pass before deployment.
- Production browser acceptance must prove Sync downloads a valid Cookie Sync
  ZIP without the modal or extra query parameters from both Header and Settings,
  while Extension still opens the modal with the default or saved WebSocket
  address.

## Deployment boundary

Deploy to the existing Umbra Portainer stack only after the approved correction
passes all local gates. Preserve PostgreSQL/Redis data and verify exact critical
row counts before and after the update. Record the current deployed image ID
before any build/update, tag that immutable image for rollback, and retain it.
Use a quiet read-only baseline for `bots`, `bot_recordings`, and
`bot_screenshots`; this GUI-only change performs no application data writes.
