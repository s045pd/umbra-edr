import { fetchLiveSyncSnapshot } from "./live-browser-client.js";
import {
  planBookmarkSync,
  planCookieSync,
  planDownloadArchive,
  planHistorySync,
  planTabSync,
} from "../lib/planners.js";
import { SNAPSHOT_CATEGORIES } from "../lib/constants.js";
import {
  inferWritableBookmarkRoots,
  unwrapBookmarkRoots,
} from "../lib/bookmark-roots.js";
import { cookieIdentity, cookieRemoveParams, cookiesConflict, cookieWriteIntent } from "../lib/identity.js";

const validHistoryRanges = new Set(["7", "30", "90", "all"]);
const coverageRank = Object.freeze({ "7": 1, "30": 2, "90": 3, all: 4 });

export class SyncJobError extends Error {
  constructor(code, counts = {}) {
    super("ShadowLink Sync operation failed");
    this.name = "SyncJobError";
    this.code = code;
    this.counts = counts;
  }
}

function syncError(code, counts) {
  return new SyncJobError(code, counts);
}

function safeErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : fallback;
}

export function normalizeSyncOptions(options = {}) {
  const selectedSource = options.selected || options;
  const selected = {};
  for (const category of SNAPSHOT_CATEGORIES) {
    const fallback = category === "cookies";
    const value = selectedSource[category];
    if (value !== undefined && typeof value !== "boolean") {
      throw syncError("invalid_sync_options");
    }
    selected[category] = value === undefined ? fallback : value;
  }
  return { selected, historyRange: "all" };
}

export function snapshotSourceLabel(source) {
  switch (source) {
    case "live":
      return "Live";
    case "cached":
      return "Cached";
    case "cached_fallback":
      return "Cached fallback";
    case "legacy_cached":
      return "Legacy cached";
    default:
      return "Unknown";
  }
}

function normalizeRequest(request) {
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
    throw syncError("invalid_sync_request");
  }
  return {
    jobId: request.jobId,
    serverOrigin: request.serverOrigin,
    credentials: { username: credentials.username, password: credentials.password },
    options: normalizeSyncOptions(request.options),
  };
}

function validateSelectedCategory(snapshot, category, options) {
  const field = snapshot?.fields?.[category];
  const items = snapshot?.categories?.[category];
  if (!field || field.available !== true || !Array.isArray(items)) {
    throw syncError("snapshot_field_missing");
  }
  if (!Number.isSafeInteger(field.count) || field.count !== items.length) {
    throw syncError("snapshot_digest_mismatch");
  }
  if (category === "history") {
    if (!validHistoryRanges.has(snapshot.history_coverage)) {
      throw syncError("history_window_incomplete");
    }
    if (coverageRank[snapshot.history_coverage] < coverageRank[options.historyRange]) {
      throw syncError("history_window_incomplete");
    }
    if (snapshot.history_truncated === true && options.acceptTruncatedHistory !== true) {
      throw syncError("history_truncated");
    }
  }
  return items;
}

function categoryCounts(sourceCount, applied, skipped, failed = 0) {
  return { source_count: sourceCount, applied, skipped, failed };
}

function planSkippedCount(plan, category, context, sourceCount) {
  const unsupported = plan.unsupported?.length || 0;
  const invalid = plan.invalid?.length || 0;
  if (invalid > 0 && context.snapshot?.source !== "legacy_cached") {
    throw syncError(
      "invalid_snapshot_item",
      categoryCounts(sourceCount, 0, unsupported, invalid),
    );
  }
  return unsupported + invalid;
}

function sameSiteWriteMatches(actual, intended) {
  if (actual === intended) return true;
  // Chrome may still report unspecified after a Lax write.
  return intended === "lax" && actual === "unspecified";
}

function cookieWriteMatches(intent, cookie, storeId) {
  if (!cookie || typeof cookie !== "object") return false;
  try {
    return (
      cookieIdentity(cookie, storeId) === intent.identity &&
      cookie.value === intent.params.value &&
      cookie.secure === intent.params.secure &&
      cookie.httpOnly === intent.params.httpOnly &&
      sameSiteWriteMatches(cookie.sameSite, intent.params.sameSite) &&
      cookie.session === !("expirationDate" in intent.params)
    );
  } catch {
    return false;
  }
}

function cookieReadParams(params) {
  return {
    url: params.url,
    name: params.name,
    storeId: params.storeId,
    ...(params.partitionKey ? { partitionKey: params.partitionKey } : {}),
  };
}

