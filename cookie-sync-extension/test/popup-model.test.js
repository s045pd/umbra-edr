import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedOmissionsNotice,
  applyButtonLoading,
  buildCloneConfirmation,
  cloneActionEnabled,
  createCloneDialogModel,
  createSyncDialogModel,
  finishOperationButton,
  formatJobResult,
  operationErrorText,
  summarizeUnsupported,
  syncCategorySelection,
  syncResultRows,
  snapshotMetadataRows,
} from "../src/browser_action/dialogs.js";
import { JobClient } from "../src/browser_action/job-client.js";
import {
  buildArchiveExport,
  buildBackupRows,
  filterArchivePage,
} from "../src/browser_action/archive-view.js";

test("popup Sync defaults to cookies only and always captures full history", () => {
  const model = createSyncDialogModel();
  assert.deepEqual(
    Object.fromEntries(model.categories.map((category) => [category.id, category.checked])),
    { cookies: true, history: false, bookmarks: false, downloads: false, tabs: false },
  );
  assert.equal(model.categories.every((category) => category.disabled === false), true);
  assert.deepEqual(model.historyRanges, []);
  assert.equal(model.historyRange, "all");
  assert.match(model.description, /full/i);
  assert.deepEqual(syncCategorySelection(true), {
    cookies: true,
    history: true,
    bookmarks: true,
    downloads: true,
    tabs: true,
  });
});

test("popup Clone is available from a cached snapshot even when the source is offline", () => {
  const model = createCloneDialogModel();
  assert.match(model.description, /replace/i);
  assert.equal(cloneActionEnabled({ id: "bot-1", is_online: true }), true);
  assert.equal(cloneActionEnabled({ id: "bot-1", is_online: false }), true);
  assert.equal(cloneActionEnabled({}), false);
  assert.match(operationErrorText("source_endpoint_offline"), /online/i);

  const btn = {
    classList: {
      tokens: new Set(),
      toggle(name, active) {
        if (active) this.tokens.add(name);
        else this.tokens.delete(name);
      },
      remove(name) {
        this.tokens.delete(name);
      },
    },
    disabled: false,
  };
  applyButtonLoading(btn, true);
  assert.equal(btn.disabled, true);
  assert.equal(btn.classList.tokens.has("loading"), true);

  btn.disabled = true;
  finishOperationButton(btn, { sameDialog: false });
  assert.equal(btn.classList.tokens.has("loading"), false);
  assert.equal(btn.disabled, true, "a later dialog keeps its own disabled flag");

  applyButtonLoading(btn, true);
  finishOperationButton(btn, { sameDialog: true });
  assert.equal(btn.classList.tokens.has("loading"), false);
  assert.equal(btn.disabled, false);
});

test("popup explains target Sensor upgrade errors instead of only printing a code", () => {
  assert.match(operationErrorText("sensor_snapshot_upgrade_required"), /update or reload.*Umbra Sensor/i);
  assert.match(operationErrorText("snapshot_field_missing"), /incomplete/i);
  assert.match(operationErrorText("endpoint_offline_no_snapshot"), /Sensor is offline/i);
  assert.match(operationErrorText("snapshot_transport_error"), /read cookies or browser data/i);
  assert.match(operationErrorText("unsupported_clone_items"), /cannot write/i);
  assert.equal(operationErrorText("unknown_failure"), "Operation stopped (unknown_failure).");
});

test("popup groups unsupported Clone items by category and reason", () => {
  assert.deepEqual(summarizeUnsupported(), []);
  assert.deepEqual(
    summarizeUnsupported([
      { category: "tabs", reason: "restricted_tab_url" },
      { category: "tabs", reason: "restricted_tab_url" },
      { category: "cookies", reason: "cookie_expired" },
      { reason: "ignored" },
    ]),
    [
      { category: "tabs", reason: "restricted_tab_url", count: 2 },
      { category: "cookies", reason: "cookie_expired", count: 1 },
    ],
  );
});

test("popup Clone locks all categories and renders provenance, capture time, count, and availability", () => {
  const summary = {
    source: "cached_fallback",
    capture_completed_at: "2026-08-24T06:36:52.000Z",
    fallback_reason: "live_snapshot_timeout",
    history_coverage: "all",
    fields: {
      cookies: { available: true, legacy: false, count: 2 },
      history: { available: true, legacy: false, count: 3 },
      bookmarks: { available: false, legacy: false, count: 0 },
      downloads: { available: true, legacy: true, count: 1 },
      tabs: { available: true, legacy: false, count: 4 },
    },
  };
  const model = createCloneDialogModel({ snapshot_summary: summary, state: "FAILED_BEFORE_MUTATION" });
  assert.equal(model.categories.every((category) => category.checked && category.disabled), true);
  assert.equal(model.sourceLabel, "Cached fallback");
  assert.equal(model.captureTime, summary.capture_completed_at);
  assert.equal(model.fallbackReason, "live_snapshot_timeout");
  const rows = snapshotMetadataRows(summary);
  assert.deepEqual(rows.map((row) => row.count), [2, 3, 0, 1, 4]);
  assert.equal(rows.find((row) => row.id === "bookmarks").status, "Missing");
  assert.equal(rows.find((row) => row.id === "downloads").status, "Legacy only");
  assert.equal(model.normalCloneEnabled, false);
});

