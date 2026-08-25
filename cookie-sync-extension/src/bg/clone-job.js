import canonicalize from "../lib/canonicalize.js";
import {
  BackupError,
  confirmFreshnessAndPromote,
  readBackupCategory,
  stageDestinationBackup,
  verifyStagedBackup,
} from "./backup.js";
import { resolveSnapshot as resolveSnapshotFromServer } from "./snapshot-client.js";
import { cookieIdentity, cookieWriteIntent, historyIdentity, normalizeComparableURL } from "../lib/identity.js";
import { preflightSnapshot } from "../lib/planners.js";
import { bookmarkRootAssignments, unwrapBookmarkRoots } from "../lib/bookmark-roots.js";

export const CLONE_STATE_SEQUENCE = Object.freeze([
  "FETCHING",
  "VALIDATING_SCHEMA_AND_DIGESTS",
  "PREFLIGHTING_REPRESENTABILITY",
  "BACKING_UP",
  "VERIFYING_BACKUP",
  "AWAITING_DESTRUCTIVE_CONFIRMATION",
  "RECHECKING_DESTINATION_DIGESTS",
  "PROMOTING_BACKUP",
  "APPLYING_COOKIES",
  "APPLYING_HISTORY",
  "APPLYING_BOOKMARKS",
  "APPLYING_DOWNLOAD_ARCHIVE",
  "APPLYING_TABS",
  "VERIFYING_DESTINATION",
]);

const terminalStates = new Set([
  "COMPLETE",
  "COMPLETE_WITH_ACCEPTED_OMISSIONS",
  "ROLLED_BACK",
  "FAILED_BEFORE_MUTATION",
  "ROLLBACK_INCOMPLETE",
]);

export class CloneJobError extends Error {
  constructor(code) {
    super("ShadowLink Clone operation failed");
    this.name = "CloneJobError";
    this.code = code;
  }
}

function cloneError(code) {
  return new CloneJobError(code);
}

function safeCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : fallback;
}

function isWorkerTermination(error) {
  return error?.code === "worker_terminated";
}

async function transition(db, jobId, state, patch = {}, now = Date.now()) {
  return db.updateJob(jobId, (job) => {
    if (!Array.isArray(job.state_history)) job.state_history = [];
    if (job.state_history.at(-1) !== state) job.state_history.push(state);
    job.state = state;
    Object.assign(job, structuredClone(patch));
    job.updated_at = now;
    return job;
  });
}

async function finishJob(db, jobId, state, patch, now) {
  return db.updateJob(jobId, (job) => {
    if (!Array.isArray(job.state_history)) job.state_history = [];
    if (job.state_history.at(-1) !== state) job.state_history.push(state);
    job.state = state;
    Object.assign(job, structuredClone(patch || {}));
    delete job.credentials;
    delete job.clone_snapshot;
    delete job.clone_plan;
    delete job.current_intent;
    delete job.phase_cursor;
    job.updated_at = now;
    return job;
  });
}

function normalizeCloneRequest(request) {
  const credentials = request?.credentials || {
    username: request?.username,
    password: request?.password,
  };
  if (
    typeof request?.jobId !== "string" ||
    request.jobId.length === 0 ||
    typeof request?.serverOrigin !== "string" ||
    request.serverOrigin.length === 0 ||
    typeof credentials?.username !== "string" ||
    credentials.username.length === 0 ||
    typeof credentials?.password !== "string" ||
    credentials.password.length === 0
  ) {
    throw cloneError("invalid_clone_request");
  }
  return {
    jobId: request.jobId,
    serverOrigin: request.serverOrigin,
    credentials: { username: credentials.username, password: credentials.password },
    acceptedOmissions: request.acceptedOmissions === true,
  };
}

async function enumeratePreflightDestination(deps) {
  const store = await deps.adapters.getCurrentRegularCookieStore();
  const [cookies, history, bookmarkTree, tabs, historyArchive, downloadArchive] = await Promise.all([
    deps.adapters.enumerateCookies(store.id),
    deps.adapters.enumerateHistory({ startTime: 0, endTime: deps.now() }),
    deps.adapters.enumerateBookmarks(),
    deps.adapters.enumerateTabs({ currentWindow: true }),
    deps.db.readActiveArchive("history"),
    deps.db.readActiveArchive("downloads"),
  ]);
  return {
    regularStoreId: store.id,
    existing: {
      cookies,
      history,
      historyArchive: historyArchive.records,
      bookmarks: unwrapBookmarkRoots(bookmarkTree),
      downloads: downloadArchive.records,
      tabs,
    },
  };
}

function firstBlockReason(preflight) {
  const priority = [
    "sensor_snapshot_upgrade_required",
    "snapshot_field_missing",
    "snapshot_legacy_only",
    "history_truncated",
    "snapshot_too_large",
    "snapshot_digest_mismatch",
    "unsupported_snapshot_schema",
    "history_window_incomplete",
    "unsupported_clone_items",
    "invalid_snapshot_item",
  ];
  return priority.find((reason) => preflight.reasons.includes(reason)) || preflight.reasons[0] || "unsupported_clone_items";
}