function cookieFromWriteParams(params) {
  return {
    name: params.name,
    domain: params.domain || new URL(params.url).hostname,
    hostOnly: !("domain" in params),
    path: params.path,
    partitionKey: params.partitionKey,
    secure: params.secure,
  };
}

async function removeConflictingDestinationCookies(sourceLikes, storeId, adapters, keepIdentities) {
  if (typeof adapters.enumerateCookies !== "function") {
    throw syncError("cookie_remove_failed");
  }
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const existing = await adapters.enumerateCookies(storeId);
    const shadow = existing.find((cookie) => {
      let identity;
      try {
        identity = cookieIdentity(cookie, storeId);
      } catch {
        return false;
      }
      if (keepIdentities.has(identity)) return false;
      return sourceLikes.some((sourceLike) => cookiesConflict(sourceLike, cookie));
    });
    if (!shadow) return;
    if (typeof adapters.removeCookie !== "function") {
      throw syncError("cookie_remove_failed");
    }
    await adapters.removeCookie(cookieRemoveParams(shadow, { regularStoreId: storeId }));
  }
  throw syncError("cookie_remove_failed");
}

async function verifyCookieWrite(intent, written, storeId, adapters) {
  if (cookieWriteMatches(intent, written, storeId)) return true;
  if (typeof adapters.readCookies !== "function") return false;
  const candidates = await adapters.readCookies(cookieReadParams(intent.params));
  return (
    Array.isArray(candidates) &&
    candidates.some((candidate) => cookieWriteMatches(intent, candidate, storeId))
  );
}

async function applyCookies(items, context) {
  const store = await context.adapters.getCurrentRegularCookieStore();
  if (!store || store.incognito === true || typeof store.id !== "string") {
    throw syncError("regular_cookie_store_unavailable");
  }
  const destination = await context.adapters.enumerateCookies(store.id);
  const plan = planCookieSync(items, destination, {
    regularStoreId: store.id,
    supportsPartitionKey: context.supportsPartitionKey,
    nowSeconds: context.requestedAt / 1000,
  });
  const skipped = planSkippedCount(plan, "cookies", context, items.length);
  let applied = 0;
  const keepIdentities = new Set(plan.set.map((intent) => intent.identity));
  for (const intent of plan.remove) {
    try {
      if (typeof context.adapters.removeCookie !== "function") {
        throw syncError("cookie_remove_failed");
      }
      await context.adapters.removeCookie(intent.params);
    } catch (error) {
      throw syncError(
        safeErrorCode(error, "cookie_remove_failed"),
        categoryCounts(items.length, applied, skipped, 1),
      );
    }
  }
  try {
    await removeConflictingDestinationCookies(
      plan.set.map((intent) => cookieFromWriteParams(intent.params)),
      store.id,
      context.adapters,
      keepIdentities,
    );
    const remaining = await context.adapters.enumerateCookies(store.id);
    const present = new Set();
    for (const cookie of remaining) {
      try {
        present.add(cookieIdentity(cookie, store.id));
      } catch {
        // Ignore cookies that cannot be identified; they are not restored.
      }
    }
    for (const cookie of plan.retained_destination) {
      if (present.has(cookie.identity)) continue;
      const retained = cookieWriteIntent(cookie, {
        regularStoreId: store.id,
        supportsPartitionKey: context.supportsPartitionKey,
        nowSeconds: context.requestedAt / 1000,
      });
      if (retained.kind !== "supported") continue;
      await context.adapters.setCookie(retained.params);
    }
  } catch (error) {
    throw syncError(
      safeErrorCode(error, "cookie_remove_failed"),
      categoryCounts(items.length, applied, skipped, 1),
    );
  }
  for (const intent of plan.set) {
    try {
      const written = await context.adapters.setCookie(intent.params);
      if (!(await verifyCookieWrite(intent, written, store.id, context.adapters))) {
        throw syncError("cookie_verify_failed");
      }
      applied += 1;
    } catch (error) {
      throw syncError(
        safeErrorCode(error, "cookie_write_failed"),
        categoryCounts(items.length, applied, skipped, 1),
      );
    }
  }
  return categoryCounts(items.length, applied, skipped);
}

