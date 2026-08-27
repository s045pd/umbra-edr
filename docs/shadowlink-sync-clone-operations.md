# ShadowLink Sync/Clone Operations Guide

This runbook covers the coordinated rollout, validation, recovery, and rollback
of browser snapshots used by Umbra server `0.2.0-dev`, Umbra Sensor `0.2.1`, and
ShadowLink `3.0.6`. Use only enrolled endpoints and authorized browser profiles.

## 1. Release order and hold points

Deploy in this order. Do not skip a hold point.

| Stage | Component | Hold point |
|---|---|---|
| 1 | Server migration and browser-snapshot API | The new immutable tables/indexes exist and the server passes health/version checks. |
| 2 | Umbra Sensor `0.2.1` | AUTH advertises `browser_snapshot_v1`, schema `1`, and a 512 KiB chunk size; snapshot RPC failures retain the versioned status envelope. |
| 3 | Trusted cache warm-up | Every endpoint intended for offline Clone has a complete, full-history, non-truncated trusted row. |
| 4 | ShadowLink `3.0.6` | Package manifest and permissions are correct; test-profile Sync/Clone acceptance passes, including native-history cleanup after tab replay. |

Deploying ShadowLink before stages 1-3 can leave Sync with legacy-only data and
must leave Clone blocked. A recent `bots.updatedAt`, `last_online`, or periodic
`SYNC_HUGE` array is not proof of a trusted Clone snapshot.

### Stage 1: server first

1. Back up the database and the persistent `cassl/` directory.
2. Deploy the server build containing the snapshot migration and three public
   bot-credential-scoped endpoints:
   - `POST /api/v1/get-bot-browser-snapshot`
   - `POST /api/v1/get-bot-browser-snapshot-status`
   - `POST /api/v1/get-bot-browser-snapshot-chunk`
3. Verify `/health` and `/version`; the expected development release is
   `0.2.0-dev`.
4. Verify that migration created `bot_browser_snapshots` and
   `bot_browser_snapshot_states` plus their required indexes. Treat any
   migration error as a failed deployment.
5. Leave the existing `bots` arrays in place. They remain useful for the GUI
   and explicitly marked legacy Sync fallback, but cannot authorize Clone.

For PostgreSQL, an operator may use a read-only metadata check such as:

```sql
SELECT to_regclass('public.bot_browser_snapshots'),
       to_regclass('public.bot_browser_snapshot_states');
```

Do not select the five `*_bytes` payload columns during routine verification.

### Stage 2: Sensor `0.2.1`

1. Roll out Sensor `0.2.1` to a small test ring. Do not reuse `0.2.0`: managed Edge only downloads a changed CRX version.
2. Confirm it reconnects and stays enrolled under the same browser ID.
3. Confirm its AUTH capability metadata reports:
   - `browser_snapshot_v1: true`
   - `schema_versions: [1]`
   - `chunk_size: 524288`
4. Confirm all four RPCs can complete: `BEGIN`, `STATUS`, `CHUNK`, and
   `RELEASE_BROWSER_SNAPSHOT_V1`.
5. Expand the Sensor rollout only after the test ring produces trusted rows
   without payload values appearing in logs.

The server schedules at most one low-priority full capture after a capable
Sensor connects, with a 24-hour warm-refresh rate limit. A failed warm capture
must leave the prior trusted row unchanged.

### Stage 3: wait for a trusted full cache

Before offline Clone is enabled operationally, verify one qualifying row per
endpoint. A qualifying row has all of these properties:

- `schema_version = 1` and `sensor_version = '0.2.1'`;
- `history_coverage = 'all'` and `history_truncated = false`;
- a non-empty `manifest_sha256`;
- all five category descriptors available, with counts, byte lengths,
  digests, and chunk counts verified by the server; and
- a completed capture time and server receive time appropriate for the
  rollout window.

Use metadata-only queries. For example:

```sql
SELECT bot_id, snapshot_id, snapshot_seq, schema_version, sensor_version,
       capture_completed_at, received_at, history_coverage,
       history_truncated, manifest_sha256,
       cookies_count, history_count, bookmarks_count,
       downloads_count, tabs_count
FROM bot_browser_snapshots
WHERE history_coverage = 'all' AND history_truncated = false
ORDER BY bot_id, received_at DESC;
```

