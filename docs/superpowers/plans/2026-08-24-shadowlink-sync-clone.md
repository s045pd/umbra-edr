# ShadowLink Sync and Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-destructive, selectable Sync flow and a verified, recoverable Clone/Restore flow that can use live or trusted cached browser snapshots without requiring the source endpoint to remain online.

**Architecture:** The Sensor will produce one immutable five-category snapshot through a resumable IndexedDB-backed, 512 KiB chunk protocol. The Go server will verify and atomically persist exact snapshot bytes, expose credential-scoped job/status/chunk endpoints, and fall back to trusted cache without mixing provenance. ShadowLink's background worker will download and verify snapshots, run durable Sync/Clone/Restore state machines through tested Chrome adapters, and keep the popup as a start/confirm/progress UI only.

**Tech Stack:** Chrome Manifest V3 APIs, IndexedDB, Web Crypto/SHA-256, JavaScript with Node 20 `node:test`, Go 1.25/GORM/PostgreSQL/SQLite tests, chi HTTP, existing WebSocket RPC, RFC 8785 JCS (`canonicalize` 4.0.0-derived JavaScript plus the Cyberphone Go reference implementation).

---

## Preconditions and execution rules

- The approved design is `docs/superpowers/specs/2026-08-24-shadowlink-sync-clone-design.md`. Treat it as normative when this plan abbreviates a rule.
- Run implementation with `@superpowers:test-driven-development`. For every production change below: add one focused failing test, run it and observe the intended failure, add the smallest implementation, then rerun the focused and nearby suites.
- Before claiming a task or release complete, run `@superpowers:verification-before-completion` and capture fresh command output.
- The current archive at `the umbra-edr working tree` has no `.git` metadata. The commit commands below are required checkpoints when execution is moved to a real clone/worktree. If work must stay in this archive, skip only the `git add`/`git commit` command and record `SKIPPED: no Git metadata`; do not initialize a new repository without explicit user approval.
- Never log request bodies, category bytes, cookie objects/values, admin credentials, proxy passwords, backup bytes, or snapshot bytes. Tests should use obvious sentinel secrets and assert they are absent from logs/errors.
- Keep the old `SYNC`/`SYNC_HUGE` GUI-array path and old cookie/history HTTP endpoints for compatibility. New Sync/Clone uses only the versioned snapshot API.

## Locked file map

### Shared contract and third-party attribution

- Create `testdata/browser_snapshot/jcs_vectors.json`: cross-runtime RFC 8785 inputs and expected canonical UTF-8 strings/digests.
- Create `testdata/browser_snapshot/manifest_v1.json`: a complete five-category capture-manifest fixture.
- Create `THIRD_PARTY_NOTICES.md`: pin and attribute the JavaScript and Go JCS implementations.

### Go server

- Create `umbra-server/internal/db/models/browser_snapshot.go`: immutable snapshot row and durable daily-refresh watermark row.
- Modify `umbra-server/internal/db/models/models.go`: include both new models in fresh-schema migration.
- Modify `umbra-server/internal/db/migrate.go`: always run narrow checked migration for snapshot tables/indexes on existing databases and propagate column/migration failures.
- Modify `umbra-server/internal/db/migrate_test.go`: fresh, legacy, idempotence, index, error, and BYTEA insert/read coverage.
- Create `umbra-server/internal/browsersnapshot/types.go`: start with the manifest contract in Task 1, then extend it in Task 3 with status/result/error and injected RPC function types.
- Create `umbra-server/internal/browsersnapshot/coverage.go`: 7/30/90/all coverage parsing, ranking, and compatibility.
- Create `umbra-server/internal/browsersnapshot/canonical.go`: JCS manifest verification, SHA-256, exact-byte and descriptor checks.
- Create `umbra-server/internal/browsersnapshot/stage.go`: bounded temporary-file category staging and cleanup.
- Create `umbra-server/internal/browsersnapshot/store.go`: immutable promotion, trusted lookup, retention, legacy snapshot resolution, and refresh watermarks.
- Create `umbra-server/internal/browsersnapshot/manager.go`: one-job-per-endpoint coordination, Sensor polling/chunk retrieval, widening/joining, fallback, TTL, and background warming.
- Create focused `*_test.go` files beside each server file above.
- Create `umbra-server/internal/api/bot_credentials.go`: shared proxy-credential lookup without logging secrets.
- Create `umbra-server/internal/api/browser_snapshot.go`: start/status/raw-chunk HTTP handlers.
- Create `umbra-server/internal/api/browser_snapshot_test.go`: credential, provenance, manifest-only status, header, bounded-body, and denial tests.
- Modify `umbra-server/internal/api/proxy_creds.go`: reuse the credential helper; leave legacy endpoint semantics intact.
- Modify `umbra-server/internal/api/server.go`: add snapshot service dependency and three public routes.
- Modify `umbra-server/internal/auth/middleware.go` and its test: expose only the snapshot metadata headers required by extension fetch.
- Modify `umbra-server/internal/ws/protocol.go`: add four v1 snapshot RPC action constants and AUTH capability fields.
- Modify `umbra-server/internal/ws/handlers.go`, `server.go`, and tests: retain authenticated capabilities and invoke a non-blocking connected hook after registration.
- Modify `umbra-server/cmd/umbra-server/main.go`: construct/close the snapshot manager, inject it into API, and connect the warm-capture hook.
- Modify `umbra-server/go.mod` and `go.sum`: pin the Go JCS implementation.

### Umbra Sensor extension

- Create `extension/package.json` and `extension/package-lock.json`: dependency-free Node 20 test harness.
- Create `extension/src/bg/snapshot/canonicalize.js`: classic-worker/CommonJS adaptation pinned from `canonicalize@4.0.0`.
- Create `extension/src/bg/snapshot/constants.js`: fixed schema/category/limit/action constants.
- Create `extension/src/bg/snapshot/history-collector.js`: resumable range-window planner, bisection, dedupe, and truncation detection.
- Create `extension/src/bg/snapshot/indexeddb-store.js`: staged job/category/chunk persistence with TTL cleanup.
- Create `extension/src/bg/snapshot/snapshot-job.js`: BEGIN/STATUS/CHUNK/RELEASE orchestration and immutable manifest production.
- Create `extension/test/snapshot/*.test.cjs`: JCS vectors, history, errors, interruption, limits, immutability, and TTL tests.
- Create `extension/src/bg/background-core.js`: move the existing Sensor worker implementation here, then advertise capability, register four RPCs, and make collector errors explicit without loader-specific calls.
- Modify `extension/src/bg/background.js`: reduce to the classic bootstrap that `importScripts` the five snapshot helpers and `background-core.js`.
- Create `extension/src/bg/background-module.js`: module-target bootstrap that side-effect imports the same five helpers and `background-core.js`.
- Modify `extension/manifest.json`: bump to `0.2.0` and add `unlimitedStorage`; keep the service worker classic so merged classic target extensions continue to work.
- Modify `umbra-server/internal/api/extension.go`: choose the classic or module Sensor bootstrap to match a merged target worker and exclude development-only extension files.
- Create `umbra-server/internal/api/extension_test.go`: package a standalone Sensor plus real classic and module merge targets.

### ShadowLink extension

- Create `cookie-sync-extension/package.json` and lockfile: dependency-free ESM Node 20 test harness.
- Create `cookie-sync-extension/src/lib/canonicalize.js`, `hash.js`, `constants.js`, `identity.js`, and `planners.js`: pure JCS/digest/identity/preflight/merge/replace functions.
- Create `cookie-sync-extension/src/bg/idb.js`: `shadowlink_sync_v1` schema and atomic pointer/lease helpers.
- Create `cookie-sync-extension/src/bg/snapshot-client.js`: start/poll/chunk/resume/digest client.
- Create `cookie-sync-extension/src/bg/chrome-adapters.js`: strict Promise wrappers for cookies/history/bookmarks/tabs with `runtime.lastError` handling.
- Create `cookie-sync-extension/src/bg/backup.js`: complete staged backup, read-back verification, promotion, and freshness recheck.
- Create `cookie-sync-extension/src/bg/sync-job.js`: category-isolated non-destructive merge.
- Create `cookie-sync-extension/src/bg/clone-job.js`: destructive state machine, journal, verification, and rollback.
- Create `cookie-sync-extension/src/bg/restore-job.js`: distinct Restore source/recovery backup handling and Undo Restore retention.
- Create `cookie-sync-extension/src/bg/job-runner.js`: single-writer lease, alarms, startup recovery, messages, and progress.
- Modify `cookie-sync-extension/src/bg/sw.js`: preserve proxy auth/badge behaviour and initialize the job runner.
- Create `cookie-sync-extension/test/**/*.test.js`: pure planning plus fake Chrome/IDB/fetch effect tests.
- Create `cookie-sync-extension/src/browser_action/job-client.js`, `dialogs.js`, and `archive-view.js`: popup message/UI modules.
- Modify `cookie-sync-extension/src/browser_action/main.js`, `browser_action.html`, and `popup-styles.css`: Sync/Clone dialogs, confirmation, durable progress, backup controls, archives, and export.
- Modify `cookie-sync-extension/manifest.json`: bump to `3.0.0`, set minimum Chrome 119, and add `history`, `bookmarks`, `tabs`, `alarms`, and `unlimitedStorage` (not `downloads`).

