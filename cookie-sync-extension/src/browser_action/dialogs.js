export const CATEGORY_LABELS = Object.freeze({
  cookies: "Cookies",
  history: "History",
  bookmarks: "Bookmarks",
  downloads: "Download archive",
  tabs: "Tabs",
});

export const HISTORY_RANGES = Object.freeze([
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All available history" },
]);

const categoryOrder = Object.freeze(Object.keys(CATEGORY_LABELS));
const digestPattern = /^[0-9a-f]{64}$/;

export class PopupModelError extends Error {
  constructor(code) {
    super("ShadowLink popup model is invalid");
    this.name = "PopupModelError";
    this.code = code;
  }
}

export function applyButtonLoading(btn, loading) {
  if (!btn) return btn;
  const active = loading === true;
  if (btn.classList && typeof btn.classList.toggle === "function") {
    btn.classList.toggle("loading", active);
  }
  btn.disabled = active;
  return btn;
}

// Drop the spinner without forcing enabled. A later dialog may have already
// set disabled (for example the Clone ack checkbox).
export function finishOperationButton(btn, { sameDialog } = {}) {
  if (!btn) return btn;
  if (btn.classList && typeof btn.classList.remove === "function") {
    btn.classList.remove("loading");
  }
  if (sameDialog === true) btn.disabled = false;
  return btn;
}

export function cloneActionEnabled(bot) {
  return Boolean(bot?.id);
}

export function operationErrorText(code) {
  switch (code) {
    case "sensor_snapshot_upgrade_required":
      return "The target browser is running an outdated Umbra Sensor. Update or reload Umbra Sensor on the target, then retry.";
    case "sensor_snapshot_runtime_error":
      return "The target Umbra Sensor could not capture a browser snapshot. Update or reload it, then retry.";
    case "invalid_snapshot_deadline":
      return "The target Umbra Sensor rejected the snapshot deadline. Reload the Sensor and retry.";
    case "snapshot_storage_error":
      return "The target Umbra Sensor could not use snapshot storage. Reload the target Sensor, then retry.";
    case "snapshot_field_missing":
      return "The source snapshot is incomplete. Update or reload Umbra Sensor on the target and capture a new snapshot.";
    case "source_endpoint_offline":
      return "Clone requires the source browser to be online. Wait until it reconnects, then retry.";
    case "endpoint_offline_no_snapshot":
      return "The source Umbra Sensor is offline. Wait until it reconnects, then retry.";
    case "snapshot_transport_error":
      return "Could not read cookies or browser data from the source Umbra Sensor. Confirm it is online, then retry.";
    case "unsupported_clone_items":
      return "The source snapshot has items this browser cannot write (chrome:// or file:// tabs, expired cookies, blob downloads). Omit them and retry, or pick a source without those items.";
    default:
      return `Operation stopped (${code}).`;
  }
}