function snapshotSummary(snapshot) {
  return {
    source: snapshot.source,
    capture_started_at: snapshot.capture_started_at || "",
    capture_completed_at: snapshot.capture_completed_at || "",
    fallback_reason: snapshot.fallback_reason || "",
    history_coverage: snapshot.history_coverage || "",
    history_truncated: snapshot.history_truncated === true,
    fields: Object.fromEntries(
      Object.entries(snapshot.fields || {}).map(([category, field]) => [
        category,
        {
          available: field?.available === true,
          legacy: field?.legacy === true,
          count: Number.isSafeInteger(field?.count) ? field.count : 0,
          byte_length: Number.isSafeInteger(field?.byte_length) ? field.byte_length : 0,
        },
      ]),
    ),
  };
}

export async function prepareCloneJob(request, dependencies = {}) {
  const normalized = normalizeCloneRequest(request);
  const deps = {
    ...dependencies,
    now: dependencies.now || (() => Date.now()),
    randomUUID:
      dependencies.randomUUID || globalThis.crypto?.randomUUID?.bind(globalThis.crypto),
  };
  const resolver = dependencies.resolveSnapshot || resolveSnapshotFromServer;
  if (!deps.db || !deps.adapters || typeof resolver !== "function" || typeof deps.randomUUID !== "function") {
    throw cloneError("invalid_clone_dependencies");
  }
  const existing = await deps.db.initializeCloneJob(
    normalized.jobId,
    normalized.credentials,
    {
      server_origin: normalized.serverOrigin,
      accepted_omissions: normalized.acceptedOmissions,
    },
    deps.now(),
  );
  if (existing.state !== "FETCHING") return existing;

  let snapshot;
  try {
    snapshot = await resolver(
      {
        jobId: normalized.jobId,
        serverOrigin: normalized.serverOrigin,
        username: normalized.credentials.username,
        password: normalized.credentials.password,
        historyRange: "all",
        preferLive: true,
      },
      { ...dependencies, db: deps.db },
    );
  } catch (error) {
    return finishJob(
      deps.db,
      normalized.jobId,
      "FAILED_BEFORE_MUTATION",
      { error_code: safeCode(error, "snapshot_transport_error") },
      deps.now(),
    );
  }

  await transition(
    deps.db,
    normalized.jobId,
    "VALIDATING_SCHEMA_AND_DIGESTS",
    {
      snapshot_id: snapshot.snapshot_id,
      snapshot_source: snapshot.source,
      snapshot_summary: snapshotSummary(snapshot),
    },
    deps.now(),
  );
  await transition(deps.db, normalized.jobId, "PREFLIGHTING_REPRESENTABILITY", {}, deps.now());
  let destination;
  let preflight;
  try {
    destination = await enumeratePreflightDestination(deps);
    preflight = preflightSnapshot("clone", snapshot, {
      regularStoreId: destination.regularStoreId,
      supportsPartitionKey: deps.supportsPartitionKey !== false,
      currentWindowId: deps.currentWindowId,
      writableRoots: deps.writableRoots || {},
      existing: destination.existing,
      acceptedOmissions: normalized.acceptedOmissions,
    });
  } catch (error) {
    return finishJob(
      deps.db,
      normalized.jobId,
      "FAILED_BEFORE_MUTATION",
      { error_code: safeCode(error, "invalid_snapshot_item") },
      deps.now(),
    );
  }
  if (preflight.blocked) {
    return finishJob(
      deps.db,
      normalized.jobId,
      "FAILED_BEFORE_MUTATION",
      {
        error_code: firstBlockReason(preflight),
        unsupported: preflight.unsupported,
        invalid: preflight.invalid,
      },
      deps.now(),
    );
  }
  await deps.db.updateJob(normalized.jobId, (job) => {
    job.clone_snapshot = structuredClone(snapshot);
    job.clone_plan = structuredClone(preflight.plans);
    job.unsupported = structuredClone(preflight.unsupported);
    job.accepted_omissions = normalized.acceptedOmissions;
    job.destination_window_id = deps.currentWindowId;
    job.writable_roots = structuredClone(deps.writableRoots || {});
    job.updated_at = deps.now();
    return job;
  });

  await transition(deps.db, normalized.jobId, "BACKING_UP", {}, deps.now());
  let staged;
  try {
    staged = await stageDestinationBackup(
      { purpose: "clone" },
      {
        ...deps,
        cookieEnumerationComplete: deps.cookieEnumerationComplete !== false,
      },
    );
  } catch (error) {
    return finishJob(
      deps.db,
      normalized.jobId,
      "FAILED_BEFORE_MUTATION",
      { error_code: safeCode(error, "backup_write_failed") },
      deps.now(),
    );
  }
  await transition(
    deps.db,
    normalized.jobId,
    "VERIFYING_BACKUP",
    { backup_id: staged.backup_id },
    deps.now(),
  );
  let verified;
  try {
    verified = await verifyStagedBackup(staged.backup_id, { db: deps.db, now: deps.now });
  } catch (error) {
    return finishJob(
      deps.db,
      normalized.jobId,
      "FAILED_BEFORE_MUTATION",
      { backup_id: staged.backup_id, error_code: safeCode(error, "backup_verify_failed") },
      deps.now(),
    );
  }
  return transition(
    deps.db,
    normalized.jobId,
    "AWAITING_DESTRUCTIVE_CONFIRMATION",
    {
      backup_id: staged.backup_id,
      backup_manifest_sha256: verified.manifest_sha256,
      unsupported: preflight.unsupported,
      confirmation_required: true,
    },
    deps.now(),
  );
}

