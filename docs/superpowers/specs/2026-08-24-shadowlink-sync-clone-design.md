# ShadowLink Sync and Clone Design

**Date:** 2026-08-24  
**Status:** User-approved design  
**Components:** Umbra Sensor, Go API/WebSocket server, ShadowLink Chrome extension  
**Scope:** Authorized enterprise browser profiles enrolled in Umbra

## 1. Problem statement

ShadowLink's current **Sync** button always calls
`POST /api/v1/get-bot-browser-cookies`. The Go server then sends a synchronous
`GET_BROWSER_COOKIE_ARRAY` RPC to the selected endpoint. When the endpoint has
no active WebSocket session, the API returns `502 bot offline` even though the
server may already have a cookie snapshot in `bots.cookies` from the endpoint's
periodic `SYNC_HUGE` messages.

This produces two incorrect product behaviours:

1. Cookie sync is unnecessarily blocked when an endpoint is offline and a
   cached snapshot exists.
2. The one-button flow cannot distinguish a safe additive merge from a
   destructive attempt to reproduce the selected browser profile.

The feature will replace that behaviour with two explicit modes:

- **Sync**: merge selected remote data into the local browser, with cookies
  selected by default and no deletion of local-only data.
- **Clone**: validate a complete remote snapshot, back up the local browser,
  then replace the supported local state with that snapshot.

Terminology in this specification is fixed as follows:

- **source endpoint**: the selected remote browser enrolled in Umbra;
- **destination browser**: the local browser running ShadowLink.

The user-approved conflict rule is **source endpoint wins**. The word
"target" is intentionally avoided below because it can ambiguously refer to
either side of the transfer.

## 2. Goals

1. Prefer a single, live snapshot when the selected endpoint is online.
2. Use the last server-persisted snapshot when it is offline or a live request
   times out.
3. Clearly identify live versus cached data and display the real capture time.
4. Let Sync users select cookies, history, bookmarks, download records, and
   open tabs; cookies are selected by default.
5. Make Clone reproduce all five supported categories as closely as Chrome's
   extension APIs permit.
6. Back up local state before any destructive work and support restoring the
   latest pre-Clone backup.
7. Never clear a local category unless the corresponding source category is
   known to be a valid snapshot, including the case where a valid snapshot is
   intentionally empty.
8. Keep sensitive values out of logs and status telemetry.

## 3. Non-goals and platform limits

1. ShadowLink will not recreate old entries inside `chrome://downloads` and
   will not redownload files. Download records are kept in a local ShadowLink
   archive that can be viewed, searched, and exported as JSON.
2. Chrome only lets extensions add a history URL at the current time. Native
   history cannot preserve the source URL-level `lastVisitTime`, `typedCount`,
   or `visitCount`. ShadowLink will preserve those `HistoryItem` fields in its
   local archive while adding the URL to native history. Individual visit
   events and transition metadata are not collected in this version.
3. Clone will recreate tabs in the current window. It will not recreate remote
   windows or tab groups in this version.
4. Incognito cookie stores and profiles other than the current regular Chrome
   profile are outside this version's scope.
5. The feature does not copy passwords, autofill data, localStorage,
   IndexedDB, service-worker caches, installed extensions, or browser settings.
6. "All history" means every unique history URL Chrome exposes through the
   History API for the requested time range. It does not mean an exact copy of
   every historical visit event.

## 4. User experience

### 4.1 Endpoint actions

Each endpoint row in ShadowLink has two actions:

- **Sync**
- **Clone**

The existing Proxy action remains independent.

### 4.2 Sync dialog

The Sync dialog contains these controls:

| Category | Default | Sync behaviour |
|---|---:|---|
| Cookies | Selected | Source value wins for an equivalent cookie; destination-only cookies remain |
| History | Not selected | Add missing URLs and merge the full source metadata into the local archive |
| Bookmarks | Not selected | Recursively merge; retain local-only nodes |
| Downloads | Not selected | Merge records into the ShadowLink local archive |
| Open tabs | Not selected | Open target URLs that are not already open |

When History is selected, its range defaults to **30 days** and offers
**7 days**, **30 days**, **90 days**, and **All available**.

Before applying anything, the dialog displays:

- endpoint name;
- `Live`, `Cached`, or `Cached fallback` source;
- capture time for each category;
- item count and availability for each category;
- a notice when cached or legacy data will be used.

Sync is non-destructive across categories. An error in one selected category
does not undo successful categories; the result lists applied, skipped, and
failed counts per category.

### 4.3 Clone dialog

Clone always includes cookies, all available history, bookmarks, download
records, and open tabs. These categories cannot be unchecked. The confirmation
view explicitly lists which local categories will be cleared or replaced.

Clone can start only when:

1. all five source categories are available;
2. every category belongs to the same immutable, versioned snapshot manifest;
3. every category has trustworthy coverage and capture metadata;
4. the snapshot payload passes structural and representability validation;
5. the complete local pre-Clone backup was written, digested, and read back
   successfully; and