### Release and operator verification

- Modify `.github/workflows/Build&Push.yml`: run both extension test suites before packaging.
- Modify `umbra-server/internal/api/extension_test.go`: prove nested helper/test exclusions and manifest permissions/version package correctly.
- Create `umbra-server/test/integration/browser_snapshot_flow_test.go`: live, offline cached, fallback, auth isolation, and immutable chunk integration.
- Create `docs/shadowlink-sync-clone-operations.md`: operator workflow, limitations, recovery states, and acceptance checklist.
- Modify `docs/deployment.md`: ordered server migration/Sensor/ShadowLink rollout and rollback guidance.

## Wire and storage contracts to use verbatim

Use these fixed values in all three runtimes:

```text
schema_version              = 1
categories                  = cookies, history, bookmarks, downloads, tabs
chunk_size                  = 524288 bytes
max_total_bytes             = 67108864
max_category_bytes          = 33554432
max_items_per_category      = 250000
capture_deadline_ms         = 300000
sensor_staging_ttl_ms       = 600000
server_legacy_stage_ttl_ms  = 600000
warm_refresh_interval       = 24h
per_sensor_rpc_timeout      = 10s
```

RPC actions:

```text
BEGIN_BROWSER_SNAPSHOT_V1
GET_BROWSER_SNAPSHOT_STATUS_V1
GET_BROWSER_SNAPSHOT_CHUNK_V1
RELEASE_BROWSER_SNAPSHOT_V1
```

Sensor RPC payloads (all responses remain inside the existing `{data,result}` RPC envelope):

```jsonc
// BEGIN request
{
  "snapshot_id": "server-generated-uuid",
  "schema_version": 1,
  "history_range": "all",
  "chunk_size": 524288,
  "max_total_bytes": 67108864,
  "max_category_bytes": 33554432,
  "max_items_per_category": 250000,
  "deadline_at": "2026-08-24T06:36:52.000Z"
}

// BEGIN or STATUS while running
{"status":"pending","snapshot_id":"...","poll_after_ms":1000,"progress":{"phase":"history","completed":2,"total":5}}

// STATUS when ready; manifest_base64 is the exact RFC 8785 UTF-8 capture-manifest bytes
{"status":"ready","snapshot_id":"...","manifest_base64":"...","manifest_sha256":"..."}

// STATUS on terminal acquisition failure
{"status":"failed","snapshot_id":"...","error_code":"history_window_incomplete"}

// CHUNK request
{"snapshot_id":"...","category":"history","chunk_index":0}

// CHUNK response; byte_length is decoded bytes for this chunk
{
  "snapshot_id":"...",
  "category":"history",
  "chunk_index":0,
  "chunk_count":2,
  "byte_length":524288,
  "chunk_sha256":"...",
  "category_sha256":"...",
  "bytes_base64":"..."
}

// RELEASE request / response
{"snapshot_id":"..."}
{"released":true}
```

Reject a response whose echoed snapshot/category/index differs from the request. Progress is operational metadata and never enters the capture manifest or its digest.

HTTP routes:

```text
POST /api/v1/get-bot-browser-snapshot
POST /api/v1/get-bot-browser-snapshot-status
POST /api/v1/get-bot-browser-snapshot-chunk
```

Trusted sources are exactly `live`, `cached`, and `cached_fallback`. `legacy_cached` is Sync-only, has no invented capture time or trusted capture-manifest digest, and may expose only non-empty old arrays. Never assemble a response from more than one trusted row or mix trusted and legacy fields.

---

### Task 1: Establish the cross-runtime RFC 8785 and digest contract

**Files:**
- Create: `testdata/browser_snapshot/jcs_vectors.json`
- Create: `testdata/browser_snapshot/manifest_v1.json`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `umbra-server/internal/browsersnapshot/canonical.go`
- Create: `umbra-server/internal/browsersnapshot/canonical_test.go`
- Create: `umbra-server/internal/browsersnapshot/types.go`
- Create: `extension/package.json`
- Create: `extension/package-lock.json`
- Create: `extension/src/bg/snapshot/canonicalize.js`
- Create: `extension/test/snapshot/canonicalize.test.cjs`
- Create: `cookie-sync-extension/package.json`
- Create: `cookie-sync-extension/package-lock.json`
- Create: `cookie-sync-extension/src/lib/canonicalize.js`
- Create: `cookie-sync-extension/src/lib/hash.js`
- Create: `cookie-sync-extension/test/canonicalize.test.js`
- Modify: `umbra-server/go.mod`
- Modify: `umbra-server/go.sum`

- [ ] **Step 1: Add shared vectors before any canonicalizer implementation**

Store each JSON input as a string so lexical cases such as `-0` survive fixture parsing. Include the RFC sample plus Unicode key ordering/non-BMP text, escaping/control characters, integers, fractions/exponents, negative zero, empty arrays, the five descriptors in deliberately shuffled order, lone-surrogate rejection, NaN/Infinity rejection at the JavaScript object API, and a complete `manifest_v1` expected canonical string plus SHA-256.

Minimum fixture shape:

```json
{
  "valid": [
    {"name":"negative-zero","input":"[-0]","canonical":"[0]"},
    {"name":"empty-array","input":"[]","canonical":"[]"},
    {"name":"key-order","input":"{\"z\":1,\"a\":2}","canonical":"{\"a\":2,\"z\":1}"}
  ],
  "invalid": [
    {"name":"lone-surrogate","input":"[\"\\ud800\"]"}
  ]
}
```

- [ ] **Step 2: Write failing Go and JavaScript vector tests**

Set both package scripts to `"test": "node --test"`; keep Sensor at CommonJS default and set ShadowLink to `"type": "module"`. The Go test must call `Canonicalize([]byte(vector.Input))`; both JavaScript tests must parse `input`, call their local canonicalizer, UTF-8 encode the result, and compare exact bytes. All three must read the same root fixture. Add a second test that removes `manifest_sha256`, canonicalizes the manifest, computes lowercase SHA-256, and compares the fixture digest.

- [ ] **Step 3: Run all three focused suites and observe the red state**

Run:

```bash
cd umbra-server && go test ./internal/browsersnapshot -run 'TestJCSVectors|TestManifestDigest' -count=1 -v
cd ../extension && npm test -- --test-name-pattern='JCS|manifest digest'
cd ../cookie-sync-extension && npm test -- --test-name-pattern='JCS|manifest digest'
```

Expected: FAIL because the packages/modules/functions do not exist yet; no test should be skipped.

- [ ] **Step 4: Pin the reference implementations and attribution**

Run from `umbra-server`:

```bash
go get github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer@19d51d7fe467d4706a3ff08adf8a748f29fc21e0
go mod tidy
```

Adapt the Apache-2.0 `canonicalize@4.0.0` implementation into one classic-worker/CommonJS file for Sensor and one ESM file for ShadowLink. Preserve lone-surrogate, non-finite-number, circular-reference, array, and recursive sorted-object handling. Record source URL, version/commit, license, and local file paths in `THIRD_PARTY_NOTICES.md`; do not fetch code dynamically at runtime.

- [ ] **Step 5: Implement exact Go wrappers**

Add the fixed category order, `FieldDescriptor`, and `CaptureManifest` to `types.go`. `canonical.go` must expose:

```go
func Canonicalize(input []byte) ([]byte, error)
func SHA256Hex(input []byte) string
func VerifyManifestBytes(canonicalBytes []byte, claimedSHA string) (CaptureManifest, error)
func CanonicalManifestBytes(m CaptureManifest) ([]byte, error)
```