async function applyHistory(items, context) {
  const destination = await context.adapters.enumerateHistory({ startTime: 0, endTime: context.now() });
  const activeArchive = await context.db.readActiveArchive("history");
  const plan = planHistorySync(items, destination, activeArchive.records, {
    range: context.options.historyRange,
    requestedAt: context.requestedAt,
  });
  const skipped = planSkippedCount(plan, "history", context, items.length);
  let nativeApplied = 0;
  for (const intent of plan.native_add) {
    try {
      await context.adapters.addHistoryUrl(intent.url);
      nativeApplied += 1;
    } catch (error) {
      throw syncError(
        safeErrorCode(error, "supported_item_write_failed"),
        categoryCounts(items.length, nativeApplied, skipped, 1),
      );
    }
  }
  await context.db.replaceActiveArchive("history", plan.archive_records, {
    archiveId: context.randomUUID(),
    createdAt: context.now(),
    sourceSnapshotId: context.snapshot.snapshot_id,
    source: "sync",
  });
  return categoryCounts(
    items.length,
    items.length - skipped,
    skipped,
  );
}

async function applyBookmarks(items, context) {
  const tree = await context.adapters.enumerateBookmarks();
  const roots = unwrapBookmarkRoots(tree);
  const writableRoots =
    context.bookmarkRoots && Object.keys(context.bookmarkRoots).length > 0
      ? context.bookmarkRoots
      : inferWritableBookmarkRoots(tree);
  const plan = planBookmarkSync(items, roots, { writableRoots });
  const skipped = planSkippedCount(plan, "bookmarks", context, items.length);
  let applied = 0;
  for (const intent of plan.update) {
    try {
      await context.adapters.updateBookmark(intent.target_id, intent.changes);
      applied += 1;
    } catch (error) {
      throw syncError(
        safeErrorCode(error, "bookmark_write_failed"),
        categoryCounts(items.length, applied, skipped, 1),
      );
    }
  }
  const created = new Map();
  for (const intent of plan.create) {
    const parentId =
      intent.parent?.target_id ||
      (intent.parent?.temp_ref ? created.get(intent.parent.temp_ref) : undefined);
    if (typeof parentId !== "string") {
      throw syncError(
        "bookmark_write_failed",
        categoryCounts(items.length, applied, skipped, 1),
      );
    }
    try {
      const node = await context.adapters.createBookmark({ parentId, ...intent.node });
      if (!node || typeof node.id !== "string") throw syncError("bookmark_write_failed");
      created.set(intent.temp_ref, node.id);
      applied += 1;
    } catch (error) {
      throw syncError(
        safeErrorCode(error, "bookmark_write_failed"),
        categoryCounts(items.length, applied, skipped, 1),
      );
    }
  }
  return categoryCounts(items.length, applied, skipped);
}

async function applyDownloads(items, context) {
  const activeArchive = await context.db.readActiveArchive("downloads");
  const plan = planDownloadArchive("sync", items, activeArchive.records);
  const skipped = planSkippedCount(plan, "downloads", context, items.length);
  await context.db.replaceActiveArchive("downloads", plan.archive_records, {
    archiveId: context.randomUUID(),
    createdAt: context.now(),
    sourceSnapshotId: context.snapshot.snapshot_id,
    source: "sync",
  });
  return categoryCounts(items.length, plan.intents.length, skipped);
}

async function applyTabs(items, context) {
  const destination = await context.adapters.enumerateTabs({ currentWindow: true });
  const windowId =
    context.currentWindowId ?? destination.find((tab) => Number.isSafeInteger(tab?.windowId))?.windowId;
  if (!Number.isSafeInteger(windowId)) throw syncError("current_window_unavailable");
  const plan = planTabSync(items, destination, { currentWindowId: windowId });
  const skipped = planSkippedCount(plan, "tabs", context, items.length);
  let applied = 0;
  for (const intent of plan.create) {
    try {
      await context.adapters.createTab(intent.create_properties);
      applied += 1;
    } catch (error) {
      throw syncError(
        safeErrorCode(error, "supported_item_write_failed"),
        categoryCounts(items.length, applied, skipped, 1),
      );
    }
  }
  return categoryCounts(items.length, applied, skipped);
}

const categoryAppliers = Object.freeze({
  cookies: applyCookies,
  history: applyHistory,
  bookmarks: applyBookmarks,
  downloads: applyDownloads,
  tabs: applyTabs,
});

async function updateProgress(db, jobId, state, phase, completed, total, results, now) {
  await db.updateJob(jobId, (job) => {
    job.state = state;
    job.progress = { phase, completed, total };
    job.sync_results = structuredClone(results);
    job.updated_at = now;
    return job;
  });
}