An authoritative category count of zero is valid only when its manifest field
is available and the empty-array digest is verified. An absent field is not an
empty field.

### Stage 4: ShadowLink `3.0.6`

1. Download/package the `cookie-sync` target only after stages 1-3 pass.
2. Inspect its manifest before distribution:
   - version `3.0.6`;
   - minimum Chrome version `119`;
   - permissions include `history`, `bookmarks`, `tabs`, `alarms`, and
     `unlimitedStorage`;
   - permission `downloads` is absent.
3. Launch an isolated Chromium profile and load the exact distributable
   package automatically; do not substitute mocked Chrome APIs for this gate.
4. Run the affected Sync path against authorized production-shaped data and
   require a terminal success state, zero failed writes, and zero console
   errors. Cookie coverage must include expired cached records and overlapping
   Secure/insecure records before release.
5. Run the 18 acceptance cases in the approved design before broad rollout.
6. Preserve a copy of the exact server, Sensor, and ShadowLink artifacts used
   for the acceptance evidence.

## 2. Snapshot status interpretation

| API/UI status | Meaning | Sync | Clone |
|---|---|---:|---:|
| `pending` | A live logical capture is still running. | Wait | Wait |
| `ready`, source `live` | A newly captured immutable snapshot passed promotion. | Yes | Only if the full Clone gates pass |
| `ready`, source `cached` | The endpoint is offline or live was not preferred; a trusted row is used. | Yes | Only if full, untruncated, complete, and schema-compatible |
| `ready`, source `cached_fallback` | Live capture failed/timed out; the unchanged qualifying trusted row is used. Inspect `fallback_reason`. | Yes | Only after the same full gates and an explicit operator review |
| `ready`, source `legacy_cached` | Mutable historical `bots` arrays with incomplete provenance. | Merge-only for available fields | Never |
| `failed` | No usable source or a stable acquisition/verification error. | No | No |

`trusted` means the server verified one immutable manifest and all five exact
category byte streams before atomically promoting the row. It does not mean
that Chrome can reproduce every browser-internal detail.

## 3. Fixed v1 limits

| Limit | Value |
|---|---:|
| HTTP/WebSocket category chunk | 512 KiB |
| Total canonical category bytes | 64 MiB |
| One category | 32 MiB |
| Flat items per category | 250,000 |
| Logical acquisition deadline | 5 minutes |
| Sensor staging TTL | 10 minutes |
| Legacy server job TTL | 10 minutes |
| Automatic full-cache refresh interval | At most once per 24 hours per endpoint |

ShadowLink's `unlimitedStorage` permission reduces ordinary extension quota
risk; it does not make disk-full, IndexedDB, write, read-back, or digest errors
safe to ignore. Any incomplete or unverifiable destination backup blocks
destructive mutation.

## 4. Chrome platform limitations

- Native download history cannot be recreated or cleared by this feature.
  Download records live in ShadowLink's searchable/exportable archive.
- `chrome.history.addUrl` cannot restore original visit timestamps, visit
  transitions, typed counts, or every visit event. ShadowLink retains the
  available URL-level metadata in its archive.
- Clone recreates tabs only in the current window; it does not reproduce
  remote windows or tab groups.
- Restricted/internal/invalid URLs may be unrepresentable. Ordinary Clone is
  blocked; the separate supported-items-only path records accepted omissions.
- Incognito stores, other Chrome profiles, passwords, autofill, localStorage,
  IndexedDB, service-worker caches, installed extensions, and browser settings
  are outside scope.
- Partitioned-cookie writes require Chrome 119 or newer. Older runtimes must
  block Clone during preflight.
- A browser/service-worker shutdown can interrupt an operation. Durable job
  leases and journals recover it; closing the popup does not cancel it.

## 5. Operator procedure

### Sync (merge)

1. Select **Sync** on the source endpoint.
2. Cookies are selected by default. Select History, Bookmarks, Downloads, or
   Open tabs only when wanted; History defaults to 30 days and supports
   7/30/90/all.
3. Review source (`Live`, `Cached`, `Cached fallback`, or legacy), capture time,
   availability, and counts.
4. Start the job. Sync does not delete destination-only state. Per-category
   success, skip, and failure counts remain independent.

### Clone (replace supported state)