`VerifyManifestBytes` rejects non-canonical input, unknown schema, missing/extra category descriptors, unsafe/unexpected numbers, a digest member included in hashed bytes, and digest mismatch. It must never include input bytes in returned errors.

- [ ] **Step 6: Run focused tests green and cross-compare outputs**

Run the three commands from Step 3, then:

```bash
cd umbra-server && go test ./internal/browsersnapshot -count=1
cd ../extension && npm test
cd ../cookie-sync-extension && npm test
```

Expected: all PASS and all runtimes emit byte-identical fixture results.

- [ ] **Step 7: Commit the contract checkpoint**

```bash
git add THIRD_PARTY_NOTICES.md testdata/browser_snapshot umbra-server/go.mod umbra-server/go.sum umbra-server/internal/browsersnapshot extension/package*.json extension/src/bg/snapshot/canonicalize.js extension/test cookie-sync-extension/package*.json cookie-sync-extension/src/lib cookie-sync-extension/test
git commit -m "test: lock browser snapshot canonicalization contract"
```

---

### Task 2: Add immutable snapshot persistence and production-safe migration

**Files:**
- Create: `umbra-server/internal/db/models/browser_snapshot.go`
- Modify: `umbra-server/internal/db/models/models.go:131-141`
- Modify: `umbra-server/internal/db/migrate.go:19-64`
- Modify: `umbra-server/internal/db/migrate_test.go`

- [ ] **Step 1: Write failing fresh/legacy/idempotence/index tests**

Add tests that:

1. call `Migrate` on an empty SQLite DB;
2. separately pre-create legacy `users`, `bots`, and `settings`, then call `Migrate` (proving the broad-migration skip still creates the two snapshot tables);
3. assert unique `(bot_id, snapshot_seq)` and unique `snapshot_id` indexes;
4. insert and read payloads containing non-ASCII exact bytes and compare with `bytes.Equal`;
5. rerun `Migrate` and prove rows/bytes/indexes remain unchanged; and
6. use a deliberately closed DB to assert a narrow migration error reaches the caller.

- [ ] **Step 2: Run the migration tests red**

Run:

```bash
cd umbra-server && go test ./internal/db -run 'TestMigrate_.*BrowserSnapshot|TestBrowserSnapshot_BYTEA' -count=1 -v
```

Expected: FAIL because the new tables/models do not exist.

- [ ] **Step 3: Define the two models with explicit table/index names**

`BotBrowserSnapshot` must contain the immutable fields from design §5.3, including one `[]byte gorm:"type:bytea"` payload per category, one exact canonical manifest `[]byte`, all five descriptor counts/lengths/digests, history coverage/truncation, capture/receive times, Sensor version/capabilities, `snapshot_seq`, `snapshot_id`, and `bot_id`.

`BotBrowserSnapshotState` is one row per bot and contains `last_full_attempt_at` and `last_full_success_at`. Use explicit named indexes so tests do not rely on GORM-generated names.

- [ ] **Step 4: Implement narrow checked migration**

Always execute this after the fresh-schema conditional:

```go
if err := gdb.AutoMigrate(
    &models.BotBrowserSnapshot{},
    &models.BotBrowserSnapshotState{},
); err != nil {
    return "", fmt.Errorf("migrate browser snapshots: %w", err)
}
```

Change `addColumnIfMissing` to return an error, use identifier constants rather than arbitrary caller input, and return its failure from `Migrate`. Include both models in `models.All()` for clean DBs.

- [ ] **Step 5: Run migration and full DB suites green**

Run:

```bash
cd umbra-server && go test ./internal/db -count=1 -v
```

Expected: PASS. The first `cd` typo fallback intentionally demonstrates the real directory is `umbra-server`; remove the typo from any automation and use `cd umbra-server` there.

- [ ] **Step 6: Commit the migration checkpoint**

```bash
git add umbra-server/internal/db/models/browser_snapshot.go umbra-server/internal/db/models/models.go umbra-server/internal/db/migrate.go umbra-server/internal/db/migrate_test.go
git commit -m "feat: persist immutable browser snapshots"
```

---

### Task 3: Implement trusted lookup, promotion, retention, and legacy isolation

**Files:**
- Modify: `umbra-server/internal/browsersnapshot/types.go`
- Create: `umbra-server/internal/browsersnapshot/coverage.go`
- Create: `umbra-server/internal/browsersnapshot/store.go`
- Create: `umbra-server/internal/browsersnapshot/coverage_test.go`
- Create: `umbra-server/internal/browsersnapshot/store_test.go`

- [ ] **Step 1: Write table-driven coverage and store tests**

Cover `7`, `30`, `90`, and `all`; reject all other strings. Prove `all` satisfies every narrower request, `90` satisfies 7/30 but not all, and a narrower row never deletes/replaces the retained newest full row. Also test monotonic per-bot sequence allocation under concurrent goroutines, immutable insert (no update path), invalid descriptor/byte/count rejection, atomic no-row-on-failure, newest qualifying lookup, and retention of newest row per coverage.

Legacy tests must prove:

- a non-empty old `bots.cookies` value is returned as a legacy category;
- an empty/NULL old array is unavailable, never authoritative empty;
- legacy categories all come from the same bot row read and are never promoted;
- no capture timestamp or trusted `manifest_sha256` is invented; and
- `CloneEligible()` is false whenever any category is legacy.

- [ ] **Step 2: Run store tests red**

```bash
cd umbra-server && go test ./internal/browsersnapshot -run 'TestCoverage|TestStore|TestLegacy' -count=1 -v
```

Expected: FAIL with undefined coverage/store APIs.

- [ ] **Step 3: Implement fixed types and safe limits**

Define `Category` as a validated string type and expose only this order:

```go
var Categories = [...]Category{Cookies, History, Bookmarks, Downloads, Tabs}
```

Define `CaptureManifest`, `FieldDescriptor`, `ReadySnapshot`, `JobStatus`, stable error codes, and the hard limits exactly as listed above. Never iterate an untrusted map to establish digest order.

- [ ] **Step 4: Implement transactional promotion and retention**

`Store.Promote(ctx, VerifiedSnapshot)` must start one DB transaction, allocate `MAX(snapshot_seq)+1` while serializing per bot, insert one immutable row, update the full-success watermark when appropriate, apply per-coverage retention only after the insert, and commit. A validation or DB error rolls back everything. There must be no public update method for snapshot payloads.

- [ ] **Step 5: Implement trusted and legacy resolution**

`FindTrusted(botID, requestedCoverage)` returns exactly one newest compatible row. `ResolveLegacy(bot)` serializes each usable old array once into ephemeral exact bytes/descriptors, marks every returned category `legacy: true`, omits empty/unknown fields, and never returns `CloneEligible=true`.

- [ ] **Step 6: Run focused and race tests green**

```bash
cd umbra-server
go test ./internal/browsersnapshot -count=1 -v
go test -race ./internal/browsersnapshot -run 'TestStore_ConcurrentSequence' -count=1
```

Expected: PASS; race detector reports no races.

- [ ] **Step 7: Commit the store checkpoint**

```bash
git add umbra-server/internal/browsersnapshot
git commit -m "feat: resolve and retain trusted browser snapshots"
```

---

### Task 4: Build the Sensor's range-aware, resumable history collector

**Files:**
- Create: `extension/src/bg/snapshot/constants.js`
- Create: `extension/src/bg/snapshot/history-collector.js`
- Create: `extension/test/snapshot/history-collector.test.cjs`

- [ ] **Step 1: Write failing planner/collector tests with a fake History API**

Test exact start times for 7/30/90/all, fixed `endTime`, full-window bisection, URL dedupe, newest `lastVisitTime`, maximum `typedCount`/`visitCount`, deterministic URL ordering, persisted queue/cursor resume, minimum-window truncation, item limit, and acquisition deadline. Inject `now`, `search`, ceiling, and minimum window so tests do not sleep.

The fake must expose a `chrome.runtime.lastError` branch and assert that branch yields `{available:false,error_code:"history_api_error"}` rather than `{available:true,items:[]}`.

- [ ] **Step 2: Run the history tests red**

```bash
cd extension && npm test -- --test-name-pattern='history'
```

Expected: FAIL because `history-collector.js` is absent.

- [ ] **Step 3: Implement one resumable window step at a time**

Expose pure helpers plus:

```js
async function advanceHistoryCapture(state, adapters, limits) {
  // consumes at most one queued window, checkpoints, and returns pending/ready/failed
}
```

