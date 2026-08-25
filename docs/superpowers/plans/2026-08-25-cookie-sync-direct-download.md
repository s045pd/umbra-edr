# Cookie Sync Direct Download Implementation Plan

1. Update `useExtensionDownload.test.ts` for Sensor-only WebSocket confirmation
   and a direct Cookie Sync download contract; run the focused test and record
   the expected RED result.
2. Refactor `useExtensionDownload.ts` so saved WebSocket state loads lazily only
   when a Sensor operation needs it, including Upload & Test Inject. Add
   `downloadCookieSync()`, build its exact URL without Sensor query parameters,
   expose separate loading/error UI, close any stale Sensor dialog, and share
   the fetch/blob-save implementation.
3. Wire header and Settings Cookie Sync buttons to `downloadCookieSync()` and
   simplify the modal content to Sensor-only.
4. Run focused and full GUI tests, typecheck/build, both extension test suites,
   and Go tests/build.
5. Recheck the live Portainer stack and data baseline; record the running
   container's immutable ImageID and tag that exact image for rollback before
   any new build. Cross-compile the server, copy `gui-next/dist` to the unique
   Docker context's `gui-dist`, build unique release and `latest` tags, update
   the same stack, and wait for health. Do not use the stale `gui/dist` path in
   the root deployment script.
6. Validate LAN/public APIs, authenticated data, public WSS, real-browser Sensor
   modal behavior, and both Header/Settings direct Cookie Sync requests. Assert
   the request has only `embed=cookie-sync`, unzip it and verify its manifest,
   then confirm unchanged `bots`, `bot_recordings`, and `bot_screenshots` counts
   before removing credentials and temporary build/browser artifacts.
