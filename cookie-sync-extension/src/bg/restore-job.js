import {
  BACKUP_CATEGORIES,
  BackupError,
  confirmFreshnessAndPromote,
  readBackupCategory,
  stageDestinationBackup,
  verifyStagedBackup,
} from "./backup.js";
import {
  applyCloneMutation,
  rollbackCloneJob,
} from "./clone-job.js";
import { SnapshotStorageError } from "./idb.js";
import { preflightSnapshot } from "../lib/planners.js";

const digestPattern = /^[0-9a-f]{64}$/;

export const RESTORE_STATE_SEQUENCE = Object.freeze([
  "VALIDATING_RESTORE_SOURCE",
  "BACKING_UP_CURRENT_FOR_RESTORE",
  "VERIFYING_RESTORE_RECOVERY_BACKUP",
  "AWAITING_RESTORE_CONFIRMATION",
  "RECHECKING_DESTINATION_DIGESTS",
  "PROMOTING_RESTORE_RECOVERY_BACKUP",
  "APPLYING_RESTORE",
]);

const terminalStates = new Set([
  "COMPLETE",
  "COMPLETE_WITH_ACCEPTED_OMISSIONS",
  "ROLLED_BACK",
  "FAILED_BEFORE_MUTATION",
  "ROLLBACK_INCOMPLETE",
]);

export class RestoreJobError extends Error {
  constructor(code) {
    super("ShadowLink Restore operation failed");
    this.name = "RestoreJobError";
    this.code = code;
  }
}

function restoreError(code) {
  return new RestoreJobError(code);
}

function safeCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : fallback;
}

function normalizeRequest(request) {
  const jobId = request?.jobId || request?.job_id;
  const sourceBackupId =
    request?.restoreSourceBackupId || request?.restore_source_backup_id;
  if (
    typeof jobId !== "string" ||
    jobId.length === 0 ||
    typeof sourceBackupId !== "string" ||
    sourceBackupId.length === 0
  ) {
    throw restoreError("invalid_restore_request");
  }
  return {
    jobId,
    sourceBackupId,
    acceptedOmissions: request?.acceptedOmissions === true || request?.accepted_omissions === true,
  };
}

function normalizeConfirmation(value) {
  return {
    sourceBackupId:
      value?.restoreSourceBackupId || value?.restore_source_backup_id,
    sourceManifestSHA256:
      value?.restoreSourceManifestSHA256 || value?.restore_source_manifest_sha256,
    recoveryBackupId:
      value?.restoreRecoveryBackupId || value?.restore_recovery_backup_id,
    recoveryManifestSHA256:
      value?.restoreRecoveryManifestSHA256 || value?.restore_recovery_manifest_sha256,
  };
}

async function transition(db, jobId, state, patch, now) {
  return db.updateJob(jobId, (job) => {
    job.state_history = Array.isArray(job.state_history) ? job.state_history : [];
    if (job.state_history.at(-1) !== state) job.state_history.push(state);
    job.state = state;
    Object.assign(job, structuredClone(patch || {}));
    job.updated_at = now;
    return job;
  });
}

async function failBeforeMutation(db, jobId, error, now) {
  return db.updateJob(jobId, (job) => {
    if (job.state_history.at(-1) !== "FAILED_BEFORE_MUTATION") {
      job.state_history.push("FAILED_BEFORE_MUTATION");
    }
    job.state = "FAILED_BEFORE_MUTATION";
    job.error_code = safeCode(error, "restore_source_invalid");
    job.rollback_required = false;
    delete job.clone_snapshot;
    delete job.clone_plan;
    job.updated_at = now;
    return job;
  });
}

function unwrapBookmarkRoots(tree) {
  return tree.length === 1 && tree[0]?.id === "0" && Array.isArray(tree[0].children)
    ? tree[0].children
    : tree;
}

function firstBlockReason(preflight) {
  const priority = [
    "snapshot_field_missing",
    "snapshot_too_large",
    "snapshot_digest_mismatch",
    "unsupported_snapshot_schema",
    "history_window_incomplete",
    "unsupported_clone_items",
    "invalid_snapshot_item",
  ];
  return priority.find((reason) => preflight.reasons.includes(reason)) || preflight.reasons[0] || "unsupported_clone_items";
}