When a result length equals the ceiling, bisect unless the window is already at minimum width. At minimum width, set `truncated: true` and fail Clone eligibility; never silently discard results. Use URL as the stable key and preserve the full Chrome `HistoryItem` metadata object after applying the approved source-wins aggregation.

- [ ] **Step 4: Run focused tests green**

```bash
cd extension && npm test -- --test-name-pattern='history'
```

Expected: PASS with no real Chrome dependency.

- [ ] **Step 5: Commit the collector checkpoint**

```bash
git add extension/src/bg/snapshot/constants.js extension/src/bg/snapshot/history-collector.js extension/test/snapshot/history-collector.test.cjs
git commit -m "feat: collect complete resumable browser history"
```

---

### Task 5: Add Sensor IndexedDB staging and the four immutable snapshot RPCs

**Files:**
- Create: `extension/src/bg/snapshot/indexeddb-store.js`
- Create: `extension/src/bg/snapshot/snapshot-job.js`
- Create: `extension/test/snapshot/indexeddb-store.test.cjs`
- Create: `extension/test/snapshot/snapshot-job.test.cjs`
- Create: `extension/src/bg/background-core.js` (move the current `background.js` implementation here)
- Create: `extension/src/bg/background-module.js`
- Modify: `extension/src/bg/background.js:1-1614` (replace with the classic bootstrap)
- Modify: `extension/manifest.json`
- Modify: `umbra-server/internal/api/extension.go:268-367,461-475`
- Create: `umbra-server/internal/api/extension_test.go`

- [ ] **Step 1: Write failing job-protocol tests**

Use a fake IndexedDB adapter and fake Chrome collectors to test:

- BEGIN is idempotent by `snapshot_id` and returns pending quickly;
- all five collectors run under one capture window;
- one category error marks it unavailable and prevents ready/trusted promotion;
- authoritative empty arrays hash exact UTF-8 `[]`;
- bytes are serialized once, stored, hashed, and chunked without reserialization;
- repeat CHUNK calls return identical base64 bytes/digest/index;
- wrong snapshot/category/index is rejected;
- worker termination after every history window resumes from the checkpoint;
- total/category/item/deadline limits fail with stable codes;
- RELEASE removes staging; TTL GC removes only expired, non-active jobs; and
- no result/error contains a sentinel cookie value.

- [ ] **Step 2: Run Sensor snapshot tests red**

```bash
cd extension && npm test -- --test-name-pattern='snapshot job|IndexedDB'
```

Expected: FAIL with missing store/job implementations.

- [ ] **Step 3: Implement the Sensor stores and state machine**

Use one database such as `umbra_sensor_snapshot_v1` with stores `jobs`, `category_bytes`, and `chunks`. Persist state/cursors before returning from every RPC. BEGIN receives server-generated `snapshot_id`, `history_range`, fixed limits, and deadline. STATUS renews the lease and advances bounded work; CHUNK is read-only; RELEASE is idempotent.

- [ ] **Step 4: Split the Sensor implementation from its classic/module bootstraps**

Move the current `background.js` implementation to `background-core.js`; do not duplicate its 1,600-line body. Remove loader calls from the core. Replace `background.js` with this classic dependency order:

```js
importScripts(
  "./snapshot/canonicalize.js",
  "./snapshot/constants.js",
  "./snapshot/history-collector.js",
  "./snapshot/indexeddb-store.js",
  "./snapshot/snapshot-job.js",
  "./background-core.js",
);
```

Create `background-module.js` with side-effect ESM imports in the same order, ending in `import "./background-core.js";`. The UMD-style helper files attach their APIs to `globalThis`, so the same helper bytes work from either bootstrap; `background-core.js` must access them explicitly as `globalThis.UmbraSnapshot...` rather than relying on implicit global identifier binding. Add four bound RPC handlers to the core's `RPC_CALL_TABLE`. Extend AUTH output with:

```json
{"capabilities":{"browser_snapshot_v1":true,"schema_versions":[1],"chunk_size":524288}}
```

Replace collector callbacks that ignore `chrome.runtime.lastError` with strict adapters used by snapshot jobs. Keep old `SYNC_HUGE` behaviour compatible, but its collector failure must omit the failed field rather than turn it into a trusted empty array.

- [ ] **Step 5: Add failing package tests for both worker target types**

Add real package tests that create temporary target manifests/scripts, call `buildStandalone`/`buildMerged`, inspect the ZIP, and assert:

- standalone Sensor contains both bootstraps, core, and all helpers and still points at the classic bootstrap;
- a classic merge wrapper uses only `background.js` through `importScripts`;
- a module merge wrapper uses only `background-module.js` through `import`;
- both ZIPs include every referenced relative module/helper; and
- `test/`, `package.json`, and lockfiles are excluded while `src/` is retained.

- [ ] **Step 6: Run the named package tests red**

First run before the wrapper/filter implementation and observe the module-target failure:

```bash
cd umbra-server && go test ./internal/api -run 'TestBuildStandaloneSensorSnapshotFiles|TestBuildMergedClassicSensorBootstrap|TestBuildMergedModuleSensorBootstrap' -count=1 -v
```

Expected: FAIL because module bootstrap selection/file filtering is not implemented; zero-test output is not acceptable.

- [ ] **Step 7: Implement matching classic/module package wrappers**

Change `buildServiceWorkerWrapper` so a classic target emits `importScripts('_umbra/src/bg/background.js')`, while a target with `background.type: "module"` emits `import './_umbra/src/bg/background-module.js'`. Do not ever import the classic bootstrap as a module. Update the extension package filter so the new test assertions pass without excluding runtime `src/` files.

- [ ] **Step 8: Bump Sensor version and storage permission**

Set manifest version `0.2.0`, add `unlimitedStorage`, retain a classic background worker, and ensure nested snapshot files are packaged. Do not add remote code or npm runtime dependencies.

- [ ] **Step 9: Run Sensor and real packaging tests green**

```bash
cd extension && npm test
cd ../umbra-server && go test ./internal/api -run 'TestBuildStandaloneSensorSnapshotFiles|TestBuildMergedClassicSensorBootstrap|TestBuildMergedModuleSensorBootstrap' -count=1 -v
```

Expected: PASS; existing merged classic service-worker behaviour remains valid.

- [ ] **Step 10: Commit the Sensor protocol checkpoint**

```bash
git add extension umbra-server/internal/api/extension.go umbra-server/internal/api/extension_test.go
git commit -m "feat: expose immutable chunked browser snapshots"
```

---

### Task 6: Coordinate live Sensor jobs and exact-byte server staging

**Files:**
- Create: `umbra-server/internal/browsersnapshot/stage.go`
- Create: `umbra-server/internal/browsersnapshot/stage_test.go`
- Create: `umbra-server/internal/browsersnapshot/manager.go`
- Create: `umbra-server/internal/browsersnapshot/manager_test.go`

- [ ] **Step 1: Write failing manager tests around injected RPC functions**

The fake Sensor should return a canonical manifest and base64 chunks. Test online pending-to-ready, `prefer_live:true` starting a new live job even when a qualifying trusted row already exists, `prefer_live:false` returning that row without RPC, 10-second per-call contexts, exact chunk ordering, duplicate repeat acceptance only when bytes/digest match, wrong index/digest/length/count rejection, 64/32 MiB and item limits, five-minute logical timeout, temp-file cleanup, no trusted row on partial failure, promotion on complete success, cached fallback without modifying the cached row, and failed-without-cache. Cancel the caller's `Start` context immediately after it receives `pending` and prove the Manager-owned job still reaches ready. Force the Sensor session to disappear after BEGIN, reconnect with the same browser ID, and prove STATUS/CHUNK polling resumes the same persisted `snapshot_id` rather than promoting partial data or immediately replacing the job.

Concurrency tests must prove one compatible job per endpoint, narrower callers join a wider job, and a new wider request supersedes a narrower job without allowing the old job to promote after the higher sequence was allocated.

- [ ] **Step 2: Run manager tests red**

```bash
cd umbra-server && go test ./internal/browsersnapshot -run 'TestStage|TestManager' -count=1 -v
```

Expected: FAIL with missing stage/manager APIs.

- [ ] **Step 3: Implement bounded temporary-file staging**

Create one private `0700` staging root and `0600` files. Append only the expected next chunk after checking decoded byte length and chunk SHA. At completion, read each file with an explicit 32 MiB limit, compare exact category digest/count/JSON array schema, verify the JCS manifest, then pass exact `[]byte` values to `Store.Promote`. Always release the Sensor job and remove temp files in success/failure defers.