async function fault(deps, point, event) {
  if (typeof deps.faultInjector === "function") await deps.faultInjector(point, event);
}

async function journaledIntent(jobId, phase, index, operation, payload, action, recheck, deps) {
  const intentId = `${phase}:${index}:${operation}`;
  let job = await deps.db.getJob(jobId);
  let recovering =
    job.current_intent?.intent_id === intentId && job.current_intent?.status === "started";
  if (!recovering) {
    job = await deps.db.updateJob(jobId, (current) => {
      current.current_intent = {
        intent_id: intentId,
        phase,
        index,
        operation,
        payload: structuredClone(payload),
        status: "started",
        started_at: deps.now(),
      };
      current.phase_cursor = { phase, index };
      current.updated_at = deps.now();
      return current;
    });
    await fault(deps, "after_intent", { phase, index, operation, intent: job.current_intent });
  }

  let observed;
  if (recovering && typeof recheck === "function" && (await recheck())) {
    observed = { ok: true, recovered: true };
  } else {
    const value = await action();
    observed = {
      ok: true,
      ...(value && typeof value === "object" && (typeof value.id === "string" || Number.isSafeInteger(value.id))
        ? { id: value.id }
        : {}),
    };
    await fault(deps, "after_effect", { phase, index, operation, intent: job.current_intent, observed });
  }
  await deps.db.updateJob(jobId, (current) => {
    current.current_intent = {
      ...(current.current_intent || { intent_id: intentId, phase, index, operation }),
      status: "completed",
      observed,
      completed_at: deps.now(),
    };
    current.phase_cursor = { phase, index: index + 1 };
    current.updated_at = deps.now();
    return current;
  });
  await deps.heartbeat?.();
  return observed;
}

function cookieReadParams(params) {
  return {
    url: params.url,
    name: params.name,
    storeId: params.storeId,
    ...(params.partitionKey ? { partitionKey: params.partitionKey } : {}),
  };
}

async function applyCookies(job, deps) {
  const plan = job.clone_plan.cookies;
  const operations = [
    ...plan.remove.map((intent) => ({ kind: "remove", intent })),
    ...plan.set.map((intent) => ({ kind: "set", intent })),
  ];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.kind === "remove") {
      await journaledIntent(
        job.job_id,
        "APPLYING_COOKIES",
        index,
        "cookie_remove",
        operation.intent,
        () => deps.adapters.removeCookie(operation.intent.params),
        async () => (await deps.adapters.readCookie(operation.intent.params)) === null,
        deps,
      );
    } else {
      await journaledIntent(
        job.job_id,
        "APPLYING_COOKIES",
        index,
        "cookie_set",
        operation.intent,
        () => deps.adapters.setCookie(operation.intent.params),
        async () => {
          const cookie = await deps.adapters.readCookie(cookieReadParams(operation.intent.params));
          return cookie?.value === operation.intent.params.value;
        },
        deps,
      );
    }
  }
}

async function resetRestartablePhase(jobId, phase, deps) {
  await deps.db.updateJob(jobId, (job) => {
    job.current_intent = undefined;
    job.phase_cursor = { phase, index: 0 };
    job.restart_counts = job.restart_counts || {};
    job.restart_counts[phase] = (job.restart_counts[phase] || 0) + 1;
    return job;
  });
}

async function applyHistory(job, deps, recovering) {
  if (recovering) await resetRestartablePhase(job.job_id, "APPLYING_HISTORY", deps);
  const plan = job.clone_plan.history;
  await journaledIntent(
    job.job_id,
    "APPLYING_HISTORY",
    0,
    "history_delete_all",
    {},
    () => deps.adapters.deleteAllHistory(),
    null,
    deps,
  );
  let index = 1;
  for (const intent of plan.native_add) {
    await journaledIntent(
      job.job_id,
      "APPLYING_HISTORY",
      index++,
      "history_add_url",
      intent,
      () => deps.adapters.addHistoryUrl(intent.url),
      null,
      deps,
    );
  }
  await journaledIntent(
    job.job_id,
    "APPLYING_HISTORY",
    index,
    "history_archive_replace",
    { snapshot_id: job.snapshot_id, count: plan.archive_records.length },
    () =>
      deps.db.replaceActiveArchive("history", plan.archive_records, {
        archiveId: `clone-history-${job.job_id}`,
        createdAt: deps.now(),
        sourceSnapshotId: job.snapshot_id,
        source: "clone",
      }),
    async () => {
      const active = await deps.db.readActiveArchive("history");
      return (
        active.source_snapshot_id === job.snapshot_id &&
        canonicalize(active.records) === canonicalize(plan.archive_records)
      );
    },
    deps,
  );
}