export function summarizeUnsupported(unsupported = []) {
  const counts = new Map();
  for (const item of unsupported) {
    if (typeof item?.category !== "string" || typeof item?.reason !== "string") continue;
    const key = `${item.category}\0${item.reason}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [category, reason] = key.split("\0");
    return { category, reason, count };
  });
}

function sourceLabel(source) {
  switch (source) {
    case "live":
      return "Live";
    case "cached":
      return "Cached";
    case "cached_fallback":
      return "Cached fallback";
    case "legacy_cached":
      return "Legacy cached";
    case "backup":
      return "Local backup";
    default:
      return "Not yet resolved";
  }
}

function categoryModel(id, checked, disabled) {
  return Object.freeze({ id, label: CATEGORY_LABELS[id], checked, disabled });
}

export function createSyncDialogModel(options = {}) {
  const selected = options.selected || {};
  return Object.freeze({
    mode: "sync",
    title: "Merge browser data",
    description: "Selected categories merge into this browser. History is captured in full. Overlapping cookies are replaced so the source session is the one sent.",
    categories: categoryOrder.map((id) =>
      categoryModel(id, selected[id] === undefined ? id === "cookies" : selected[id] === true, false),
    ),
    historyRanges: [],
    historyRange: "all",
    confirmLabel: "Start Sync",
  });
}

export function syncCategorySelection(checked) {
  return Object.fromEntries(categoryOrder.map((id) => [id, checked === true]));
}

export function snapshotMetadataRows(summary = {}) {
  return categoryOrder.map((id) => {
    const field = summary.fields?.[id];
    const available = field?.available === true;
    const legacy = field?.legacy === true;
    return Object.freeze({
      id,
      label: CATEGORY_LABELS[id],
      available,
      legacy,
      count: Number.isSafeInteger(field?.count) && field.count >= 0 ? field.count : 0,
      status: !available ? "Missing" : legacy ? "Legacy only" : "Available",
    });
  });
}

function hasCompleteSummary(summary) {
  return categoryOrder.every((category) => Object.hasOwn(summary?.fields || {}, category));
}

function summaryBlocksClone(summary) {
  if (!hasCompleteSummary(summary)) return false;
  return snapshotMetadataRows(summary).some((row) => !row.available || row.legacy);
}

export function acceptedOmissionsNotice(unsupported = []) {
  const categories = [...new Set(unsupported.map((item) => item?.category).filter(Boolean))];
  const suffix = categories.length ? ` Affected categories: ${categories.join(", ")}.` : "";
  return `Accepted omissions are not a full clone. The terminal state will be COMPLETE_WITH_ACCEPTED_OMISSIONS.${suffix}`;
}

export function createCloneDialogModel(job = {}) {
  const summary = job.snapshot_summary || {};
  const unsupported = Array.isArray(job.unsupported) ? job.unsupported : [];
  const accepted = job.accepted_omissions === true;
  const failed = job.state === "FAILED_BEFORE_MUTATION";
  const normalCloneEnabled =
    !failed &&
    !summaryBlocksClone(summary) &&
    (unsupported.length === 0 || accepted);
  return Object.freeze({
    mode: "clone",
    title: "Clone browser state",
    description: "Replace this browser's cookies, history, bookmarks, download archive, and tabs with a trusted snapshot of the source.",
    categories: categoryOrder.map((id) => categoryModel(id, true, true)),
    sourceLabel: sourceLabel(summary.source || job.snapshot_source),
    captureTime: summary.capture_completed_at || "",
    fallbackReason: summary.fallback_reason || "",
    historyCoverage: summary.history_coverage || "",
    rows: snapshotMetadataRows(summary),
    unsupported,
    acceptedOmissions: accepted,
    acceptedOmissionsNotice: unsupported.length ? acceptedOmissionsNotice(unsupported) : "",
    normalCloneEnabled,
    confirmLabel: normalCloneEnabled
      ? accepted && unsupported.length
        ? "Clone with accepted omissions"
        : "Continue to verified backup"
      : "Clone unavailable",
  });
}

export function buildCloneConfirmation(job) {
  if (
    typeof job?.job_id !== "string" ||
    job.job_id.length === 0 ||
    typeof job?.backup_id !== "string" ||
    job.backup_id.length === 0 ||
    !digestPattern.test(job?.backup_manifest_sha256 || "")
  ) {
    throw new PopupModelError("invalid_clone_confirmation");
  }
  return {
    jobId: job.job_id,
    confirmation: {
      backupId: job.backup_id,
      manifestSHA256: job.backup_manifest_sha256,
    },
  };
}

export function buildRestoreConfirmation(job) {
  const values = [
    job?.restore_source_backup_id,
    job?.restore_source_manifest_sha256,
    job?.restore_recovery_backup_id,
    job?.restore_recovery_manifest_sha256,
  ];
  if (
    typeof job?.job_id !== "string" ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    !digestPattern.test(job.restore_source_manifest_sha256) ||
    !digestPattern.test(job.restore_recovery_manifest_sha256) ||
    job.restore_source_backup_id === job.restore_recovery_backup_id
  ) {
    throw new PopupModelError("invalid_restore_confirmation");
  }
  return {
    jobId: job.job_id,
    confirmation: {
      restoreSourceBackupId: job.restore_source_backup_id,
      restoreSourceManifestSHA256: job.restore_source_manifest_sha256,
      restoreRecoveryBackupId: job.restore_recovery_backup_id,
      restoreRecoveryManifestSHA256: job.restore_recovery_manifest_sha256,
    },
  };
}

function numeric(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function syncResultRows(job = {}) {
  const categories = job.sync_results || job.result?.categories || {};
  const explicitlySelected = Array.isArray(job.result?.selected_categories)
    ? job.result.selected_categories
    : Object.keys(categories);
  const selected = new Set(explicitlySelected.filter((id) => categoryOrder.includes(id)));
  return categoryOrder.map((id) => {
    const result = categories[id];
    const errorCode =
      typeof result?.error_code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(result.error_code)
        ? result.error_code
        : "";
    return Object.freeze({
      id,
      label: CATEGORY_LABELS[id],
      status: result?.status === "success" || result?.status === "failed"
        ? result.status
        : selected.has(id)
          ? "not_reported"
          : "not_selected",
      applied: numeric(result?.applied),
      skipped: numeric(result?.skipped),
      failed: numeric(result?.failed),
      errorCode,
    });
  });
}

export function formatJobResult(job = {}) {
  const categories = job.sync_results || job.result?.categories || {};
  let applied = 0;
  let skipped = 0;
  let failed = 0;
  for (const result of Object.values(categories)) {
    if (!result || typeof result !== "object") continue;
    applied += numeric(result.applied);
    skipped += numeric(result.skipped);
    failed += numeric(result.failed);
  }
  if (Object.keys(categories).length > 0) {
    return `Applied ${applied}; skipped ${skipped}; failed ${failed}.`;
  }
  switch (job.state) {
    case "COMPLETE":
      return job.result?.operation === "restore" ? "Restore complete." : "Clone complete.";
    case "COMPLETE_WITH_ACCEPTED_OMISSIONS":
      return "Completed with explicitly accepted omissions.";
    case "ROLLED_BACK":
      return "The operation failed and the verified local backup was restored.";
    case "ROLLBACK_INCOMPLETE":
      return "Rollback is incomplete. Keep both backups and review recovery details.";
    case "FAILED_BEFORE_MUTATION":
      return `Stopped before local mutation (${job.error_code || "preflight_failed"}).`;
    default:
      return `Current state: ${job.state || "unknown"}.`;
  }
}