- [ ] **Step 4: Implement Manager job lifecycle and fallback**

Give `Manager` a root context/cancel pair and a worker `WaitGroup`. `NewManager(parent, ...)` derives the root from the supplied process/test parent; starting a job derives its five-minute deadline from `m.rootCtx`, never from the HTTP request context. `Close` cancels the root, waits for workers, releases Sensor jobs, and cleans staging files. Expose:

```go
func (m *Manager) Start(ctx context.Context, bot models.Bot, req StartRequest) (Status, error)
func (m *Manager) Status(ctx context.Context, botID, jobID uuid.UUID) (Status, error)
func (m *Manager) ReadChunk(ctx context.Context, botID uuid.UUID, snapshotID string, category Category, index int) (Chunk, error)
func (m *Manager) Close() error
```

The caller context bounds only synchronous credential/DB/start-response work. `Start(prefer_live=false)` resolves trusted cache immediately. Online live work is registered under the Manager root before `Start` returns pending. Offline uses one trusted row or an ephemeral, 10-minute legacy resolution. After a BEGIN has succeeded, transient session loss/`rpc aborted` retries the same STATUS/CHUNK request against a re-registered session within the five-minute logical deadline, allowing the Sensor's persisted job to resume. Any terminal live failure leaves trusted rows untouched and returns the newest qualifying cached row as `cached_fallback` with a stable reason code.

- [ ] **Step 5: Run manager and race suites green**

```bash
cd umbra-server
go test ./internal/browsersnapshot -count=1 -v
go test -race ./internal/browsersnapshot -run 'TestManager_Concurrent|TestStore_Concurrent' -count=1
```

Expected: PASS and no races/leaked staging files.

- [ ] **Step 6: Commit the coordinator checkpoint**

```bash
git add umbra-server/internal/browsersnapshot
git commit -m "feat: coordinate live and cached browser snapshots"
```

---

### Task 7: Expose credential-scoped start/status/chunk HTTP APIs

**Files:**
- Create: `umbra-server/internal/api/bot_credentials.go`
- Create: `umbra-server/internal/api/browser_snapshot.go`
- Create: `umbra-server/internal/api/browser_snapshot_test.go`
- Modify: `umbra-server/internal/api/proxy_creds.go:60-94`
- Modify: `umbra-server/internal/api/server.go:16-58`
- Modify: `umbra-server/internal/auth/middleware.go:68-84`
- Modify: `umbra-server/internal/auth/middleware_test.go`

- [ ] **Step 1: Write failing handler and CORS tests**

Test valid/invalid credentials, invalid ranges, pending start, immediate cached ready, offline legacy ready, manifest-only status (no category arrays/base64), status ownership, chunk ownership, category/index validation, exact raw bytes, body `<=524288`, immutable repeated reads, and cross-bot denial. Include one handler test backed by a real Manager plus fake Sensor: cancel/finish the initiating `httptest` request immediately after its pending response, then poll from a new request and prove the same job reaches ready. Assert the response exposes only these metadata headers:

```text
X-Snapshot-Id, X-Snapshot-Category, X-Chunk-Index, X-Chunk-Offset,
X-Chunk-Count, X-Chunk-Length, X-Chunk-SHA256, X-Category-SHA256,
X-Manifest-SHA256
```

Also assert JSON/raw errors never echo username, password, or a sentinel cookie value.

- [ ] **Step 2: Run API tests red**

```bash
cd umbra-server && go test ./internal/api ./internal/auth -run 'TestBrowserSnapshot|TestCORS_ExposeSnapshotHeaders' -count=1 -v
```

Expected: FAIL because routes/handlers are absent.

- [ ] **Step 3: Implement shared credential lookup and API service interface**

Move the parameterized `proxy_username`/`proxy_password` query into an unexported helper used by both APIs. Define a narrow snapshot service interface in the handler so tests inject a fake without starting WebSockets.

- [ ] **Step 4: Implement start/status/raw chunk responses**

Use existing `JSONOK` for start/status. Status must contain only the parsed capture-manifest members plus API provenance (`status`, `source`, fallback code, job ID); never include category arrays. For trusted responses, build digest fields from the stored exact manifest bytes. For `legacy_cached`, omit a trusted capture time/manifest digest and mark every descriptor legacy.

The chunk handler authenticates before lookup, sets headers only after all validation, writes `application/octet-stream`, and does not pass through `JSONOK`.

- [ ] **Step 5: Register routes and exposed headers**

Add all three POST routes to the existing public, security-header group. Update CORS `Access-Control-Expose-Headers` with the fixed list only. Do not expose credentials or database IDs not already in the response contract.

- [ ] **Step 6: Run focused and full API suites green**

```bash
cd umbra-server
go test ./internal/api ./internal/auth -count=1 -v
```

Expected: PASS; the pre-existing `TestProxyCreds_BotOffline` still passes unchanged.

- [ ] **Step 7: Commit the HTTP API checkpoint**

```bash
git add umbra-server/internal/api umbra-server/internal/auth
git commit -m "feat: serve authenticated browser snapshot chunks"
```

---

### Task 8: Wire Sensor capabilities and daily trusted-cache warming

**Files:**
- Modify: `umbra-server/internal/ws/protocol.go:60-70`
- Modify: `umbra-server/internal/ws/handlers.go:390-474`
- Modify: `umbra-server/internal/ws/server.go:21-70`
- Modify: `umbra-server/internal/ws/server_test.go`
- Modify: `umbra-server/internal/browsersnapshot/manager.go`
- Modify: `umbra-server/internal/browsersnapshot/manager_test.go`
- Modify: `umbra-server/internal/browsersnapshot/store.go`
- Modify: `umbra-server/internal/browsersnapshot/store_test.go`
- Modify: `umbra-server/cmd/umbra-server/main.go:35-130`
- Modify: `umbra-server/internal/version/version.go`
- Modify: `umbra-server/internal/version/version_test.go`

- [ ] **Step 1: Write failing AUTH hook and warming tests**

Extend WebSocket handshake fixtures to include snapshot capabilities. Assert the connected hook fires only after registry registration, never blocks the read loop, and receives bot/capability data. Manager tests must prove: unsupported Sensors are ignored; no-full-snapshot triggers one low-priority `all` capture; reconnects within 24 hours do not retry; stale full data permits one refresh; attempt watermark is written before RPC so failures are rate-limited; and explicit user live jobs outrank background work.

- [ ] **Step 2: Run focused tests red**

```bash
cd umbra-server && go test ./internal/ws ./internal/browsersnapshot -run 'Test.*Capability|Test.*Warm' -count=1 -v
```

Expected: FAIL because AUTH capabilities/hooks and the warm-capture scheduler are not wired.

- [ ] **Step 3: Implement an atomic daily warm-capture claim**

Add `Store.ClaimFullRefresh(botID, now, interval) (bool, error)`. In one transaction, lock/read-or-create the bot watermark row and read the newest full trusted snapshot receive time. Return false when the newest of `last_full_attempt_at`, `last_full_success_at`, or that full-row receive time is less than 24 hours old; otherwise write `last_full_attempt_at=now` before returning true. This handles pre-existing trusted rows and rate-limits failed attempts across reconnects/server restarts. Promotion continues to set `last_full_success_at` only after a full snapshot commits.

- [ ] **Step 4: Implement low-priority Manager warming**

Add `Manager.OnSensorConnected(bot, caps)`. Ignore unsupported schema/capabilities, call the atomic claim, and enqueue an `all` capture under the Manager-owned root context without blocking the WS hook. Use the existing per-endpoint coordinator: an explicit live request joins/takes ownership of a compatible warm `all` job, and an existing explicit job prevents a second warm job. Warm failures are logged by endpoint/job ID and stable code only; they do not delete cache or expose payloads.

- [ ] **Step 5: Add capability parsing and a non-blocking connection hook**

Add `Capabilities SensorCapabilities` to `AuthData`, return it from handshake processing, store it on `Session` or pass it directly to a hook, and call the hook in a goroutine only after `registry.Register`. Keep legacy AUTH payloads valid.

- [ ] **Step 6: Wire Manager into main with deterministic cleanup**

After creating `ws`, construct the snapshot manager with DB/logger and injected `ws.CallBot`/`ws.IsBotOnline` functions. Set the WS connected hook, assign the manager to `api.Deps`, and `defer manager.Close()`. In smoke mode, inject a nil/unavailable snapshot service so the new routes return 503 rather than panic.