6. the user completes a destructive-action confirmation.

If a source category was validly captured as an empty array, it is available
and Clone may clear the local equivalent. If a category was never captured,
it is unavailable and Clone is blocked before local data is touched.

Items that Chrome cannot represent are listed during preflight. The primary
Clone action remains blocked while such items exist. A separate
**Clone supported items only** action may be offered behind an additional
explicit confirmation; its final state is
`COMPLETE_WITH_ACCEPTED_OMISSIONS`, never `COMPLETE`. Any failure to remove or
write an item that passed preflight is critical and triggers rollback.

### 4.4 Restore previous state

ShadowLink's Tools view gains:

- **Restore previous state**;
- backup creation time and category counts;
- **Delete backup**;
- history and download archive viewers;
- JSON export for history and download records.

Restore is also destructive and requires confirmation. The retained backup is
not deleted until restore has completed successfully or the user explicitly
deletes it.

Restore runs the same representability preflight as Clone. It cannot mutate
the browser if the backup is incomplete, truncated, fails digest verification,
or contains newly unsupported items unless the user explicitly accepts those
omissions.

### 4.5 Progress and results

Long-running operations execute in the ShadowLink background service worker,
not in the popup page. Job state is checkpointed locally, so closing and
reopening the popup shows the current or final state rather than cancelling
the task.

Example result:

```text
Source: Cached snapshot
Captured: 2026-08-24 14:32
Cookies: 128/130 applied, 2 failed
History: 295 merged, 5 skipped
Bookmarks: 42 merged
Downloads: 15 archived
Tabs: 7 opened
```

## 5. Snapshot architecture

### 5.1 HTTP job API

A full history snapshot can exceed the existing 30-second RPC window and must
not be forced into one WebSocket frame. The public API therefore exposes one
**logical snapshot job**, rather than one blocking frame.

Start or resolve a snapshot:

```text
POST /api/v1/get-bot-browser-snapshot
```

The endpoint follows the existing bot-scoped credential pattern used by
`get-bot-browser-cookies`:

```json
{
  "username": "endpoint-proxy-user",
  "password": "endpoint-proxy-password",
  "history_range": "all",
  "prefer_live": true
}
```

If no live WebSocket session exists, the call immediately returns the current
trusted cached snapshot, or explicitly marked legacy fields when no trusted
snapshot exists. If the endpoint is online and a refresh is needed, it returns:

```json
{
  "success": true,
  "result": {
    "status": "pending",
    "job_id": "0d791dc7-...",
    "poll_after_ms": 1000
  }
}
```

ShadowLink polls:

```text
POST /api/v1/get-bot-browser-snapshot-status
```

with the same bot credentials and `job_id`. A ready response is manifest-only;
it never embeds the category arrays. It uses the existing `JSONOK` envelope:

```json
{
  "status": "ready",
  "schema_version": 1,
  "snapshot_id": "a32d0c55-...",
  "source": "live",
  "capture_started_at": "2026-08-24T06:31:52.000Z",
  "capture_completed_at": "2026-08-24T06:32:00.000Z",
  "fallback_reason": "",
  "fields": {
    "cookies": {
      "available": true,
      "legacy": false,
      "count": 128,
      "byte_length": 48291,
      "sha256": "...",
      "chunk_count": 1
    },
    "history": {
      "available": true,
      "legacy": false,
      "coverage": "all",
      "truncated": false,
      "count": 300,
      "byte_length": 91820,
      "sha256": "...",
      "chunk_count": 1
    },
    "bookmarks": {
      "available": true,
      "legacy": false,
      "count": 42,
      "byte_length": 12004,
      "sha256": "...",
      "chunk_count": 1
    },
    "downloads": {
      "available": true,
      "legacy": false,
      "count": 15,
      "byte_length": 7201,
      "sha256": "...",
      "chunk_count": 1
    },
    "tabs": {
      "available": true,
      "legacy": false,
      "count": 7,
      "byte_length": 3910,
      "sha256": "...",
      "chunk_count": 1
    }
  },
  "manifest_sha256": "..."
}
```

ShadowLink then retrieves bounded category chunks through:

```text
POST /api/v1/get-bot-browser-snapshot-chunk
```

The request carries the same bot credentials plus `snapshot_id`, `category`,
and zero-based `chunk_index`. The response body is raw
`application/octet-stream`; authenticated response headers identify the
snapshot/category/index, offset, total chunks, byte length, chunk SHA-256,
complete category SHA-256, and manifest SHA-256. Each response contains at
most 512 KiB before HTTP transfer encoding. A repeated request for the same
immutable tuple returns the same bytes, so interrupted downloads resume from
the last verified chunk. Cached and live snapshots use exactly the same chunk
endpoint.

`source` is one of:

- `live`: a newly completed immutable job;
- `cached`: the current trusted snapshot;
- `cached_fallback`: a live job failed or timed out and the prior trusted
  snapshot was returned;
- `legacy_cached`: only the old `bots` arrays are available. This source is
  eligible for non-destructive Sync only and may have no trustworthy capture
  time.

No response may silently combine live fields, trusted cached fields, and legacy
fields into one snapshot. A live acquisition either promotes all five fields as
one immutable snapshot or leaves the previous trusted snapshot untouched.

### 5.2 Sensor-side immutable, chunked capture

Add a versioned snapshot protocol to the Umbra Sensor:

1. `BEGIN_BROWSER_SNAPSHOT_V1`
2. `GET_BROWSER_SNAPSHOT_STATUS_V1`
3. `GET_BROWSER_SNAPSHOT_CHUNK_V1`
4. `RELEASE_BROWSER_SNAPSHOT_V1`

`BEGIN` assigns a server-generated `snapshot_id` and starts a resumable Sensor
job. The Sensor captures into its own IndexedDB staging area and freezes the
five category arrays before exposing a ready manifest. The manifest contains:

- schema and Sensor versions;
- snapshot ID;
- capture start and completion times;
- category availability;
- item counts and canonical UTF-8 byte lengths;
- per-category SHA-256 digests;
- history coverage and truncation status;
- total bytes, total chunks, and full manifest digest.

The server retrieves immutable chunks by snapshot ID, category, and zero-based
chunk index. Each chunk is at most **512 KiB before wire encoding**, so it stays
well below the current 64 MiB WebSocket frame limit. Each individual RPC has a
10-second timeout; the logical job has a default five-minute deadline and a
10-minute staging TTL. Poll/chunk traffic occurs more frequently than the MV3
worker idle window. Sensor progress is persisted, so worker suspension does not
turn an empty or partial collector result into a valid snapshot.

Chunking is end-to-end. The server retains the verified immutable category
bytes and the HTTP API serves slices of those same bytes to ShadowLink; it does
not reserialize a database object into one large response. ShadowLink writes
each verified chunk to `snapshot_cache`, renews its download lease while
active, and can resume after popup, worker, or browser interruption. A trusted
snapshot row remains available according to normal cache retention; an
unpromoted staging job expires after its 10-minute TTL. Chunk authorization
always revalidates that the supplied bot credentials own the requested
snapshot.

The digest contract is exact:

1. For each category, the Sensor serializes its array once to UTF-8 JSON bytes,
   hashes those exact bytes, chunks those exact bytes, and never serializes the
   category again.
2. The Go server parses a copy for schema/count validation but stores the exact
   original bytes in `BYTEA`; digest verification and HTTP chunk serving use
   the stored bytes, not parsed JSON.
3. ShadowLink concatenates verified HTTP chunks in index order, verifies the
   exact byte length and category digest, and only then parses the array.
4. The capture manifest contains schema/Sensor versions, snapshot ID, capture
   window, history coverage/truncation, and the five category descriptors
   (`available`, `count`, `byte_length`, `sha256`, `chunk_count`). Its
   `manifest_sha256` is SHA-256 of the RFC 8785 JSON Canonicalization Scheme
   representation of that manifest **with the `manifest_sha256` member
   omitted**. API-only fields such as job status, source, fallback reason,
   sequence, and receive time are outside the capture manifest.
5. Categories are named only by the fixed order `cookies`, `history`,
   `bookmarks`, `downloads`, `tabs`; code never relies on ordinary JSON object
   iteration order for digest construction.

The repository includes shared JS and Go golden vectors covering Unicode,
escaping, integer and fractional numbers, negative zero, empty arrays, and all
five category descriptors. A release cannot change canonical bytes without a
new `schema_version`.

Default hard limits are:

- 64 MiB canonical JSON across all five categories;
- 32 MiB for one category;
- 250,000 items for one flat category;
- five minutes for acquisition.

Limits are checked before the server promotes or ShadowLink applies data. A
limit produces `snapshot_too_large` or `snapshot_acquisition_timeout`; it never
silently truncates Clone data. Sync may retry with a narrower history range.
These limits are server constants in v1 and can become configuration only if
real deployments require it.

Every Chrome callback checks `chrome.runtime.lastError`. Collector errors are
represented as unavailable fields and can never be collapsed to a successful
empty array. A count of zero is authoritative only when the manifest says the
field is available and its digest matches canonical `[]`.

### 5.3 Trusted snapshot persistence

Add a dedicated `bot_browser_snapshots` model/table instead of treating the
mutable `bots.cookies`, `bots.history`, and related GUI arrays as a Clone-safe
snapshot. Every promoted row is immutable and contains at least:

- `bot_id`;
- monotonically allocated `snapshot_seq`;
- `snapshot_id` and `schema_version`;
- Sensor version/capabilities;
- capture start, capture completion, and server receive times;
- history coverage and truncation flag;
- five immutable JSON `BYTEA` category payloads;
- per-category counts, byte lengths, and digests;
- RFC 8785 capture-manifest bytes and `manifest_sha256`.

The server stages and verifies every chunk before opening a database
transaction. Promotion inserts one complete immutable row with a unique
server-allocated `snapshot_seq`; it never updates an older row in place. A
failed, partial, older, or digest-mismatched job produces no trusted row. Keep
the newest full, non-truncated snapshot and the newest snapshot for each
narrower history coverage (7/30/90 days); delete older rows only after the new
row commits. Cached lookup chooses the newest single row that satisfies the
requested history coverage. A narrower Sync snapshot therefore cannot replace
or downgrade the full snapshot needed by offline Clone. The old periodic
`SYNC` and `SYNC_HUGE` handlers continue to feed GUI arrays but **never promote,
update, or delete a trusted snapshot row**.

Production currently skips broad `AutoMigrate` when `users` already exists.
Therefore migration must explicitly create/index `bot_browser_snapshots` even
for existing databases, for example through a narrowly scoped
`AutoMigrate(&models.BotBrowserSnapshot{})` or equivalent checked DDL. Migration
errors are returned from startup, not ignored. Migration tests must cover a
fresh schema, a legacy existing schema, idempotence, required indexes, and an
actual insert/read/promote cycle.

Existing non-empty `bots` arrays may be exposed as `legacy_cached` for Sync.
They carry `legacy: true`; unknown empty arrays are unavailable. Legacy arrays
never authorize Clone, even if their row has a recent `updatedAt` or
`last_online` value.

### 5.4 Acquisition and fallback flow

1. Validate the bot-scoped credentials.
2. Return the newest trusted snapshot satisfying the requested coverage when
   `prefer_live` is false.
3. If a current WebSocket session exists and `prefer_live` is true, allocate a
   higher `snapshot_seq` and start one versioned Sensor job.
4. Poll the resumable Sensor job, retrieve bounded chunks, and verify all
   manifest counts, lengths, and digests.
5. Atomically promote the complete row, then return `source: live`.
6. If the endpoint is offline, return the newest qualifying trusted row as
   `source: cached`.
7. If live capture fails or times out, leave all trusted rows unchanged and
   return the newest qualifying one as `source: cached_fallback` with a stable
   reason code.
8. If no trusted row exists, return available non-empty old arrays as
   `legacy_cached` for Sync only. Do not invent capture timestamps.
9. If neither trusted nor usable legacy data exists, report fields as
   unavailable.

Only one capture job per endpoint may run at once. Concurrent callers join that
job when their history coverage requirement is compatible; otherwise the wider
request wins. A successful full-history job can satisfy narrower Sync requests.

To make future offline Clone practical, the upgraded server schedules one
low-priority full trusted capture after an upgraded Sensor first connects when
no trusted row exists. It may refresh that trusted snapshot at most once every
24 hours. This background capture uses the same limits, chunk protocol, atomic
promotion, and failure rules; failure leaves all previous data unchanged.

## 6. History acquisition

The current Sensor collects at most 10,000 unique history URLs from the last
30 days. Replace the fixed helper with a range-aware, error-aware collector:

- Sync supports 7, 30, 90, or all available days.
- Clone and every pre-Clone destination backup request all available history.
- `all` starts at Unix epoch time zero.
- Query time ranges in bounded windows.
- When a window returns the requested result ceiling, bisect that time window
  and query both halves until it is below the ceiling or reaches the minimum
  window size.
- Deduplicate results by stable URL, keeping the newest `lastVisitTime` and the
  largest observed `typedCount` and `visitCount`.
- Record exact requested start/end coverage, every completed window, the result
  ceiling, and whether any minimum window still hit the ceiling.
- Treat `chrome.runtime.lastError`, a rejected promise, an invalid item, a
  missing window, worker interruption, item/byte limits, and digest mismatch as
  acquisition failures, not valid empty history.

If even the minimum window hits the ceiling, return the acquired data with
`truncated: true`. Clone and local backup are blocked when history is truncated
or any window is incomplete. Sync can proceed only after showing the truncation
warning and obtaining explicit acceptance.

The v1 archive preserves URL-level `HistoryItem` metadata: URL, title,
`lastVisitTime`, `typedCount`, and `visitCount`. It does not claim to preserve
individual `VisitItem` records, transition types, or original native-history
insertion times.

## 7. Local validation and application rules

Before local mutation, each category is parsed against a versioned item schema
and converted into an explicit application plan. The plan classifies every
item as:

- `supported` with normalized identity and exact Chrome API parameters;
- `unsupported` with a stable reason code; or
- `invalid`, which rejects the snapshot.