async function readRestoreSource(db, backupId, expectedDigest) {
  const manifest = await db.getBackupManifest(backupId);
  if (
    !manifest ||
    manifest.schema_version !== 1 ||
    manifest.verified !== true ||
    !["active", "previous"].includes(manifest.state) ||
    !digestPattern.test(manifest.manifest_sha256 || "") ||
    (expectedDigest && manifest.manifest_sha256 !== expectedDigest)
  ) {
    throw restoreError("restore_source_invalid");
  }
  const values = {};
  for (const category of BACKUP_CATEGORIES) {
    const descriptor = manifest.categories?.[category];
    if (descriptor?.available !== true || descriptor?.complete !== true) {
      throw restoreError("restore_source_invalid");
    }
    values[category] = await readBackupCategory(db, backupId, category);
  }
  return { manifest, values };
}

function syntheticSnapshot(source) {
  const descriptorMap = {
    cookies: "cookies",
    history: "native_history",
    bookmarks: "bookmarks",
    downloads: "download_archive",
    tabs: "tabs",
  };
  const categories = {
    cookies: source.values.cookies.items,
    history: source.values.native_history.items,
    bookmarks: source.values.bookmarks.roots,
    downloads: source.values.download_archive.records,
    tabs: source.values.tabs.items,
  };
  const fields = {};
  for (const [category, backupCategory] of Object.entries(descriptorMap)) {
    fields[category] = {
      ...structuredClone(source.manifest.categories[backupCategory]),
      // Snapshot descriptors count top-level category array entries. Backup
      // bookmark descriptors intentionally count every nested node instead,
      // so adapt that storage-specific count for shared preflight validation.
      count: categories[category].length,
      legacy: false,
      digest_valid: true,
    };
  }
  return {
    snapshot_id: `restore:${source.manifest.backup_id}`,
    source: "backup",
    trusted: true,
    sync_only: false,
    schema_version: 1,
    manifest_sha256: source.manifest.manifest_sha256,
    history_coverage: "all",
    history_truncated: false,
    integrity_valid: true,
    fields,
    categories,
  };
}

async function destinationCapabilities(deps) {
  const store = await deps.adapters.getCurrentRegularCookieStore();
  const [cookies, history, bookmarks, tabs, historyArchive, downloads] = await Promise.all([
    deps.adapters.enumerateCookies(store.id),
    deps.adapters.enumerateHistory({ startTime: 0, endTime: deps.now() }),
    deps.adapters.enumerateBookmarks(),
    deps.adapters.enumerateTabs({ currentWindow: true }),
    deps.db.readActiveArchive("history"),
    deps.db.readActiveArchive("downloads"),
  ]);
  return {
    regularStoreId: store.id,
    supportsPartitionKey: deps.supportsPartitionKey !== false,
    currentWindowId: deps.currentWindowId,
    writableRoots: deps.writableRoots || {},
    acceptedOmissions: deps.acceptedOmissions,
    existing: {
      cookies,
      history,
      bookmarks: unwrapBookmarkRoots(bookmarks),
      tabs,
      historyArchive: historyArchive.records,
      downloads: downloads.records,
    },
  };
}