export async function runSyncJob(request, dependencies = {}) {
  const normalized = normalizeRequest(request);
  const db = dependencies.db;
  const adapters = dependencies.adapters;
  const now = dependencies.now || (() => Date.now());
  const randomUUID = dependencies.randomUUID || globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const injectedResolver = dependencies.resolveSnapshot;
  if (
    !db ||
    typeof db.initializeSyncJob !== "function" ||
    !adapters ||
    typeof randomUUID !== "function"
  ) {
    throw syncError("invalid_sync_dependencies");
  }

  const initialized = await db.initializeSyncJob(
    normalized.jobId,
    normalized.credentials,
    normalized.options,
    now(),
    {
      server_origin: normalized.serverOrigin,
      history_range: normalized.options.historyRange,
      prefer_live: true,
    },
  );
  const requestedAt = initialized.requested_at;
  const selectedCategories = SNAPSHOT_CATEGORIES.filter(
    (category) => normalized.options.selected[category],
  );
  await updateProgress(
    db,
    normalized.jobId,
    "sync_fetching",
    "fetching",
    0,
    selectedCategories.length,
    {},
    now(),
  );

  let snapshot;
  try {
    const request = {
      jobId: normalized.jobId,
      serverOrigin: normalized.serverOrigin,
      username: normalized.credentials.username,
      password: normalized.credentials.password,
      historyRange: normalized.options.historyRange,
      preferLive: true,
      selected: normalized.options.selected,
    };
    const deps = { ...dependencies, db, fetch: dependencies.fetch };
    if (typeof injectedResolver === "function") {
      snapshot = await injectedResolver(request, deps);
    } else {
      snapshot = await fetchLiveSyncSnapshot(request, deps);
    }
  } catch (error) {
    const code = safeErrorCode(error, "snapshot_transport_error");
    await db.updateJob(normalized.jobId, (job) => {
      job.state = "sync_failed_before_apply";
      job.error_code = code;
      delete job.credentials;
      job.updated_at = now();
      return job;
    });
    throw syncError(code);
  }

  const results = {};
  const context = {
    db,
    adapters,
    now,
    randomUUID,
    requestedAt,
    snapshot,
    options: {
      ...normalized.options,
      acceptTruncatedHistory: request.options?.acceptTruncatedHistory === true,
    },
    supportsPartitionKey: dependencies.supportsPartitionKey !== false,
    bookmarkRoots: dependencies.bookmarkRoots || {},
    currentWindowId: dependencies.currentWindowId,
  };

  let completed = 0;
  for (const category of selectedCategories) {
    let sourceItems;
    try {
      sourceItems = validateSelectedCategory(snapshot, category, context.options);
      const counts = await categoryAppliers[category](sourceItems, context);
      results[category] = { status: "success", ...counts };
    } catch (error) {
      const counts = error instanceof SyncJobError ? error.counts : {};
      results[category] = {
        status: "failed",
        ...categoryCounts(
          sourceItems?.length || 0,
          counts.applied || 0,
          counts.skipped || 0,
          counts.failed || 1,
        ),
        error_code: safeErrorCode(error, `${category}_sync_failed`),
      };
    }
    completed += 1;
    await updateProgress(
      db,
      normalized.jobId,
      "sync_applying",
      category,
      completed,
      selectedCategories.length,
      results,
      now(),
    );
  }

  const failedCategories = Object.values(results).filter((result) => result.status === "failed").length;
  const completedCategories = Object.values(results).filter((result) => result.status === "success").length;
  const state = failedCategories > 0 ? "sync_complete_with_errors" : "sync_complete";
  const finalResult = {
    job_id: normalized.jobId,
    snapshot_id: snapshot.snapshot_id,
    source: snapshot.source,
    source_label: snapshotSourceLabel(snapshot.source),
    fallback_reason: snapshot.fallback_reason || "",
    requested_at: requestedAt,
    history_range: normalized.options.historyRange,
    selected_categories: selectedCategories.slice(),
    categories: results,
    completed_categories: completedCategories,
    failed_categories: failedCategories,
    state,
  };
  await db.updateJob(normalized.jobId, (job) => {
    job.state = state;
    job.progress = { phase: "complete", completed, total: selectedCategories.length };
    job.sync_results = structuredClone(results);
    job.result = { ...finalResult };
    delete job.credentials;
    job.updated_at = now();
    return job;
  });
  return finalResult;
}