For ordinary Sync, unsupported source items may be skipped and reported. For
Clone and Restore, the normal action is blocked if any item is unsupported. The
separate user-approved omission path records the exact omitted identities and
uses `COMPLETE_WITH_ACCEPTED_OMISSIONS`. Once mutation begins, every failed
removal or write for an item classified as supported is critical and triggers
rollback. A field is validly empty only when its manifest is available, has
count zero, and passes length/digest verification.

### 7.1 Cookie identity and writes

Equivalent cookies are keyed by:

```text
mapped regular store + partition key + domain + path + name
```

Source store IDs are profile-specific and are mapped to the destination's
current regular store. Partition keys are retained when supported. Host-only
cookies are written without forcing a Domain attribute. Session cookies omit
`expirationDate`; persistent cookies preserve it. `sameSite: unspecified` is
preserved rather than being silently converted to `lax`.

- Sync uses `chrome.cookies.set` so an equivalent **source** cookie overwrites
  the destination cookie; destination-only cookies remain untouched.
- Clone enumerates the complete accessible destination regular store, verifies
  there was no API error or omitted partition identity, removes those cookies
  only after source and backup validation, then writes the source set.

Each failed cookie is counted with a sanitized reason code. Values are never
logged. In Clone/Restore, failure to remove or set any preflight-supported
cookie is critical.

### 7.2 History

The exact source `HistoryItem` objects are merged into the ShadowLink history
archive. Native history is updated through `chrome.history.addUrl`.

- Sync queries existing destination URLs and adds only missing source URLs.
  When the local archive already has a URL, the source URL-level metadata wins.
- Clone calls `chrome.history.deleteAll`, then adds every supported source URL.
- Invalid URL values reject the snapshot. Schemes Chrome cannot add are
  unsupported and enter the Clone preflight omission list.

The archive preserves source title, `lastVisitTime`, `typedCount`, and
`visitCount` even though native Chrome history cannot restore them exactly.

### 7.3 Bookmarks

Bookmark import walks the source tree recursively and maps Chrome's special
root nodes to the corresponding writable destination roots.

- Sync retains destination-only nodes. Within the same logical parent, a
  matching URL is not duplicated and the source title wins. Missing folders
  and bookmarks are created recursively.
- Clone verifies that every source node maps to a writable root, removes all
  children beneath writable destination roots (never the special roots
  themselves), then rebuilds the source hierarchy.

Generated destination IDs are tracked during recursion; source node IDs are
never reused. Any failed removal or creation of a supported node is critical in
Clone/Restore.

### 7.4 Download archive

Records are keyed by normalized URL, start time, and filename.

- Sync upserts source records into the destination ShadowLink archive; source
  fields win on an equivalent key.
- Clone replaces the active archive with the source records.
- Restore reinstates the archive stored in the pre-Clone backup.

No operation calls `chrome.downloads.download`, and native download history is
neither cleared nor rewritten.

### 7.5 Tabs

Canonical URL comparison ignores fragments and normalizes a trailing slash
where safe.

- Sync opens supported source URLs that do not already exist in the destination
  window. It does not close, reorder, pin, or activate existing destination
  tabs.
- Clone creates a temporary safe tab, opens every supported source tab in
  source order, restores `pinned` state and the selected active tab, closes the
  pre-Clone tabs, then removes the temporary tab. Tabs are recreated in the
  current window only.

Restricted/internal/invalid URLs are classified during preflight, not silently
skipped during mutation. Tab work occurs last so a failure in another category
does not prematurely discard the operator's pages. Created and pre-existing tab
IDs are journaled before each close/open step so recovery can reconcile a
partially completed tab phase.

## 8. Destination backup, local storage, and durable jobs

### 8.1 Backup schema and completeness gate

Use IndexedDB for potentially large or sensitive local artifacts. A pre-Clone
backup is a versioned manifest plus chunked category data:

```text
backup_id, schema_version, state, created_at,
destination_profile/store mapping, destination_window_id,
category availability/completeness/count/bytes/sha256,
full manifest sha256
```

Each backup category is serialized once to immutable UTF-8 JSON bytes. Counts,
byte lengths, chunk digests, and category digests cover those exact stored
bytes. The backup manifest uses the same RFC 8785 rule as the capture manifest,
with its own digest member omitted. Backup verification never depends on
reserializing parsed objects.

It contains:

- every accessible cookie in the destination regular store, including local
  store mapping and partition key;
- all destination native `HistoryItem` URL records, with complete coverage and
  `truncated: false`;
- the complete bookmark tree beneath every writable root;
- all tabs in the destination window with URL, order, pinned, and active state;
- the current ShadowLink history archive; and
- the current ShadowLink download archive.

Native download history is not mutated and therefore is not part of rollback.
Every Chrome callback checks `chrome.runtime.lastError`. Any incomplete cookie
store, truncated/incomplete history window, unreadable bookmark root, missing
tab URL, archive read error, item limit, byte limit, or storage quota failure
blocks Clone before mutation.