- [ ] **Step 7: Bump server development version and run suites**

Set server version to `0.2.0-dev` and run:

```bash
cd umbra-server
go test ./internal/ws ./internal/browsersnapshot ./internal/version ./cmd/umbra-server -count=1
go test ./... -count=1
```

Expected: PASS.

- [ ] **Step 8: Commit the wiring checkpoint**

```bash
git add umbra-server/internal/ws umbra-server/internal/browsersnapshot umbra-server/internal/version umbra-server/cmd/umbra-server/main.go
git commit -m "feat: warm trusted snapshots from capable sensors"
```

---

### Task 9: Build ShadowLink IndexedDB and resumable snapshot download client

**Files:**
- Create: `cookie-sync-extension/src/lib/constants.js`
- Create: `cookie-sync-extension/src/bg/idb.js`
- Create: `cookie-sync-extension/src/bg/snapshot-client.js`
- Create: `cookie-sync-extension/test/idb.test.js`
- Create: `cookie-sync-extension/test/snapshot-client.test.js`

- [ ] **Step 1: Write failing IDB and fetch tests**

Use an injected in-memory DB fake and fetch fake. Test creation/upgrade of exactly these stores: `jobs`, `backup_chunks`, `backup_manifests`, `history_archives`, `download_archives`, and `snapshot_cache`. Test atomic active/previous pointers, compound chunk keys, leases, and transaction abort preservation.

Client tests must cover pending polling, immediate cached/legacy ready, `cached_fallback`, bounded chunk order, per-chunk header/digest validation, exact total length/category SHA, manifest JCS SHA, checkpoint after each chunk, restart resuming from the first missing chunk, repeated immutable reads, schema/limit rejection before parsing, legacy Sync-only metadata, and sanitized failures.

- [ ] **Step 2: Run tests red**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='IndexedDB|snapshot client'
```

Expected: FAIL because modules are absent.

- [ ] **Step 3: Implement promisified IndexedDB primitives**

All transactions return Promises that reject on `request.onerror`, `transaction.onerror`, or `transaction.onabort`. Never treat quota errors as empty data. Store verified raw chunks as `ArrayBuffer` and keep a renewable download lease plus next-index cursor. Make cleanup refuse to delete chunks referenced by a running/mutating job or active backup.

- [ ] **Step 4: Implement the injected snapshot client**

Expose:

```js
async function resolveSnapshot(request, deps)
async function resumeSnapshotDownload(jobId, readyStatus, deps)
```

The client posts bot credentials but never logs/persists them outside the owning durable job record. It selects capture-manifest fields explicitly before JCS verification, handles trusted and legacy sources distinctly, verifies every chunk before committing it, concatenates only after all chunks verify, and parses arrays only after exact byte and category digest validation.

- [ ] **Step 5: Run focused tests green**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='IndexedDB|snapshot client'
```

Expected: PASS.

- [ ] **Step 6: Commit the download checkpoint**

```bash
git add cookie-sync-extension/src/lib/constants.js cookie-sync-extension/src/bg/idb.js cookie-sync-extension/src/bg/snapshot-client.js cookie-sync-extension/test
git commit -m "feat: resume verified ShadowLink snapshot downloads"
```

---

### Task 10: Implement pure identity, representability, merge, and replace planners

**Files:**
- Create: `cookie-sync-extension/src/lib/identity.js`
- Create: `cookie-sync-extension/src/lib/planners.js`
- Create: `cookie-sync-extension/test/identity.test.js`
- Create: `cookie-sync-extension/test/planners.test.js`

- [ ] **Step 1: Write failing pure planning tests for all five categories**

Required assertions:

- cookie identity includes mapped regular `storeId`, partition key, domain, path, and name;
- host-only cookies omit `domain` on write, session cookies omit `expirationDate`, partition keys are preserved, and supported SameSite values are not weakened;
- Sync overwrites source-equivalent cookies but retains destination-only cookies;
- history archives key by URL and source metadata wins, while native Sync adds only missing supported URLs;
- 7/30/90-day history filtering uses one persisted request boundary and includes only items whose `lastVisitTime` is on/after it, while `all` preserves every validated item;
- bookmarks map special roots, recursively merge without duplicate matching URLs, source title wins, Clone clears only children of writable roots, and source IDs are never reused;
- downloads key by normalized URL/start time/filename and never produce a download API action;
- Sync tabs dedupe normalized URLs and never close/reorder/pin/activate existing tabs;
- Clone tabs preserve source order/pinned/active in the current window and classify restricted/internal/invalid URLs before mutation; and
- missing/legacy/truncated/oversized/digest-invalid categories block Clone, while accepted unsupported items produce only `COMPLETE_WITH_ACCEPTED_OMISSIONS`.

- [ ] **Step 2: Run planners red**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='identity|planner|preflight'
```

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement deterministic pure functions**

All planner output must be plain serializable intents with stable identity keys and no Chrome calls. Define `filterHistoryForRange(items, range, requestedAt)` and persist `requestedAt` in the owning Sync job so retries use the identical boundary. Define one `preflightSnapshot(mode, snapshot, destinationCapabilities)` that returns `{blocked, unsupported, plans}`. Clone's primary path is blocked when `unsupported.length > 0`; only an explicit accepted-omissions flag can filter those intents.

- [ ] **Step 4: Run planner suite green**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='identity|planner|preflight'
```

Expected: PASS.

- [ ] **Step 5: Commit the planner checkpoint**

```bash
git add cookie-sync-extension/src/lib/identity.js cookie-sync-extension/src/lib/planners.js cookie-sync-extension/test
git commit -m "feat: plan safe browser sync and clone mutations"
```

---

### Task 11: Add strict Chrome API adapters and non-destructive Sync

**Files:**
- Create: `cookie-sync-extension/src/bg/chrome-adapters.js`
- Create: `cookie-sync-extension/src/bg/sync-job.js`
- Create: `cookie-sync-extension/test/chrome-adapters.test.js`
- Create: `cookie-sync-extension/test/sync-job.test.js`

- [ ] **Step 1: Write failing adapter and Sync effect tests**

Mock callback and Promise variants of Chrome APIs. Every callback test must set/clear `chrome.runtime.lastError` and prove rejection, never silent success. Test current regular cookie-store selection, complete cookie/history/bookmark/tab enumeration, cookie set/remove/readback, history add, bookmark create/update, tab create, and no native download-history call.

Sync tests cover cookies-default options, 7/30/90/all request mapping, `prefer_live:true`, per-category source-wins merge, destination-only retention, successful categories surviving another category's failure, progress/result counts, live/cached/fallback/legacy labels, and no operation that clears a category. Configure the fake server as online with an existing trusted cache and prove Sync still starts/uses one new live job. Return a compatible wider cached history snapshot (`all` for a 7-day request and `90` for a 30-day request) and prove only items on/after the persisted requested-range boundary enter native history or the ShadowLink history archive.

- [ ] **Step 2: Run adapter/Sync tests red**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='Chrome adapter|Sync job'
```

Expected: FAIL because adapters/job are absent.

- [ ] **Step 3: Implement strict Promise adapters**

Wrap each Chrome call in a fresh Promise, inspect `chrome.runtime.lastError` inside its callback, normalize no result only when the API documents it, and return explicit identities for verification. For full local history enumeration, reuse the tested adaptive window approach rather than one assumed-unbounded `maxResults` call.

- [ ] **Step 4: Implement category-isolated Sync**

Sync persists `requested_at` once, always calls the start API with `prefer_live:true`, and lets the server decide live versus visible offline/fallback cache. It gets one resolved logical snapshot, validates only selected categories, filters a compatible wider history category down to the requested 7/30/90-day boundary (`all` is unfiltered), applies categories in `cookies, history, bookmarks, downloads, tabs` order, catches/reports errors per category, and never rolls back another successful Sync category. Both native history and its metadata archive receive the same filtered item set. Download/history archive upserts use atomic IDB active-manifest transactions. Tabs only open missing supported URLs.

- [ ] **Step 5: Run focused tests green**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='Chrome adapter|Sync job'
```

Expected: PASS; assertions show zero destructive clear/remove plans in Sync except source-equivalent cookie overwrite implemented as `cookies.set`.

- [ ] **Step 6: Commit the Sync checkpoint**

```bash
git add cookie-sync-extension/src/bg/chrome-adapters.js cookie-sync-extension/src/bg/sync-job.js cookie-sync-extension/test
git commit -m "feat: merge selected browser data with ShadowLink Sync"
```