export async function prepareRestoreJob(request, dependencies = {}) {
  const normalized = normalizeRequest(request);
  const deps = {
    ...dependencies,
    now: dependencies.now || (() => Date.now()),
    randomUUID: dependencies.randomUUID || globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
  };
  if (!deps.db || !deps.adapters || typeof deps.randomUUID !== "function") {
    throw restoreError("invalid_restore_dependencies");
  }
  let job = await deps.db.initializeRestoreJob(
    normalized.jobId,
    normalized.sourceBackupId,
    normalized.acceptedOmissions,
    deps.now(),
  );
  if (job.state !== "VALIDATING_RESTORE_SOURCE") return job;

  let source;
  let snapshot;
  let preflight;
  try {
    source = await readRestoreSource(deps.db, normalized.sourceBackupId);
    snapshot = syntheticSnapshot(source);
    const capabilities = await destinationCapabilities({
      ...deps,
      acceptedOmissions: normalized.acceptedOmissions,
    });
    preflight = preflightSnapshot("restore", snapshot, capabilities);
    if (preflight.blocked) throw restoreError(firstBlockReason(preflight));
    // Native history and ShadowLink's full-fidelity archive have separate
    // restore roles. The native URL plan comes from preflight; archive bytes
    // must come from the selected source backup verbatim.
    preflight.plans.history.archive_records = structuredClone(
      source.values.history_archive.records,
    );
  } catch (error) {
    return failBeforeMutation(deps.db, normalized.jobId, error, deps.now());
  }

  await deps.db.updateJob(normalized.jobId, (record) => {
    record.restore_source_manifest_sha256 = source.manifest.manifest_sha256;
    record.restore_source_verified_at = deps.now();
    record.snapshot_id = normalized.sourceBackupId;
    record.snapshot_source = "backup";
    record.clone_snapshot = structuredClone(snapshot);
    record.clone_plan = structuredClone(preflight.plans);
    record.unsupported = structuredClone(preflight.unsupported);
    record.destination_window_id = deps.currentWindowId;
    record.writable_roots = structuredClone(deps.writableRoots || {});
    record.restore_source_summary = {
      backup_id: source.manifest.backup_id,
      created_at: source.manifest.created_at,
      purpose: source.manifest.purpose,
      categories: Object.fromEntries(
        Object.entries(source.manifest.categories || {}).map(([category, descriptor]) => [
          category,
          { count: descriptor.count, byte_length: descriptor.byte_length },
        ]),
      ),
    };
    record.updated_at = deps.now();
    return record;
  });
  await transition(
    deps.db,
    normalized.jobId,
    "BACKING_UP_CURRENT_FOR_RESTORE",
    {},
    deps.now(),
  );
  let staged;
  try {
    staged = await stageDestinationBackup(
      { purpose: "restore_recovery" },
      deps,
    );
    if (staged.backup_id === normalized.sourceBackupId) {
      throw restoreError("restore_backup_role_conflict");
    }
  } catch (error) {
    return failBeforeMutation(deps.db, normalized.jobId, error, deps.now());
  }
  await transition(
    deps.db,
    normalized.jobId,
    "VERIFYING_RESTORE_RECOVERY_BACKUP",
    { restore_recovery_backup_id: staged.backup_id, backup_id: staged.backup_id },
    deps.now(),
  );
  let verified;
  try {
    verified = await verifyStagedBackup(staged.backup_id, { db: deps.db, now: deps.now });
  } catch (error) {
    return failBeforeMutation(deps.db, normalized.jobId, error, deps.now());
  }
  return transition(
    deps.db,
    normalized.jobId,
    "AWAITING_RESTORE_CONFIRMATION",
    {
      restore_recovery_manifest_sha256: verified.manifest_sha256,
      confirmation_required: true,
    },
    deps.now(),
  );
}

function confirmationMatches(job, confirmation) {
  return (
    confirmation.sourceBackupId === job.restore_source_backup_id &&
    confirmation.sourceManifestSHA256 === job.restore_source_manifest_sha256 &&
    confirmation.recoveryBackupId === job.restore_recovery_backup_id &&
    confirmation.recoveryManifestSHA256 === job.restore_recovery_manifest_sha256 &&
    confirmation.sourceBackupId !== confirmation.recoveryBackupId
  );
}

async function annotateRestoreResult(jobId, deps) {
  return deps.db.updateJob(jobId, (job) => {
    job.result = {
      ...(job.result || {}),
      operation: "restore",
      restore_source_backup_id: job.restore_source_backup_id,
      restore_recovery_backup_id: job.restore_recovery_backup_id,
    };
    if (["COMPLETE", "COMPLETE_WITH_ACCEPTED_OMISSIONS"].includes(job.state)) {
      job.undo_restore_backup_id = job.restore_recovery_backup_id;
      job.result.undo_restore_backup_id = job.restore_recovery_backup_id;
    }
    job.updated_at = deps.now();
    return job;
  });
}

function restoreCompletionOptions(job) {
  return {
    completionPatch: {
      undo_restore_backup_id: job.restore_recovery_backup_id,
    },
    completionResult: {
      operation: "restore",
      restore_source_backup_id: job.restore_source_backup_id,
      restore_recovery_backup_id: job.restore_recovery_backup_id,
      undo_restore_backup_id: job.restore_recovery_backup_id,
    },
  };
}