Backup chunks are written under a new `staged` backup ID without modifying the
pointer to the previous valid backup. ShadowLink then reads every staged chunk
back, recomputes per-category counts/lengths/digests and the full manifest
digest, and checks category completeness. The verified backup remains staged
while the UI awaits destructive confirmation. Cancellation deletes only that
staged backup. After confirmation, one short atomic IndexedDB transaction
promotes the verified ID to `active` immediately before the first mutation.
The prior active backup is retained as `previous` until Clone completes or
verified rollback succeeds; `ROLLBACK_INCOMPLETE` retains both. If staging or
verification fails, the previous active backup remains intact.

Suggested database: `shadowlink_sync_v1`

Suggested stores:

- `jobs`: durable job manifests, leases, phase cursors, and item intents;
- `backup_chunks`: staged and active backup chunks;
- `backup_manifests`: staged/active manifests and the active pointer;
- `history_archives`: source metadata not representable in native history;
- `download_archives`: synchronized download records;
- `snapshot_cache`: the verified server snapshot currently being applied.

### 8.2 Resumable mutation journal

Popup code only starts jobs and renders stored progress. The ShadowLink
background service worker owns acquisition, validation, backup, Sync, Clone,
rollback, and Restore. Only one mutating job may run at once.

A job record includes:

- job/snapshot/backup IDs and schema versions;
- state and current phase;
- a renewable lease and last heartbeat;
- whether destination mutation has begun;
- the current item index;
- an intent record written **before** each API mutation;
- completion/result data written after the API promise resolves; and
- whether rollback is required.

All adapters are idempotent or have an explicit restart rule. Examples:

- cookie removal/set resumes from canonical identity and rechecks final value;
- interrupted history replacement reruns `deleteAll` and restarts adds from
  index zero so partial visits are not doubled;
- interrupted bookmark replacement clears writable roots again and rebuilds
  from the deterministic plan;
- tab phase stores created and old tab IDs and reconciles them before resuming;
- archive replacement uses an atomic active-manifest pointer.

`chrome.runtime.onStartup`, service-worker initialization, and every popup/job
message call `recoverJobs()`. Recovery takes over expired leases. If mutation
had not begun it may safely fail or resume acquisition; if mutation had begun
it resumes the deterministic phase or rolls back from the active backup. A
stale `RUNNING` record is never merely unlocked and forgotten.

### 8.3 Freshness recheck and Restore recovery backup

A verified backup cannot wait indefinitely while the destination changes. The
destructive confirmation is bound to the staged backup ID and digest. After the
user confirms, ShadowLink immediately performs the same complete destination
enumeration again and compares all category/archive identities, counts, byte
lengths, and digests with the staged backup. If anything changed—or the recheck
is incomplete—the confirmation is invalidated, no mutation occurs, and
ShadowLink rebuilds the backup and asks for confirmation again. When equal, it
durably records the verified digest and timestamp, promotes the backup, and
starts mutation without another user-controlled wait.

Restore has two distinct backup roles:

- `restore_source_backup_id`: the retained pre-Clone backup the user selected
  to apply; and
- `restore_recovery_backup_id`: a newly staged and verified complete backup of
  the destination state that Restore is about to destroy.

Before destructive Restore, ShadowLink captures, read-back verifies, and
freshness-rechecks the recovery backup using every gate in §8.1. It never
overwrites or repurposes the Restore source. A Restore mutation failure rolls
back from `restore_recovery_backup_id`, not from the source being applied. Both
backups remain until Restore and any rollback verify successfully; a recovery
backup may be retained as an explicit **Undo Restore** source until the next
successful Clone/Restore or user deletion.

## 9. Clone safety, critical failures, and rollback

Clone uses this durable state machine:

```text
FETCHING
  -> VALIDATING_SCHEMA_AND_DIGESTS
  -> PREFLIGHTING_REPRESENTABILITY
  -> BACKING_UP
  -> VERIFYING_BACKUP
  -> AWAITING_DESTRUCTIVE_CONFIRMATION
  -> RECHECKING_DESTINATION_DIGESTS
  -> PROMOTING_BACKUP
  -> APPLYING_COOKIES
  -> APPLYING_HISTORY
  -> APPLYING_BOOKMARKS
  -> APPLYING_DOWNLOAD_ARCHIVE
  -> APPLYING_TABS
  -> VERIFYING_DESTINATION
  -> COMPLETE | COMPLETE_WITH_ACCEPTED_OMISSIONS
```

No destination mutation occurs before confirmation, the no-change freshness
recheck, and backup promotion complete. Restore uses the parallel sequence
`VALIDATING_RESTORE_SOURCE -> BACKING_UP_CURRENT_FOR_RESTORE ->
VERIFYING_RESTORE_RECOVERY_BACKUP -> AWAITING_RESTORE_CONFIRMATION ->
RECHECKING_DESTINATION_DIGESTS -> APPLYING_RESTORE`; both the Restore source and
recovery backup IDs are journaled before mutation. These are critical after
mutation starts:

- any failed removal of a destination item that should be replaced;
- any failed write of a source item classified as supported;
- a post-write count/digest/identity verification mismatch;
- loss of the active backup, snapshot, journal, or required permission;
- an unexpected schema/API error; or
- inability to determine whether an in-flight operation completed.

A critical failure sets `rollback_required` durably before rollback begins and
transitions to `ROLLING_BACK`. Rollback uses the same preflight, journal,
idempotence, and verification rules against the active pre-Clone backup for
Clone, or the separate pre-Restore recovery backup for Restore. The final state
is one of:

- `COMPLETE`;
- `COMPLETE_WITH_ACCEPTED_OMISSIONS`;
- `ROLLED_BACK`;
- `FAILED_BEFORE_MUTATION`; or
- `ROLLBACK_INCOMPLETE`.

Because Chrome cannot restore original native history timestamps or old native
download entries, the UI repeats those limitations before Clone and Restore. A
rollback restores the saved URL set and full ShadowLink archives, not
impossible browser-internal metadata. `ROLLBACK_INCOMPLETE` keeps the backup and
full per-category recovery report visible; it never claims success.

## 10. Error model

Use stable machine-readable codes and user-readable messages. Representative
codes:

- `endpoint_offline_no_snapshot`
- `live_snapshot_timeout`
- `cached_fallback_used`
- `snapshot_field_missing`
- `snapshot_legacy_only`
- `snapshot_too_large`
- `snapshot_acquisition_timeout`
- `snapshot_digest_mismatch`
- `snapshot_out_of_order`
- `history_truncated`
- `history_window_incomplete`
- `unsupported_clone_items`
- `backup_incomplete`
- `backup_quota_exceeded`
- `backup_write_failed`
- `backup_verify_failed`
- `supported_item_remove_failed`
- `supported_item_write_failed`
- `cookie_write_failed`
- `bookmark_write_failed`
- `restricted_tab_url`
- `job_recovery_failed`
- `rollback_incomplete`
- `unsupported_snapshot_schema`

Server and extension logs may include endpoint ID, snapshot/job ID, field name,
counts, byte sizes, duration, and error code. They must not include cookie
values, complete cookie objects, admin credentials, proxy passwords, backup
payloads, or full snapshot payloads.

## 11. Permissions and versioning

ShadowLink adds the permissions needed to apply and back up the new categories:

- `history`
- `bookmarks`
- `tabs`
- `unlimitedStorage` to reduce normal extension-storage quota/eviction risk for
  verified backups and archives

Even with `unlimitedStorage`, ShadowLink must treat storage estimation, write,
and read-back failures as hard pre-mutation failures. ShadowLink does **not**
need the `downloads` permission because it only stores source download records
received from the server and never reads or writes destination native download
history.

Existing `cookies`, `storage`, and `<all_urls>` access remain. Set a minimum
Chrome version that supports partition-key cookie writes (Chrome 119 or newer),
or block Clone during preflight on an older runtime. Increment the ShadowLink
version and ship the Sensor, server, migration, and ShadowLink changes in the
same release bundle.

Snapshot payloads start at `schema_version: 1`. Sensor authentication advertises
its versioned snapshot capability. ShadowLink refuses destructive Clone when it
does not understand the server schema. An older Sensor that does not support
the chunk protocol may still contribute old periodic cached data, but that data
is `legacy_cached` and never Clone-eligible.

## 12. Testing and acceptance

All production behaviour changes follow red-green TDD: write a focused failing
test, observe the intended failure, implement the smallest passing behaviour,
and run the relevant full suite before moving on.

### 12.1 Go tests

Add table-driven tests for:

1. valid credentials and online job creation/status polling;
2. offline trusted-cache response without a live RPC;
3. live timeout returning an unchanged qualifying cached snapshot;
4. no live/trusted data returning only explicitly marked legacy fields;
5. legacy empty arrays remaining unavailable;
6. versioned manifest validation and valid authoritative empty arrays;
7. chunk ordering, duplicate chunks, byte/item/time limits, and digest mismatch;
8. manifest-only status responses and bounded authenticated HTTP chunk reads
   for both live and cached snapshots;
9. interrupted HTTP chunk download resumption and staging/retention expiry;
10. incomplete/failed jobs producing no trusted database row;
11. immutable promotion and monotonic `snapshot_seq` ordering;
12. a narrower history snapshot never replacing/deleting the latest full one;
13. invalid credentials and cross-endpoint job/chunk access denial;
14. stable source, schema, coverage, count, byte, digest, and fallback metadata;
15. exact BYTEA preservation instead of JSON reserialization;
16. shared RFC 8785 JS/Go golden vectors and digest rejection;
17. background first-connect capture rate limiting;
18. existing `SYNC`/`SYNC_HUGE` messages never mutating trusted rows; and
19. sanitized logs/errors containing no payload values.