---

### Task 12: Create complete staged destination backups with freshness binding

**Files:**
- Create: `cookie-sync-extension/src/bg/backup.js`
- Create: `cookie-sync-extension/test/backup.test.js`

- [ ] **Step 1: Write failing backup completeness tests**

Cover all regular-store cookies with partition/store mapping, all native history URLs with non-truncated coverage, all bookmark writable roots, all current-window tabs including URL/order/pinned/active, and both active archives. Test authoritative empty categories, unavailable/incomplete enumeration, restricted missing tab URL, item/byte limits, quota/write failure, staged read-back mismatch, manifest mismatch, previous-active preservation, cancellation deleting only staged data, and exact raw-byte digest verification.

Freshness tests must mutate one identity/count/byte/digest after confirmation and assert: no promotion, no destination mutation, staged backup invalidated, a new backup required, and renewed confirmation required.

- [ ] **Step 2: Run backup tests red**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='backup|freshness'
```

Expected: FAIL with missing backup engine.

- [ ] **Step 3: Implement stage, verify, re-enumerate, and promote**

Serialize each backup category once to UTF-8 bytes and chunk it. Backup manifest categories are `cookies`, `native_history`, `bookmarks`, `tabs`, `history_archive`, and `download_archive`; manifest hashing uses the same omit-digest JCS rule. Read every staged chunk back, recompute counts/lengths/digests, and compare before returning `AWAITING_*_CONFIRMATION`.

After confirmation, immediately re-enumerate and compare all identities/counts/bytes/digests. On equality, promote staged to active and prior active to previous in one IDB transaction immediately before the first mutation.

- [ ] **Step 4: Run backup tests green**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='backup|freshness'
```

Expected: PASS; fake mutation call count remains zero for every failure before promotion.

- [ ] **Step 5: Commit the backup checkpoint**

```bash
git add cookie-sync-extension/src/bg/backup.js cookie-sync-extension/test/backup.test.js
git commit -m "feat: verify and freshness-bind ShadowLink backups"
```

---

### Task 13: Implement durable Clone, verification, rollback, and worker recovery

**Files:**
- Create: `cookie-sync-extension/src/bg/clone-job.js`
- Create: `cookie-sync-extension/src/bg/job-runner.js`
- Create: `cookie-sync-extension/test/clone-job.test.js`
- Create: `cookie-sync-extension/test/job-recovery.test.js`
- Modify: `cookie-sync-extension/src/bg/sw.js`

- [ ] **Step 1: Write failing Clone state-machine tests**

Assert the exact state sequence from design §9. Test normal Clone, accepted omissions, each missing/legacy/truncated/oversized/digest-invalid block, confirmation bound to backup ID/digest, freshness failure, and the mutation order cookies → history → bookmarks → download archive → tabs.

Inject one supported remove/write/readback failure at every phase and assert `rollback_required` is durably written before rollback, rollback uses the active pre-Clone backup, and final status is `ROLLED_BACK` or `ROLLBACK_INCOMPLETE`, never success. Verify native history by URL set/archive digest, bookmarks by logical tree without generated IDs, cookies by canonical identity/value, archive pointer/digest, and tabs by normalized order/pinned/active.

- [ ] **Step 2: Write failing lease/termination recovery tests**

Terminate the fake worker after every journal intent and API resolution. Recreate `JobRunner` over the same DB and assert it takes only expired leases, rechecks uncertain operations, restarts history/bookmark replacement deterministically, reconciles created/old tab IDs, and resumes or rolls back. A stale `RUNNING` job may never be simply unlocked. Popup query messages must read the durable state.

- [ ] **Step 3: Run Clone/recovery tests red**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='Clone|rollback|lease|recovery'
```

Expected: FAIL with missing job modules.

- [ ] **Step 4: Implement Clone intents and idempotent phase rules**

Write the next intent and cursor transactionally before each Chrome/IDB mutation, then write its observed result. Cookies recheck canonical identities; history replacement reruns `deleteAll` and adds from index zero after interruption; bookmarks reclear writable-root children and rebuild deterministically; archive replacement swaps one pointer; tabs use a safe temporary tab and a journaled reconciliation set, and run last.

- [ ] **Step 5: Implement the single-writer runner and wake paths**

Only one mutating job may own the renewable lease. Initialize recovery at service-worker evaluation, `runtime.onStartup`, `runtime.onInstalled`, every popup job message, and a one-minute `chrome.alarms` heartbeat while a job is active. A Clone always requests `history_range: "all"` and `prefer_live: true`; only the server may turn that into a visible trusted-cache/fallback result. Scrub persisted endpoint credentials when a job reaches a terminal state while retaining its non-secret result/progress summary. Preserve existing proxy credential cache, auth interceptor, storage listener, and badge code in `sw.js`; initialize the runner alongside them rather than replacing them.

- [ ] **Step 6: Run Clone/recovery and proxy regression tests green**

```bash
cd cookie-sync-extension && npm test
```

Expected: PASS, including a regression test that proxy badge/auth listeners are registered once.

- [ ] **Step 7: Commit the Clone checkpoint**

```bash
git add cookie-sync-extension/src/bg/clone-job.js cookie-sync-extension/src/bg/job-runner.js cookie-sync-extension/src/bg/sw.js cookie-sync-extension/test
git commit -m "feat: clone browser state with verified rollback"
```

---

### Task 14: Implement Restore with a distinct recovery backup and Undo Restore

**Files:**
- Create: `cookie-sync-extension/src/bg/restore-job.js`
- Create: `cookie-sync-extension/test/restore-job.test.js`
- Modify: `cookie-sync-extension/src/bg/job-runner.js`

- [ ] **Step 1: Write failing Restore role-separation tests**

Test that `restore_source_backup_id` remains immutable and distinct from newly created `restore_recovery_backup_id`; the recovery backup receives full stage/read-back/freshness gates; confirmation is bound to both IDs/digests; a Restore failure rolls back from the recovery backup, never the Restore source; both backups survive `ROLLBACK_INCOMPLETE`; successful Restore retains the recovery backup as Undo Restore; and explicit deletion refuses any backup referenced by a live/recovery job.

- [ ] **Step 2: Run Restore tests red**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='Restore|Undo Restore'
```

Expected: FAIL because Restore is absent.

- [ ] **Step 3: Implement Restore as a separate durable state machine**

Reuse validators, planners, backup verification, mutation adapters, journal primitives, and destination verification; do not alias IDs or overwrite manifests. Use the exact Restore phases from design §9. Restore applies backup categories under the same representability and accepted-omissions rules as Clone.

- [ ] **Step 4: Run Restore and full background suites green**