function findRoot(tree, id) {
  const roots = unwrapBookmarkRoots(tree);
  return roots.find((root) => root?.id === id);
}

async function bookmarkClearIntents(deps) {
  const tree = await deps.adapters.enumerateBookmarks();
  const result = [];
  for (const [logical, rootID] of Object.entries(deps.writableRoots || {})) {
    const root = findRoot(tree, rootID);
    if (!root || !Array.isArray(root.children)) throw cloneError("bookmark_write_failed");
    for (const child of root.children) result.push({ logical, target_id: child.id });
  }
  return result;
}

async function applyBookmarks(job, deps, recovering) {
  if (recovering) {
    // Re-establish a complete, known bookmark baseline before replaying a
    // phase whose last remove/create result may have been lost with the old
    // worker. This helper is itself restartable: another interruption leaves
    // the durable job in APPLYING_BOOKMARKS and recovery repeats from backup.
    const backup = await readBackupCategory(deps.db, job.backup_id, "bookmarks");
    await clearAndCreateBookmarks(backup, deps);
    await resetRestartablePhase(job.job_id, "APPLYING_BOOKMARKS", deps);
  }
  const clear = await bookmarkClearIntents(deps);
  let index = 0;
  for (const intent of clear) {
    await journaledIntent(
      job.job_id,
      "APPLYING_BOOKMARKS",
      index++,
      "bookmark_remove_tree",
      intent,
      () => deps.adapters.removeBookmarkTree(intent.target_id),
      null,
      deps,
    );
  }
  const created = new Map();
  for (const intent of job.clone_plan.bookmarks.create) {
    const parentId =
      intent.parent?.target_id ||
      (intent.parent?.temp_ref ? created.get(intent.parent.temp_ref) : undefined);
    if (typeof parentId !== "string") throw cloneError("bookmark_write_failed");
    const observed = await journaledIntent(
      job.job_id,
      "APPLYING_BOOKMARKS",
      index++,
      "bookmark_create",
      intent,
      () => deps.adapters.createBookmark({ parentId, ...intent.node }),
      null,
      deps,
    );
    if (observed.id === undefined) throw cloneError("bookmark_write_failed");
    created.set(intent.temp_ref, String(observed.id));
  }
}

async function applyDownloadArchive(job, deps) {
  const plan = job.clone_plan.downloads;
  await journaledIntent(
    job.job_id,
    "APPLYING_DOWNLOAD_ARCHIVE",
    0,
    "download_archive_replace",
    { snapshot_id: job.snapshot_id, count: plan.archive_records.length },
    () =>
      deps.db.replaceActiveArchive("downloads", plan.archive_records, {
        archiveId: `clone-downloads-${job.job_id}`,
        createdAt: deps.now(),
        sourceSnapshotId: job.snapshot_id,
        source: "clone",
      }),
    async () => {
      const active = await deps.db.readActiveArchive("downloads");
      return (
        active.source_snapshot_id === job.snapshot_id &&
        canonicalize(active.records) === canonicalize(plan.archive_records)
      );
    },
    deps,
  );
}

async function setTabJournal(jobId, updater, deps) {
  return deps.db.updateJob(jobId, (job) => {
    job.tab_journal = job.tab_journal || { old_ids: [], created: [] };
    updater(job.tab_journal);
    return job;
  });
}