Migration tests must start with both a fresh schema and a pre-existing legacy
`users`/`bots` schema, call the real `Migrate`, verify the new table and indexes,
insert/read a full snapshot, rerun migration, and prove idempotence. Migration
errors must be asserted rather than ignored.

### 12.2 Sensor tests

Test the range-aware collector and versioned chunk protocol:

1. 7/30/90/all range selection;
2. time-window bisection when a result window is full;
3. URL deduplication across windows;
4. truncation at the minimum window size;
5. every `chrome.runtime.lastError` path producing failure, never `[]` success;
6. category error isolation and manifest availability flags;
7. resumable capture after forced worker termination at each history window;
8. immutable chunks and repeatable chunk reads by snapshot ID;
9. count/byte/digest calculation and authoritative empty arrays;
10. RFC 8785 manifest golden vectors shared with Go;
11. item, byte, acquisition-time, and TTL limits; and
12. release/garbage collection of staged snapshot data.

### 12.3 ShadowLink tests

Extract pure planning, canonicalization, digest, and state-machine functions and
test them with Node's built-in test runner. Mock Chrome adapters for API effects.

Required cases:

1. cookies selected by default;
2. source-equivalent cookie overwrites and destination-only cookie retention;
3. partitioned/session/host-only cookie parameter construction;
4. history deduplication and URL-level archive metadata retention;
5. recursive bookmark merge and Clone replacement;
6. download archive source-wins merge and replacement;
7. tab deduplication and Clone ordering;
8. Clone blocked for missing, legacy, truncated, oversized, or digest-invalid
   data;
9. unsupported items block normal Clone and explicit omissions produce only
   `COMPLETE_WITH_ACCEPTED_OMISSIONS`;
10. complete destination enumeration, backup schema, and coverage gates;
11. quota/write/read-back/digest failure prevents any mutation;
12. staged backup failure preserves the previous active backup;
13. post-confirmation freshness recheck invalidates stale backups and requires
    a rebuilt backup plus renewed confirmation;
14. Restore creates and verifies a separate pre-Restore recovery backup and
    never overwrites its Restore source;
15. a Restore failure rolls back from the pre-Restore recovery backup;
16. bounded server-to-ShadowLink chunk download, digest verification,
    IndexedDB checkpointing, and resume;
17. immutable category-byte verification and RFC 8785 manifest golden vectors;
18. every supported removal/write failure after mutation triggers rollback;
19. forced worker termination during every clear/write phase resumes or rolls
   back from the durable journal;
20. stale lease recovery on worker initialization and `runtime.onStartup`;
21. popup reopen reads the same background job state;
22. Restore uses the same preflight, journal, and verification rules; and
23. all result and error text excludes cookie values and credentials.

### 12.4 End-to-end acceptance

Run against an enrolled test browser and verify:

1. online Sync uses a newly completed live logical snapshot;
2. offline Sync uses a qualifying trusted snapshot and displays its capture
   window;
3. an apparent-online timeout visibly falls back without altering the trusted
   row;
4. legacy cached data is Sync-only and never enables Clone;
5. first upgraded online connection eventually creates a full trusted cache;
6. online Clone reproduces supported state after preflight, verified backup, and
   confirmation;
7. offline Clone succeeds only with a complete, full, non-truncated trusted
   snapshot;
8. a missing, truncated, oversized, or unsupported category blocks normal Clone
   without destination mutation;
9. accepted omissions are listed and never reported as a complete clone;
10. process/worker termination in every destructive phase resumes safely or
    rolls back after browser restart;
11. injected supported-item failure triggers verified rollback;
12. destination changes after confirmation invalidate Clone and force a new
    backup/confirmation cycle;
13. manual Restore first creates a distinct verified recovery backup;
14. injected Restore failure returns to the pre-Restore destination state;
15. failed backup staging never destroys the previous backup;
16. interrupted live and cached HTTP chunk downloads resume without one large
    payload;
17. closing and reopening the popup does not cancel or lose the job; and
18. no cookie values, credentials, or full payloads appear in logs.

## 13. Documentation references

- Chrome Cookies API: <https://developer.chrome.com/docs/extensions/reference/api/cookies>
- Chrome History API: <https://developer.chrome.com/docs/extensions/reference/api/history>
- Chrome Bookmarks API: <https://developer.chrome.com/docs/extensions/reference/api/bookmarks>
- Chrome Downloads API: <https://developer.chrome.com/docs/extensions/reference/api/downloads>
- Chrome Tabs API: <https://developer.chrome.com/docs/extensions/reference/api/tabs>
- Extension service-worker lifecycle:
  <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Extension storage and cookies:
  <https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies>
- RFC 8785 JSON Canonicalization Scheme:
  <https://www.rfc-editor.org/rfc/rfc8785>