test("unsupported normal Clone is disabled and accepted omissions wording is explicit", () => {
  const job = {
    state: "AWAITING_DESTRUCTIVE_CONFIRMATION",
    unsupported: [{ category: "tabs", reason: "restricted_tab_url" }],
    accepted_omissions: false,
    snapshot_summary: { source: "cached", fields: {} },
  };
  const normal = createCloneDialogModel(job);
  assert.equal(normal.normalCloneEnabled, false);
  assert.equal(normal.confirmLabel, "Clone unavailable");
  const accepted = createCloneDialogModel({ ...job, accepted_omissions: true });
  assert.equal(accepted.normalCloneEnabled, true);
  assert.match(accepted.confirmLabel, /accepted omissions/i);
  assert.match(acceptedOmissionsNotice(job.unsupported), /COMPLETE_WITH_ACCEPTED_OMISSIONS/);
  assert.match(acceptedOmissionsNotice(job.unsupported), /tabs/i);
});

test("destructive Clone confirmation carries the exact staged backup ID and digest", () => {
  const job = {
    job_id: "clone-popup",
    backup_id: "backup-popup",
    backup_manifest_sha256: "a".repeat(64),
  };
  assert.deepEqual(buildCloneConfirmation(job), {
    jobId: "clone-popup",
    confirmation: {
      backupId: "backup-popup",
      manifestSHA256: "a".repeat(64),
    },
  });
  assert.throws(() => buildCloneConfirmation({ ...job, backup_manifest_sha256: "bad" }), {
    code: "invalid_clone_confirmation",
  });
});

test("popup reopen reads durable background state and never invokes mutation APIs", async () => {
  const messages = [];
  const chromeAPI = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback({ ok: true, result: { job_id: message.jobId, state: "COMPLETE" } });
      },
    },
    cookies: {
      set() {
        throw new Error("popup must not mutate cookies");
      },
    },
  };
  const client = new JobClient(chromeAPI);
  const job = await client.getJob("durable-job");
  assert.equal(job.state, "COMPLETE");
  assert.deepEqual(messages, [{ type: "GET_JOB", jobId: "durable-job" }]);
});

test("popup result text reports applied/skipped/failed counts without credentials or cookie values", () => {
  const job = {
    state: "sync_complete_with_errors",
    credentials: { username: "proxy-user", password: "proxy-secret" },
    sync_results: {
      cookies: { status: "success", applied: 3, skipped: 1, failed: 0, raw: "cookie-secret" },
      history: { status: "failed", applied: 2, skipped: 0, failed: 1, error_code: "history_sync_failed" },
    },
  };
  const text = formatJobResult(job);
  assert.match(text, /Applied 5/);
  assert.match(text, /skipped 1/i);
  assert.match(text, /failed 1/i);
  assert.equal(text.includes("proxy-secret"), false);
  assert.equal(text.includes("cookie-secret"), false);

  const rows = syncResultRows({
    ...job,
    result: { selected_categories: ["cookies", "history"] },
  });
  assert.deepEqual(
    rows.map((row) => [row.id, row.status, row.errorCode]),
    [
      ["cookies", "success", ""],
      ["history", "failed", "history_sync_failed"],
      ["bookmarks", "not_selected", ""],
      ["downloads", "not_selected", ""],
      ["tabs", "not_selected", ""],
    ],
  );
  assert.equal(JSON.stringify(rows).includes("cookie-secret"), false);
});

test("archive tools summarize backups, search/page records, and export deterministic JSON", () => {
  const manifests = [
    {
      backup_id: "backup-active",
      state: "active",
      verified: true,
      created_at: 20,
      purpose: "restore_recovery",
      categories: { cookies: { count: 2 }, native_history: { count: 3 } },
    },
    {
      backup_id: "backup-previous",
      state: "previous",
      verified: true,
      created_at: 10,
      purpose: "clone",
      categories: { cookies: { count: 1 }, native_history: { count: 1 } },
    },
  ];
  const rows = buildBackupRows(manifests, { undoRestoreBackupId: "backup-active" });
  assert.equal(rows[0].isUndoRestore, true);
  assert.equal(rows[0].totalCount, 5);
  assert.equal(rows[0].canDelete, false);
  assert.equal(rows[1].canRestore, true);

  const records = [
    { url: "https://alpha.example/", title: "Alpha" },
    { url: "https://bravo.example/", title: "Bravo" },
    { url: "https://alpha-two.example/", title: "Alpha Two" },
  ];
  const page = filterArchivePage(records, { query: "alpha", page: 2, pageSize: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.page, 2);
  assert.equal(page.totalPages, 2);
  assert.equal(page.records[0].title, "Alpha Two");
  const exported = buildArchiveExport("history", records, 100);
  assert.equal(exported.filename, "shadowlink-history-100.json");
  assert.deepEqual(JSON.parse(exported.json).records, records);
});