async function removeTabNavigationHistorySideEffects(job, deps, startIndex) {
  const expected = new Set(
    job.clone_plan.history.native_add.map((intent) => historyIdentity({ url: intent.url })),
  );
  const unexpectedByIdentity = new Map();
  const history = await deps.adapters.enumerateHistory({ startTime: 0, endTime: deps.now() });
  for (const item of history) {
    const identity = historyIdentity(item);
    if (!expected.has(identity)) unexpectedByIdentity.set(identity, item.url);
  }
  const unexpected = Array.from(unexpectedByIdentity.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  let index = startIndex;
  for (const [identity, url] of unexpected) {
    await journaledIntent(
      job.job_id,
      "APPLYING_TABS",
      index++,
      "history_delete_tab_side_effect",
      { identity, url },
      () => deps.adapters.deleteHistoryUrl(url),
      async () =>
        !(await deps.adapters.enumerateHistory({ startTime: 0, endTime: deps.now() }))
          .some((item) => historyIdentity(item) === identity),
      deps,
    );
  }
}

async function applyTabs(job, deps, recovering) {
  if (recovering) {
    await resetRestartablePhase(job.job_id, "APPLYING_TABS", deps);
    const current = await deps.adapters.enumerateTabs({ currentWindow: true });
    let safe = current.find((tab) => tab.url === "about:blank");
    if (!safe) safe = await deps.adapters.createTab({ windowId: deps.currentWindowId, url: "about:blank", active: false });
    const remove = current.filter((tab) => tab.id !== safe.id).map((tab) => tab.id);
    if (remove.length) await deps.adapters.removeTabs(remove);
    await deps.db.updateJob(job.job_id, (record) => {
      record.tab_journal = { old_ids: remove, safe_tab_id: safe.id, created: [] };
      return record;
    });
  }
  let fresh = await deps.db.getJob(job.job_id);
  if (!fresh.tab_journal) {
    const current = await deps.adapters.enumerateTabs({ currentWindow: true });
    await setTabJournal(
      job.job_id,
      (journal) => {
        journal.old_ids = current.map((tab) => tab.id);
      },
      deps,
    );
    fresh = await deps.db.getJob(job.job_id);
  }
  let index = 0;
  if (!fresh.tab_journal.safe_tab_id) {
    const observed = await journaledIntent(
      job.job_id,
      "APPLYING_TABS",
      index++,
      "tab_create_safe",
      { windowId: deps.currentWindowId, url: "about:blank" },
      () => deps.adapters.createTab({ windowId: deps.currentWindowId, url: "about:blank", active: false }),
      null,
      deps,
    );
    await setTabJournal(job.job_id, (journal) => (journal.safe_tab_id = observed.id), deps);
  } else {
    index += 1;
  }
  const created = new Map();
  const refreshed = await deps.db.getJob(job.job_id);
  for (const entry of refreshed.tab_journal.created || []) created.set(entry.source_index, entry.tab_id);
  for (const intent of job.clone_plan.tabs.create) {
    if (created.has(intent.source_index)) {
      index += 1;
      continue;
    }
    const observed = await journaledIntent(
      job.job_id,
      "APPLYING_TABS",
      index++,
      "tab_create_source",
      intent,
      () => deps.adapters.createTab(intent.create_properties),
      null,
      deps,
    );
    created.set(intent.source_index, observed.id);
    await setTabJournal(
      job.job_id,
      (journal) => journal.created.push({ source_index: intent.source_index, tab_id: observed.id }),
      deps,
    );
  }
  fresh = await deps.db.getJob(job.job_id);
  for (const oldID of fresh.tab_journal.old_ids || []) {
    await journaledIntent(
      job.job_id,
      "APPLYING_TABS",
      index++,
      "tab_remove_old",
      { tab_id: oldID },
      () => deps.adapters.removeTabs(oldID),
      async () => !(await deps.adapters.enumerateTabs({ currentWindow: true })).some((tab) => tab.id === oldID),
      deps,
    );
  }
  const activeSource = job.clone_plan.tabs.activate?.source_index;
  if (activeSource !== undefined) {
    const tabID = created.get(activeSource);
    if (tabID === undefined) throw cloneError("supported_item_write_failed");
    await journaledIntent(
      job.job_id,
      "APPLYING_TABS",
      index++,
      "tab_activate",
      { tab_id: tabID },
      () => deps.adapters.updateTab(tabID, { active: true }),
      async () => (await deps.adapters.enumerateTabs({ currentWindow: true })).some((tab) => tab.id === tabID && tab.active),
      deps,
    );
  }
  fresh = await deps.db.getJob(job.job_id);
  const safeID = fresh.tab_journal.safe_tab_id;
  if (safeID !== undefined) {
    await journaledIntent(
      job.job_id,
      "APPLYING_TABS",
      index,
      "tab_remove_safe",
      { tab_id: safeID },
      () => deps.adapters.removeTabs(safeID),
      async () => !(await deps.adapters.enumerateTabs({ currentWindow: true })).some((tab) => tab.id === safeID),
      deps,
    );
    index += 1;
  }
  // chrome.tabs.create() records the opened source tabs in native history.
  // Clone applies history before tabs, so remove only URLs that were introduced
  // by tab replay and are absent from the immutable source history snapshot.
  await removeTabNavigationHistorySideEffects(job, deps, index);
}

function normalizedBookmarkNode(node) {
  if (typeof node.url === "string") return { title: node.title, url: node.url };
  return { title: node.title, children: (node.children || []).map(normalizedBookmarkNode) };
}

function logicalBookmarkTrees(tree, writableRoots) {
  const roots = unwrapBookmarkRoots(tree);
  return Object.entries(writableRoots)
    .map(([logical, id]) => {
      const root = roots.find((item) => item.id === id);
      return { root: logical, children: (root?.children || []).map(normalizedBookmarkNode) };
    })
    .sort((left, right) => left.root.localeCompare(right.root));
}

function logicalSourceBookmarkTrees(tree) {
  const roots = unwrapBookmarkRoots(tree);
  return bookmarkRootAssignments(tree)
    .map((assignment) => ({
      root: assignment.logical,
      children: (roots[assignment.index]?.children || []).map(normalizedBookmarkNode),
    }))
    .sort((left, right) => left.root.localeCompare(right.root));
}

async function defaultVerifyDestination(job, deps) {
  const store = await deps.adapters.getCurrentRegularCookieStore();
  const cookies = await deps.adapters.enumerateCookies(store.id);
  const expectedCookies = new Map(
    job.clone_plan.cookies.set.map((intent) => [intent.identity, intent.params.value]),
  );
  const actualCookies = new Map(cookies.map((cookie) => [cookieIdentity(cookie, store.id), cookie.value]));
  if (canonicalize(Object.fromEntries(actualCookies)) !== canonicalize(Object.fromEntries(expectedCookies))) {
    throw cloneError("destination_verify_failed");
  }
  const history = await deps.adapters.enumerateHistory({ startTime: 0, endTime: deps.now() });
  const expectedHistory = job.clone_plan.history.native_add.map((intent) => historyIdentity({ url: intent.url })).sort();
  const actualHistory = history.map(historyIdentity).sort();
  if (canonicalize(actualHistory) !== canonicalize(expectedHistory)) throw cloneError("destination_verify_failed");
  const historyArchive = await deps.db.readActiveArchive("history");
  if (canonicalize(historyArchive.records) !== canonicalize(job.clone_plan.history.archive_records)) {
    throw cloneError("destination_verify_failed");
  }
  const bookmarks = logicalBookmarkTrees(await deps.adapters.enumerateBookmarks(), deps.writableRoots || {});
  const expectedBookmarks = logicalSourceBookmarkTrees(job.clone_snapshot.categories.bookmarks);
  if (canonicalize(bookmarks) !== canonicalize(expectedBookmarks)) throw cloneError("destination_verify_failed");
  const downloads = await deps.db.readActiveArchive("downloads");
  if (canonicalize(downloads.records) !== canonicalize(job.clone_plan.downloads.archive_records)) {
    throw cloneError("destination_verify_failed");
  }
  const tabs = (await deps.adapters.enumerateTabs({ currentWindow: true }))
    .sort((left, right) => left.index - right.index)
    .map((tab) => ({ url: normalizeComparableURL(tab.url), pinned: tab.pinned, active: tab.active }));
  const activeSource = job.clone_plan.tabs.activate?.source_index;
  const expectedTabs = job.clone_plan.tabs.create.map((intent) => ({
    url: normalizeComparableURL(intent.create_properties.url),
    pinned: intent.create_properties.pinned,
    active: intent.source_index === activeSource,
  }));
  if (canonicalize(tabs) !== canonicalize(expectedTabs)) throw cloneError("destination_verify_failed");
  return true;
}

async function clearAndCreateBookmarks(records, deps) {
  const clear = await bookmarkClearIntents(deps);
  for (const item of clear) await deps.adapters.removeBookmarkTree(item.target_id);
  const created = new Map();
  let sequence = 0;
  const recurse = async (nodes, parentId) => {
    for (const node of nodes) {
      const result = await deps.adapters.createBookmark({
        parentId,
        title: node.title,
        ...(node.url ? { url: node.url } : {}),
      });
      created.set(sequence++, result.id);
      if (node.children) await recurse(node.children, result.id);
    }
  };
  for (const root of records.roots) {
    const rootID = deps.writableRoots[root.root];
    if (!rootID) throw cloneError("bookmark_write_failed");
    await recurse(root.children, rootID);
  }
}

async function restoreTabs(records, deps) {
  const safe = await deps.adapters.createTab({ windowId: deps.currentWindowId, url: "about:blank", active: false });
  const current = await deps.adapters.enumerateTabs({ currentWindow: true });
  const remove = current.filter((tab) => tab.id !== safe.id).map((tab) => tab.id);
  if (remove.length) await deps.adapters.removeTabs(remove);
  const created = [];
  for (const tab of records.items) {
    created.push(
      await deps.adapters.createTab({
        windowId: deps.currentWindowId,
        url: tab.url,
        index: tab.index,
        pinned: tab.pinned,
        active: false,
      }),
    );
  }
  const activeIndex = records.items.findIndex((tab) => tab.active);
  if (activeIndex >= 0) await deps.adapters.updateTab(created[activeIndex].id, { active: true });
  await deps.adapters.removeTabs(safe.id);
}

export async function rollbackCloneJob(jobId, deps, cause) {
  let job = await deps.db.updateJob(jobId, (record) => {
    record.rollback_required = true;
    record.rollback_backup_id = record.backup_id;
    if (record.state_history.at(-1) !== "ROLLING_BACK") record.state_history.push("ROLLING_BACK");
    record.state = "ROLLING_BACK";
    record.error_code = safeCode(cause, "supported_item_write_failed");
    record.updated_at = deps.now();
    return record;
  });
  try {
    await deps.onRollbackStart?.(job);
  } catch (error) {
    if (isWorkerTermination(error)) throw error;
    return finishJob(deps.db, jobId, "ROLLBACK_INCOMPLETE", { rollback_required: true }, deps.now());
  }
  try {
    const pointers = await deps.db.getBackupPointers();
    if (pointers?.active_backup_id !== job.backup_id) throw cloneError("backup_incomplete");
    const [cookies, history, bookmarks, tabs, historyArchive, downloadArchive] = await Promise.all([
      readBackupCategory(deps.db, job.backup_id, "cookies"),
      readBackupCategory(deps.db, job.backup_id, "native_history"),
      readBackupCategory(deps.db, job.backup_id, "bookmarks"),
      readBackupCategory(deps.db, job.backup_id, "tabs"),
      readBackupCategory(deps.db, job.backup_id, "history_archive"),
      readBackupCategory(deps.db, job.backup_id, "download_archive"),
    ]);
    const store = await deps.adapters.getCurrentRegularCookieStore();
    for (const cookie of await deps.adapters.enumerateCookies(store.id)) {
      const classification = cookieWriteIntent(cookie, {
        regularStoreId: store.id,
        supportsPartitionKey: deps.supportsPartitionKey !== false,
      });
      if (classification.kind !== "supported") throw cloneError("rollback_incomplete");
      await deps.adapters.removeCookie(cookieReadParams(classification.params));
    }
    for (const cookie of cookies.items) {
      const classification = cookieWriteIntent(cookie, {
        regularStoreId: store.id,
        supportsPartitionKey: deps.supportsPartitionKey !== false,
      });
      if (classification.kind !== "supported") throw cloneError("rollback_incomplete");
      await deps.adapters.setCookie(classification.params);
    }
    await deps.adapters.deleteAllHistory();
    for (const item of history.items) await deps.adapters.addHistoryUrl(item.url);
    await clearAndCreateBookmarks(bookmarks, deps);
    await deps.db.replaceActiveArchive("history", historyArchive.records, {
      archiveId: `rollback-history-${jobId}`,
      createdAt: deps.now(),
      sourceSnapshotId: job.backup_id,
      source: "rollback",
    });
    await deps.db.replaceActiveArchive("downloads", downloadArchive.records, {
      archiveId: `rollback-downloads-${jobId}`,
      createdAt: deps.now(),
      sourceSnapshotId: job.backup_id,
      source: "rollback",
    });
    await restoreTabs(tabs, deps);
    return finishJob(
      deps.db,
      jobId,
      "ROLLED_BACK",
      {
        rollback_required: true,
        rollback_backup_id: job.backup_id,
        result: {
          state: "ROLLED_BACK",
          error_code: job.error_code,
          ...(job.kind === "restore"
            ? {
                operation: "restore",
                restore_source_backup_id: job.restore_source_backup_id,
                restore_recovery_backup_id: job.restore_recovery_backup_id,
              }
            : {}),
        },
      },
      deps.now(),
    );
  } catch (error) {
    if (isWorkerTermination(error)) throw error;
    return finishJob(
      deps.db,
      jobId,
      "ROLLBACK_INCOMPLETE",
      {
        rollback_required: true,
        rollback_backup_id: job.backup_id,
        rollback_error_code: safeCode(error, "rollback_incomplete"),
        result: { state: "ROLLBACK_INCOMPLETE" },
      },
      deps.now(),
    );
  }
}

export async function applyCloneMutation(
  jobId,
  deps,
  { recovering = false, completionPatch = {}, completionResult = {} } = {},
) {
  let job = await deps.db.getJob(jobId);
  try {
    const resumeState = recovering ? job.state : null;
    if (!recovering || resumeState === "PROMOTING_BACKUP" || resumeState === "APPLYING_COOKIES") {
      await transition(
        deps.db,
        jobId,
        "APPLYING_COOKIES",
        { mutation_started: true, rollback_required: false },
        deps.now(),
      );
      job = await deps.db.getJob(jobId);
      await applyCookies(job, deps);
    }
    if (!recovering || ["PROMOTING_BACKUP", "APPLYING_COOKIES", "APPLYING_HISTORY"].includes(resumeState)) {
      const historyRecovering = recovering && resumeState === "APPLYING_HISTORY";
      await transition(deps.db, jobId, "APPLYING_HISTORY", {}, deps.now());
      job = await deps.db.getJob(jobId);
      await applyHistory(job, deps, historyRecovering);
    }
    if (
      !recovering ||
      ["PROMOTING_BACKUP", "APPLYING_COOKIES", "APPLYING_HISTORY", "APPLYING_BOOKMARKS"].includes(resumeState)
    ) {
      const bookmarkRecovering = recovering && resumeState === "APPLYING_BOOKMARKS";
      await transition(deps.db, jobId, "APPLYING_BOOKMARKS", {}, deps.now());
      job = await deps.db.getJob(jobId);
      await applyBookmarks(job, deps, bookmarkRecovering);
    }
    if (
      !recovering ||
      [
        "PROMOTING_BACKUP",
        "APPLYING_COOKIES",
        "APPLYING_HISTORY",
        "APPLYING_BOOKMARKS",
        "APPLYING_DOWNLOAD_ARCHIVE",
      ].includes(resumeState)
    ) {
      await transition(deps.db, jobId, "APPLYING_DOWNLOAD_ARCHIVE", {}, deps.now());
      job = await deps.db.getJob(jobId);
      await applyDownloadArchive(job, deps);
    }
    if (
      !recovering ||
      [
        "PROMOTING_BACKUP",
        "APPLYING_COOKIES",
        "APPLYING_HISTORY",
        "APPLYING_BOOKMARKS",
        "APPLYING_DOWNLOAD_ARCHIVE",
        "APPLYING_TABS",
      ].includes(resumeState)
    ) {
      const tabRecovering = recovering && resumeState === "APPLYING_TABS";
      await transition(deps.db, jobId, "APPLYING_TABS", {}, deps.now());
      job = await deps.db.getJob(jobId);
      await applyTabs(job, deps, tabRecovering);
    }
    await transition(deps.db, jobId, "VERIFYING_DESTINATION", {}, deps.now());
    job = await deps.db.getJob(jobId);
    if (typeof deps.verifyDestination === "function") await deps.verifyDestination(job, deps);
    else await defaultVerifyDestination(job, deps);
    const state = job.unsupported?.length
      ? "COMPLETE_WITH_ACCEPTED_OMISSIONS"
      : "COMPLETE";
    return finishJob(
      deps.db,
      jobId,
      state,
      {
        rollback_required: false,
        result: {
          state,
          snapshot_id: job.snapshot_id,
          source: job.snapshot_source,
          unsupported: job.unsupported || [],
          ...structuredClone(completionResult),
        },
        ...structuredClone(completionPatch),
      },
      deps.now(),
    );
  } catch (error) {
    if (isWorkerTermination(error)) throw error;
    return rollbackCloneJob(jobId, deps, error);
  }
}

export async function confirmCloneJob(jobId, confirmation, dependencies = {}) {
  const deps = {
    ...dependencies,
    now: dependencies.now || (() => Date.now()),
  };
  let job = await deps.db.getJob(jobId);
  if (!job) throw cloneError("snapshot_job_not_found");
  if (
    confirmation?.backupId !== job.backup_id ||
    confirmation?.manifestSHA256 !== job.backup_manifest_sha256
  ) {
    throw new BackupError("backup_confirmation_mismatch");
  }
  if (job.state !== "AWAITING_DESTRUCTIVE_CONFIRMATION" && job.state !== "RECHECKING_DESTINATION_DIGESTS") {
    throw cloneError("invalid_clone_state");
  }
  await deps.db.updateJob(jobId, (record) => {
    record.confirmation = {
      backup_id: confirmation.backupId,
      manifest_sha256: confirmation.manifestSHA256,
      confirmed_at: deps.now(),
    };
    return record;
  });
  await transition(deps.db, jobId, "RECHECKING_DESTINATION_DIGESTS", {}, deps.now());
  const freshness = await confirmFreshnessAndPromote(
    confirmation,
    {
      ...deps,
      beforePromote: async () => {
        await transition(deps.db, jobId, "PROMOTING_BACKUP", {}, deps.now());
      },
    },
    async () => {
      await applyCloneMutation(jobId, deps);
    },
  );
  if (!freshness.fresh) {
    return transition(
      deps.db,
      jobId,
      "BACKUP_STALE",
      {
        requires_new_backup: true,
        requires_confirmation: true,
        freshness_changes: freshness.changes,
      },
      deps.now(),
    );
  }
  return deps.db.getJob(jobId);
}

export async function resumeCloneJob(jobId, dependencies = {}) {
  const deps = { ...dependencies, now: dependencies.now || (() => Date.now()) };
  const job = await deps.db.getJob(jobId);
  if (!job || terminalStates.has(job.state)) return job;
  if (job.state === "ROLLING_BACK") {
    return rollbackCloneJob(jobId, deps, cloneError(job.error_code || "job_recovery_failed"));
  }
  if (["RECHECKING_DESTINATION_DIGESTS", "PROMOTING_BACKUP"].includes(job.state)) {
    if (!job.confirmation) throw cloneError("job_recovery_failed");
    if (job.state === "PROMOTING_BACKUP") {
      const pointers = await deps.db.getBackupPointers();
      if (pointers?.active_backup_id === job.backup_id) {
        return applyCloneMutation(jobId, deps, { recovering: true });
      }
    }
    return confirmCloneJob(
      jobId,
      { backupId: job.confirmation.backup_id, manifestSHA256: job.confirmation.manifest_sha256 },
      deps,
    );
  }
  if (job.state.startsWith("APPLYING_") || job.state === "VERIFYING_DESTINATION") {
    return applyCloneMutation(jobId, deps, { recovering: true });
  }
  return job;
}