export async function confirmRestoreJob(jobId, value, dependencies = {}) {
  const deps = { ...dependencies, now: dependencies.now || (() => Date.now()) };
  const confirmation = normalizeConfirmation(value);
  let job = await deps.db.getJob(jobId);
  if (!job || job.kind !== "restore") throw restoreError("restore_job_not_found");
  if (!confirmationMatches(job, confirmation)) {
    throw restoreError("restore_confirmation_mismatch");
  }
  if (![
    "AWAITING_RESTORE_CONFIRMATION",
    "RECHECKING_DESTINATION_DIGESTS",
  ].includes(job.state)) {
    throw restoreError("invalid_restore_state");
  }
  await readRestoreSource(
    deps.db,
    confirmation.sourceBackupId,
    confirmation.sourceManifestSHA256,
  );
  await deps.db.updateJob(jobId, (record) => {
    record.restore_confirmation = {
      restore_source_backup_id: confirmation.sourceBackupId,
      restore_source_manifest_sha256: confirmation.sourceManifestSHA256,
      restore_recovery_backup_id: confirmation.recoveryBackupId,
      restore_recovery_manifest_sha256: confirmation.recoveryManifestSHA256,
      confirmed_at: deps.now(),
    };
    return record;
  });
  await transition(
    deps.db,
    jobId,
    "RECHECKING_DESTINATION_DIGESTS",
    {},
    deps.now(),
  );
  const freshness = await confirmFreshnessAndPromote(
    {
      backupId: confirmation.recoveryBackupId,
      manifestSHA256: confirmation.recoveryManifestSHA256,
    },
    {
      ...deps,
      beforePromote: async () => {
        await transition(
          deps.db,
          jobId,
          "PROMOTING_RESTORE_RECOVERY_BACKUP",
          {},
          deps.now(),
        );
      },
    },
    async () => {
      await transition(deps.db, jobId, "APPLYING_RESTORE", {}, deps.now());
      const applying = await deps.db.getJob(jobId);
      await applyCloneMutation(jobId, deps, restoreCompletionOptions(applying));
    },
  );
  if (!freshness.fresh) {
    return transition(
      deps.db,
      jobId,
      "RESTORE_BACKUP_STALE",
      {
        requires_new_backup: true,
        requires_confirmation: true,
        freshness_changes: freshness.changes,
      },
      deps.now(),
    );
  }
  return annotateRestoreResult(jobId, deps);
}

export async function resumeRestoreJob(jobId, dependencies = {}) {
  const deps = { ...dependencies, now: dependencies.now || (() => Date.now()) };
  const job = await deps.db.getJob(jobId);
  if (!job || terminalStates.has(job.state)) return job;
  if (job.state === "ROLLING_BACK") {
    const result = await rollbackCloneJob(
      jobId,
      deps,
      restoreError(job.error_code || "job_recovery_failed"),
    );
    return annotateRestoreResult(jobId, deps, result);
  }
  if (["RECHECKING_DESTINATION_DIGESTS", "PROMOTING_RESTORE_RECOVERY_BACKUP"].includes(job.state)) {
    const confirmation = job.restore_confirmation;
    if (!confirmation) throw restoreError("job_recovery_failed");
    if (job.state === "PROMOTING_RESTORE_RECOVERY_BACKUP") {
      const pointers = await deps.db.getBackupPointers();
      if (pointers?.active_backup_id === job.restore_recovery_backup_id) {
        await applyCloneMutation(jobId, deps, restoreCompletionOptions(job));
        return annotateRestoreResult(jobId, deps);
      }
    }
    return confirmRestoreJob(jobId, confirmation, deps);
  }
  if (job.state === "APPLYING_RESTORE") {
    await applyCloneMutation(jobId, deps, restoreCompletionOptions(job));
    return annotateRestoreResult(jobId, deps);
  }
  if (job.state.startsWith("APPLYING_") || job.state === "VERIFYING_DESTINATION") {
    await applyCloneMutation(jobId, deps, {
      recovering: true,
      ...restoreCompletionOptions(job),
    });
    return annotateRestoreResult(jobId, deps);
  }
  return job;
}

export async function deleteBackup(backupId, { db, now = () => Date.now() } = {}) {
  if (!db || typeof db.deleteBackup !== "function") throw new BackupError("backup_not_found");
  try {
    return await db.deleteBackup(backupId, now());
  } catch (error) {
    if (error instanceof SnapshotStorageError && error.code === "backup_in_use") {
      throw new BackupError("backup_in_use");
    }
    throw error;
  }
}