1. Use a test profile for first acceptance. All five categories are locked on.
2. Review the immutable source manifest and any unsupported items.
3. Wait for the complete destination backup to be staged, read back, and
   digest-verified.
4. At `AWAITING_DESTRUCTIVE_CONFIRMATION`, review the endpoint, snapshot ID,
   backup ID/digest, counts, limitations, and accepted omissions.
5. Confirm only if the source and destination are correct. ShadowLink then
   re-enumerates the destination; a mismatch invalidates the confirmation and
   requires a new backup/confirmation cycle.

**Safe stop before mutation:** do not press the destructive confirmation
button. Close the dialog or popup if desired; the durable job remains awaiting
confirmation and no destination mutation occurs. Closing the popup is not a
cancel action. Do not terminate the browser as a substitute for cancellation
after mutation has started.

### Restore and Undo Restore

1. In **Tools → Backups**, select the retained pre-Clone backup and choose
   **Restore previous state**.
2. ShadowLink first creates a separate verified recovery backup of the current
   destination. The Restore source and recovery backup IDs must differ.
3. Review and confirm Restore only after both backup roles are shown.
4. A successful Restore retains its recovery backup as the **Undo Restore**
   source. Undo uses the same preflight, fresh recovery backup, confirmation,
   journal, and verification rules.
5. Delete a backup only when the UI reports it is not active, referenced by a
   job, a Restore source, or an Undo source. Never delete IndexedDB records
   manually while a job exists.

## 6. Failure and recovery

### Before mutation

`FAILED_BEFORE_MUTATION`, schema/digest errors, unavailable fields, backup
quota/write/read-back errors, and a stale destination recheck mean no
destination state should have been changed. Keep the prior active backup and
fix the stated error before starting a new destructive job.

### After mutation

- `ROLLED_BACK`: rollback and its verification completed. Review the report
  before retrying.
- `COMPLETE_WITH_ACCEPTED_OMISSIONS`: only the items listed at confirmation
  were omitted. Do not report this as a complete clone.
- `ROLLBACK_INCOMPLETE`: recovery could not prove the destination matches its
  backup.

For `ROLLBACK_INCOMPLETE`:

1. Stop starting new Sync, Clone, Restore, or backup deletion actions in that
   profile.
2. Keep ShadowLink installed and keep every referenced source, active,
   previous, and recovery backup.
3. Record only sanitized job/phase/error metadata and the rollback report.
4. Reopen the popup to allow stale-lease recovery; do not clear extension
   storage, reset the profile, or repeatedly click Restore.
5. Escalate for category-level inspection. Restore only from the specifically
   identified verified backup after the failure cause is understood.

## 7. Sanitized diagnostics

Allowed diagnostic fields:

- endpoint label/ID, job ID, snapshot ID, and backup IDs;
- server/Sensor/ShadowLink/schema versions;
- source status, capture/receive/start/end times, state, phase, cursor, and
  duration;
- category availability, count, byte length, chunk count, coverage,
  truncation flag, and SHA-256 digests;
- fallback reason, stable error code, rollback state, and omission reason
  codes.

Never record cookie values or full cookie objects, URLs/titles from payloads,
proxy/admin credentials, request authorization headers, snapshot/category
bytes, backup bytes, complete archives, or full RPC/HTTP bodies. If a client or
server error contains raw payload data, redact the data and retain only its
stable error code and identifiers.

## 8. Rollback policy

1. Stop new destructive confirmations and allow any already-mutating job to
   reach a verified terminal or recovery state.
2. Roll back ShadowLink distribution first, then Sensor distribution if
   required, and the server binary last.
3. Preserve the database and `cassl/` backup. Rolling back the server binary
   **must not drop, truncate, rewrite, or manually delete**
   `bot_browser_snapshots` or `bot_browser_snapshot_states`.
4. The older server may ignore the new immutable tables. Leaving them in place
   permits forensic review and a forward redeploy without destroying the last
   trusted cache.
5. Do not downgrade a browser profile while it has an active or
   `ROLLBACK_INCOMPLETE` ShadowLink job unless the recovery owner explicitly
   approves the profile-level procedure.

Server rollback is an application-binary rollback, not a reverse migration.
Any later schema removal requires a separately reviewed data-retention and
backup plan.