```bash
cd cookie-sync-extension
npm test -- --test-name-pattern='Restore|Undo Restore'
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit the Restore checkpoint**

```bash
git add cookie-sync-extension/src/bg/restore-job.js cookie-sync-extension/src/bg/job-runner.js cookie-sync-extension/test/restore-job.test.js
git commit -m "feat: restore ShadowLink backups with undo recovery"
```

---

### Task 15: Add Sync/Clone/Restore popup UX and local archive tools

**Files:**
- Create: `cookie-sync-extension/src/browser_action/job-client.js`
- Create: `cookie-sync-extension/src/browser_action/dialogs.js`
- Create: `cookie-sync-extension/src/browser_action/archive-view.js`
- Create: `cookie-sync-extension/test/popup-model.test.js`
- Modify: `cookie-sync-extension/src/browser_action/main.js:1-603`
- Modify: `cookie-sync-extension/src/browser_action/browser_action.html:39-151`
- Modify: `cookie-sync-extension/src/browser_action/popup-styles.css`

- [ ] **Step 1: Write failing pure popup-model tests**

Test that Sync opens with cookies checked and other categories unchecked, history defaults to 30 days and offers 7/30/90/all, Clone categories cannot be unchecked, provenance/capture/count/availability labels render, legacy warnings render, unsupported normal Clone is disabled, accepted-omissions wording is explicit, destructive confirmation carries staged backup ID/digest, popup reopen shows durable state, and result text uses applied/skipped/failed counts without secrets.

- [ ] **Step 2: Run popup-model tests red**

```bash
cd cookie-sync-extension && npm test -- --test-name-pattern='popup|dialog|archive view'
```

Expected: FAIL because UI modules are absent.

- [ ] **Step 3: Add modal/view markup and message-only popup modules**

Add endpoint row actions `Sync`, `Clone`, and existing `Proxy`. Popup modules may send `START_SYNC`, `START_CLONE_PREFLIGHT`, `CONFIRM_CLONE`, `START_RESTORE_PREFLIGHT`, `CONFIRM_RESTORE`, `GET_JOB`, `LIST_BACKUPS`, `DELETE_BACKUP`, `LIST_HISTORY_ARCHIVE`, and `LIST_DOWNLOAD_ARCHIVE`; they must not call mutation Chrome APIs directly.

The Tools view gains Restore previous state, Undo Restore when present, backup timestamp/counts, Delete backup, searchable/paginated history/download archives, and JSON export. Export through a Blob/download link only; never call `chrome.downloads.download`.

- [ ] **Step 4: Replace the old one-click destructive cookie import path for bot Sync**

Remove the bot-row call to `/api/v1/get-bot-browser-cookies` and `importCookies` from the bot Sync branch. Keep Manual Cookie Import clearly labeled as a separate local destructive tool, with its existing clear-first warning. New Sync/Clone always delegates to the background runner.

- [ ] **Step 5: Run UI model and full ShadowLink tests green**

```bash
cd cookie-sync-extension && npm test
```

Expected: PASS. Grep must show no new bot Sync call to the legacy cookie endpoint:

```bash
! rg -n 'get-bot-browser-cookies' src/browser_action src/bg
```

- [ ] **Step 6: Perform unpacked-extension UI smoke checks**

Load `cookie-sync-extension` unpacked in Chrome 119+ and verify: login, remembered login, bot search, Proxy on/off and badge, Sync dialog defaults, Clone preflight, popup close/reopen progress, Tools archive browsing/export, backup deletion guard, and no popup console errors. Do not confirm a destructive Clone against a non-test browser profile.

- [ ] **Step 7: Commit the popup checkpoint**

```bash
git add cookie-sync-extension/src/browser_action cookie-sync-extension/test/popup-model.test.js
git commit -m "feat: add ShadowLink Sync Clone and Restore controls"
```

---

### Task 16: Finalize permissions, packaging, integration tests, CI, and operations docs

**Files:**
- Modify: `cookie-sync-extension/manifest.json`
- Modify: `.github/workflows/Build&Push.yml`
- Modify: `umbra-server/internal/api/extension.go:268-367`
- Modify: `umbra-server/internal/api/extension_test.go`
- Create: `umbra-server/test/integration/browser_snapshot_flow_test.go`
- Create: `docs/shadowlink-sync-clone-operations.md`
- Modify: `docs/deployment.md`
- Modify: `docs/superpowers/specs/2026-08-24-shadowlink-sync-clone-design.md` (editorial duplicate cleanup only; no contract changes)

- [ ] **Step 1: Write failing manifest/package and end-to-end integration tests**

Package tests assert ShadowLink version `3.0.0`, minimum Chrome `119`, required `history/bookmarks/tabs/alarms/unlimitedStorage`, absence of `downloads`, inclusion of all background/browser modules, and no test/package files in the extension ZIP. Sensor package tests assert version `0.2.0`, capability helper inclusion, classic worker compatibility, and `unlimitedStorage`.

The Go integration test should drive a fake enrolled Sensor through WebSocket AUTH and all four RPCs, then verify live ready/chunks, disconnect and offline cached reuse, reconnect with injected timeout and unchanged cached fallback, invalid/cross-endpoint credentials denied, legacy Sync-only result, and no trusted row after injected digest failure.

- [ ] **Step 2: Run new integration/package tests red**

```bash
cd umbra-server && go test ./internal/api ./test/integration -run 'Test.*BrowserSnapshot|Test.*ShadowLinkPackage' -count=1 -v
```

Expected: FAIL until manifests/package filters/wiring are complete.

- [ ] **Step 3: Finalize ShadowLink manifest and package filters**

Set the version/minimum/permissions exactly as above. Update standalone packaging to exclude `test/`, `package.json`, and `package-lock.json` from shipped extensions while retaining all `src/` helpers. Confirm obfuscation recognizes ESM modules and never rewrites JSON fixtures into the extension.

- [ ] **Step 4: Repair the CI build context and add extension gates**

Run extension tests after Node setup and before any packaging:

```yaml
- name: Test browser extensions
  run: |
    npm test --prefix extension
    npm test --prefix cookie-sync-extension
```

Keep Go `go test ./...`; ensure the integration test uses SQLite/fakes and requires no external Postgres/Chrome/network.

Replace the current directory-colliding Go output and stale GUI/context copies with this root-relative sequence (the checkout is clean on every CI run):

```yaml
- name: Prepare Docker context
  run: |
    mkdir -p docker-ctx/extensions docker-ctx/tools
    (cd umbra-server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
      -trimpath -ldflags="-s -w" \
      -o ../docker-ctx/umbra-server ./cmd/umbra-server)
    cp -R gui-next/dist docker-ctx/gui-dist
    cp -R extension docker-ctx/extensions/main
    cp -R cookie-sync-extension docker-ctx/extensions/cookie-sync
    [ -d embed-targets ] && for d in embed-targets/*/; do
      [ -f "$d/manifest.json" ] && cp -R "$d" "docker-ctx/extensions/$(basename "$d")"
    done
    cp umbra-server/tools/obfuscate.bundle.mjs docker-ctx/tools/obfuscate.bundle.mjs
    cp Dockerfile docker-ctx/Dockerfile
    test -f docker-ctx/umbra-server
    test -f docker-ctx/gui-dist/index.html
    test -f docker-ctx/tools/obfuscate.bundle.mjs
```

Remove the old `-o ../umbra-server`, `cp umbra-server docker-ctx/`, and `cp -r gui/dist ...` lines. This leaves the Dockerfile's expected `umbra-server`, `gui-dist`, `extensions`, and `tools/obfuscate.bundle.mjs` paths present in `docker-ctx`.

- [ ] **Step 5: Write rollout and recovery documentation**

Document this order: deploy server migration/API first → deploy Sensor `0.2.0` → wait for/verify trusted full cache → deploy ShadowLink `3.0.0`. Include trusted/legacy status interpretation, limits, Chrome platform limitations, backup/Restore/Undo Restore, `ROLLBACK_INCOMPLETE` handling, sanitized diagnostic fields, and how to stop before destructive confirmation. Explain that rolling back the server binary must not drop the new immutable tables.

Clean only the obvious duplicated heading/bullet/sentence in the approved spec; do not alter behaviour without returning to brainstorming/user approval.

- [ ] **Step 6: Run every automated verification command fresh**

```bash
cd extension && npm test
cd ../cookie-sync-extension && npm test
cd ../umbra-server && gofmt -w $(find internal cmd test -type f -name '*.go')
go vet ./...
go test ./... -count=1
go test -race ./internal/browsersnapshot ./internal/api ./internal/ws -count=1
go build ./...
```

Expected: all commands exit 0; no skipped required test, race, vet error, or build error.

- [ ] **Step 7: Run authorized end-to-end Chrome acceptance**

Using test browser profiles only, execute all 18 cases in design §12.4. Capture for each case: source label, snapshot ID (not payload), capture time, per-category counts, final job state, rollback state if any, and proof no cookie values/credentials appear in server/Sensor/ShadowLink logs. Force worker termination and injected failures at every destructive phase before marking recovery accepted.

- [ ] **Step 8: Inspect final scope and commit**

```bash
git status --short
git diff --check
git diff --stat
git add .github/workflows/Build\&Push.yml THIRD_PARTY_NOTICES.md testdata extension cookie-sync-extension umbra-server docs
git commit -m "feat: ship offline-capable ShadowLink Sync and Clone"
```

Expected: only planned files are present, `git diff --check` is clean, and the commit succeeds in a real Git worktree.

## Final acceptance boundary

Do not report this feature complete merely because unit tests pass. Completion requires all of the following evidence from the same build:

1. trusted immutable full snapshot created by Sensor `0.2.0` and persisted by server `0.2.0-dev`;
2. online live Sync and offline trusted-cache Sync both verified;
3. offline Clone blocked for legacy/missing/truncated data and succeeds only for full trusted data;
4. Clone and Restore pre-mutation backup read-back plus post-confirmation freshness recheck verified;
5. forced interruption and injected supported-item failures recover or produce an honest `ROLLBACK_INCOMPLETE`;
6. ShadowLink `3.0.0` popup survives close/reopen without losing the job;
7. Proxy action/badge/auth behaviour remains working; and
8. automated secret-sentinel tests and manual log inspection find no cookie values or credentials.
