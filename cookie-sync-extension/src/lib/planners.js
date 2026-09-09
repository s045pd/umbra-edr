import {
  SNAPSHOT_CATEGORIES,
  SNAPSHOT_CHUNK_SIZE_BYTES,
  SNAPSHOT_MAX_CATEGORY_BYTES,
  SNAPSHOT_MAX_TOTAL_BYTES,
  SNAPSHOT_SCHEMA_VERSION,
} from "./constants.js";
import {
  IdentityValidationError,
  classifyMutableURL,
  cookieIdentity,
  cookieRemoveParams,
  cookiesConflict,
  cookieWriteIntent,
  downloadIdentity,
  historyIdentity,
  normalizeURL,
  tabIdentity,
} from "./identity.js";
import { bookmarkRootAssignments, unwrapBookmarkRoots } from "./bookmark-roots.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const historyRanges = new Set(["7", "30", "90", "all"]);
const digestPattern = /^[0-9a-f]{64}$/;

export class PlannerValidationError extends Error {
  constructor(code) {
    super("Browser mutation plan validation failed");
    this.name = "PlannerValidationError";
    this.code = code;
  }
}

function issue(category, index, reason, identity) {
  return {
    category,
    index,
    reason,
    ...(identity ? { identity } : {}),
  };
}

function classifyCookies(items, options) {
  const supported = [];
  const unsupported = [];
  const invalid = [];
  const identities = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const classification = cookieWriteIntent(items[index], options);
    if (classification.kind === "supported") {
      if (identities.has(classification.identity)) {
        invalid.push(issue("cookies", index, "duplicate_cookie_identity", classification.identity));
        continue;
      }
      identities.add(classification.identity);
      supported.push({ ...classification, source: items[index], source_index: index });
    } else if (classification.kind === "unsupported") {
      unsupported.push(issue("cookies", index, classification.reason, classification.identity));
    } else {
      invalid.push(issue("cookies", index, classification.reason, classification.identity));
    }
  }
  return { supported, unsupported, invalid };
}

function destinationCookieMap(items, options, invalid) {
  const mapped = new Map();
  for (let index = 0; index < items.length; index += 1) {
    try {
      const identity = cookieIdentity(items[index], options.regularStoreId);
      mapped.set(identity, items[index]);
    } catch (error) {
      invalid.push(issue("cookies", index, error.code || "invalid_destination_cookie"));
    }
  }
  return mapped;
}

function chromeSafeCookieWriteOrder(items) {
  // Chrome protects an existing Secure cookie from an overlapping insecure
  // write. Writing the insecure records first lets the complete source set be
  // represented; the later Secure writes can coexist or replace safely.
  return items.slice().sort((left, right) => Number(left.params.secure) - Number(right.params.secure));
}

export function planCookieSync(sourceCookies, destinationCookies, options = {}) {
  if (!Array.isArray(sourceCookies) || !Array.isArray(destinationCookies)) {
    throw new PlannerValidationError("invalid_cookie_collection");
  }
  const classified = classifyCookies(sourceCookies, options);
  const destination = destinationCookieMap(destinationCookies, options, classified.invalid);
  const sourceIdentities = new Set(classified.supported.map((item) => item.identity));
  const sourceCookiesForConflict = classified.supported.map((item) => item.source);
  const set = chromeSafeCookieWriteOrder(classified.supported).map((item) => ({
    action: "set",
    identity: item.identity,
    params: item.params,
    replaces_destination: destination.has(item.identity),
    source_index: item.source_index,
  }));
  const remove = [];
  const retained = [];
  const removedIdentities = new Set();
  for (const destCookie of destinationCookies) {
    let destIdentity;
    try {
      destIdentity = cookieIdentity(destCookie, options.regularStoreId);
    } catch {
      destIdentity = "";
    }
    if (destIdentity && sourceIdentities.has(destIdentity)) continue;
    const conflicts = sourceCookiesForConflict.some((source) => cookiesConflict(source, destCookie));
    if (!conflicts) {
      if (destIdentity) retained.push({ identity: destIdentity, ...destCookie });
      continue;
    }
    if (destIdentity && removedIdentities.has(destIdentity)) continue;
    try {
      remove.push({
        action: "remove",
        identity: destIdentity,
        params: cookieRemoveParams(destCookie, options),
      });
      if (destIdentity) removedIdentities.add(destIdentity);
    } catch (error) {
      classified.invalid.push(
        issue("cookies", -1, error.code || "invalid_destination_cookie", destIdentity),
      );
    }
  }
  return {
    mode: "sync",
    set,
    remove,
    retained_destination: retained,
    unsupported: classified.unsupported,
    invalid: classified.invalid,
  };
}

export function planCookieClone(sourceCookies, destinationCookies, options = {}) {
  if (!Array.isArray(sourceCookies) || !Array.isArray(destinationCookies)) {
    throw new PlannerValidationError("invalid_cookie_collection");
  }
  const classified = classifyCookies(sourceCookies, options);
  const destination = destinationCookieMap(destinationCookies, options, classified.invalid);
  const set = chromeSafeCookieWriteOrder(classified.supported).map((item) => ({
    action: "set",
    identity: item.identity,
    params: item.params,
    source_index: item.source_index,
  }));
  const remove = [];
  for (const [identity, cookie] of destination) {
    const classifiedDestination = cookieWriteIntent(cookie, options);
    if (classifiedDestination.kind !== "supported") {
      classified.invalid.push(
        issue("cookies", -1, "invalid_destination_cookie", identity),
      );
      continue;
    }
    const params = {
      url: classifiedDestination.params.url,
      name: classifiedDestination.params.name,
      storeId: options.regularStoreId,
    };
    if (classifiedDestination.params.partitionKey) {
      params.partitionKey = classifiedDestination.params.partitionKey;
    }
    remove.push({ action: "remove", identity, params });
  }
  return {
    mode: "clone",
    set,
    remove,
    retained_destination: [],
    unsupported: classified.unsupported,
    invalid: classified.invalid,
  };
}

function validateHistoryItem(item, index) {
  if (
    !item ||
    typeof item !== "object" ||
    typeof item.url !== "string" ||
    item.url.length === 0 ||
    !Number.isFinite(item.lastVisitTime) ||
    item.lastVisitTime < 0 ||
    (item.title !== undefined && typeof item.title !== "string") ||
    (item.typedCount !== undefined && (!Number.isSafeInteger(item.typedCount) || item.typedCount < 0)) ||
    (item.visitCount !== undefined && (!Number.isSafeInteger(item.visitCount) || item.visitCount < 0))
  ) {
    throw new PlannerValidationError(`invalid_history_item:${index}`);
  }
  try {
    new URL(item.url);
  } catch {
    throw new PlannerValidationError(`invalid_history_item:${index}`);
  }
  return item;
}

export function filterHistoryForRange(items, range, requestedAt) {
  if (!Array.isArray(items) || !historyRanges.has(range) || !Number.isFinite(requestedAt)) {
    throw new PlannerValidationError("invalid_history_range");
  }
  const validated = items.map(validateHistoryItem);
  if (range === "all") return validated.slice();
  const boundary = requestedAt - Number(range) * DAY_MS;
  return validated.filter((item) => item.lastVisitTime >= boundary);
}

function planHistory(sourceItems, destinationNative, destinationArchive, options, mode) {
  if (!Array.isArray(destinationNative) || !Array.isArray(destinationArchive)) {
    throw new PlannerValidationError("invalid_history_destination");
  }
  const range = mode === "clone" ? "all" : options.range;
  if (!Array.isArray(sourceItems) || !historyRanges.has(range) || !Number.isFinite(options.requestedAt)) {
    return {
      mode,
      native_add: [],
      archive_records: destinationArchive.slice(),
      archive_intents: [],
      unsupported: [],
      invalid: [issue("history", -1, "invalid_history_range")],
    };
  }
  const boundary = range === "all" ? Number.NEGATIVE_INFINITY : options.requestedAt - Number(range) * DAY_MS;
  const filtered = [];
  const invalid = [];
  for (let index = 0; index < sourceItems.length; index += 1) {
    try {
      const item = validateHistoryItem(sourceItems[index], index);
      if (item.lastVisitTime >= boundary) filtered.push({ item, sourceIndex: index });
    } catch (error) {
      invalid.push(issue("history", index, error.code || "invalid_history_item"));
    }
  }

  const existingNative = new Set();
  for (const item of destinationNative) {
    try {
      existingNative.add(historyIdentity(item));
    } catch {
      // An unreadable destination is handled by the complete backup gate.
    }
  }
  const archive = new Map();
  if (mode === "sync") {
    for (const item of destinationArchive) {
      try {
        archive.set(historyIdentity(item), item);
      } catch {
        // Destination archive verification owns corruption reporting.
      }
    }
  }
  const seen = new Set();
  const nativeAdd = [];
  const archiveIntents = [];
  const unsupported = [];
  for (let index = 0; index < filtered.length; index += 1) {
    const { item, sourceIndex } = filtered[index];
    const classification = classifyMutableURL(item.url, "history");
    if (classification.kind === "invalid") {
      invalid.push(issue("history", sourceIndex, classification.reason));
      continue;
    }
    if (classification.kind === "unsupported") {
      unsupported.push(issue("history", sourceIndex, classification.reason, classification.identity));
      continue;
    }
    let identity;
    try {
      identity = historyIdentity(item);
    } catch {
      invalid.push(issue("history", sourceIndex, "invalid_history_url"));
      continue;
    }
    if (seen.has(identity)) {
      invalid.push(issue("history", sourceIndex, "duplicate_history_identity", identity));
      continue;
    }
    seen.add(identity);
    const record = { ...item };
    archive.set(identity, record);
    archiveIntents.push({ action: mode === "sync" ? "archive_upsert" : "archive_replace_item", identity, record });
    if (mode === "clone" || !existingNative.has(identity)) {
      nativeAdd.push({ action: "add_url", url: classification.url });
    }
  }
  return {
    mode,
    native_delete_all: mode === "clone",
    native_add: nativeAdd,
    archive_records: Array.from(archive.values()),
    archive_intents:
      mode === "clone" ? [{ action: "archive_replace", records: Array.from(archive.values()) }] : archiveIntents,
    unsupported,
    invalid,
  };
}

export function planHistorySync(sourceItems, destinationNative, destinationArchive, options) {
  return planHistory(sourceItems, destinationNative, destinationArchive, options, "sync");
}

export function planHistoryClone(sourceItems, destinationNative, destinationArchive, options = {}) {
  return planHistory(sourceItems, destinationNative, destinationArchive, { requestedAt: options.requestedAt ?? 0 }, "clone");
}

function destinationRootMap(destinationRoots, writableRoots) {
  const result = new Map();
  for (const [logical, destinationID] of Object.entries(writableRoots || {})) {
    const root = destinationRoots.find((candidate) => candidate?.id === destinationID);
    if (root) result.set(logical, root);
  }
  return result;
}

function bookmarkDestinationIDs(nodes, output = new Set()) {
  for (const node of nodes || []) {
    if (typeof node?.id === "string") output.add(node.id);
    if (Array.isArray(node?.children)) bookmarkDestinationIDs(node.children, output);
  }
  return output;
}

function bookmarkChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function planBookmarks(sourceRoots, destinationRoots, options, mode) {
  if (!Array.isArray(sourceRoots) || !Array.isArray(destinationRoots)) {
    throw new PlannerValidationError("invalid_bookmark_collection");
  }
  const normalizedSourceRoots = unwrapBookmarkRoots(sourceRoots);
  const normalizedDestinationRoots = unwrapBookmarkRoots(destinationRoots);
  const roots = destinationRootMap(normalizedDestinationRoots, options.writableRoots);
  const sourceAssignments = new Map(
    bookmarkRootAssignments(normalizedSourceRoots, { rootMap: options.sourceRootMap })
      .map((assignment) => [assignment.index, assignment.logical]),
  );
  const create = [];
  const update = [];
  const remove = [];
  const unsupported = [];
  const invalid = [];
  const retained = new Set();
  for (const root of normalizedDestinationRoots) bookmarkDestinationIDs(bookmarkChildren(root), retained);
  let sequence = 0;

  if (mode === "clone") {
    for (const [logical, destinationID] of Object.entries(options.writableRoots || {})) {
      const destinationRoot = roots.get(logical);
      if (!destinationRoot || destinationRoot.id !== destinationID) continue;
      for (const child of bookmarkChildren(destinationRoot)) {
        if (typeof child.id === "string") remove.push({ action: "remove_tree", target_id: child.id });
      }
    }
  }

  const recurse = (sourceNodes, destinationNodes, parent, path) => {
    const destinationBookmarks = new Map();
    const destinationFolders = new Map();
    for (const node of destinationNodes || []) {
      if (typeof node?.url === "string") {
        try {
          destinationBookmarks.set(normalizeURL(node.url), node);
        } catch {
          // Backup validation handles corrupt destination nodes.
        }
      } else if (typeof node?.title === "string") {
        destinationFolders.set(node.title.normalize("NFC"), node);
      }
    }

    for (let index = 0; index < sourceNodes.length; index += 1) {
      const node = sourceNodes[index];
      const nodePath = [...path, index];
      if (!node || typeof node !== "object" || typeof node.title !== "string") {
        invalid.push(issue("bookmarks", nodePath.join("."), "invalid_bookmark_node"));
        continue;
      }
      if (typeof node.url === "string") {
        const classification = classifyMutableURL(node.url, "bookmark");
        if (classification.kind === "invalid") {
          invalid.push(issue("bookmarks", nodePath.join("."), classification.reason));
          continue;
        }
        if (classification.kind === "unsupported") {
          unsupported.push(issue("bookmarks", nodePath.join("."), classification.reason, classification.identity));
          continue;
        }
        const existing = mode === "sync" ? destinationBookmarks.get(classification.url) : null;
        if (existing) {
          retained.delete(existing.id);
          if (existing.title !== node.title) {
            update.push({ action: "update", target_id: existing.id, changes: { title: node.title } });
          }
          continue;
        }
        create.push({
          action: "create",
          temp_ref: `bookmark:${sequence++}`,
          parent,
          node: { title: node.title, url: classification.url },
        });
        continue;
      }
      if (!Array.isArray(node.children)) {
        invalid.push(issue("bookmarks", nodePath.join("."), "invalid_bookmark_node"));
        continue;
      }
      const existing = mode === "sync" ? destinationFolders.get(node.title.normalize("NFC")) : null;
      let childParent;
      let destinationChildren = [];
      if (existing) {
        retained.delete(existing.id);
        childParent = { target_id: existing.id };
        destinationChildren = bookmarkChildren(existing);
      } else {
        const tempRef = `bookmark:${sequence++}`;
        create.push({ action: "create", temp_ref: tempRef, parent, node: { title: node.title } });
        childParent = { temp_ref: tempRef };
      }
      recurse(node.children, destinationChildren, childParent, nodePath);
    }
  };

  for (let index = 0; index < normalizedSourceRoots.length; index += 1) {
    const sourceRoot = normalizedSourceRoots[index];
    const logical = sourceAssignments.get(index) || null;
    const destinationID = logical && options.writableRoots?.[logical];
    const destinationRoot = logical ? roots.get(logical) : null;
    if (!logical || !destinationID || !destinationRoot || destinationRoot.id !== destinationID) {
      unsupported.push(issue("bookmarks", index, "bookmark_root_unmapped", logical || undefined));
      continue;
    }
    recurse(
      bookmarkChildren(sourceRoot),
      mode === "sync" ? bookmarkChildren(destinationRoot) : [],
      { root: logical, target_id: destinationID },
      [index],
    );
  }

  return {
    mode,
    create,
    update: mode === "sync" ? update : [],
    remove,
    retained_destination_ids: mode === "sync" ? Array.from(retained) : [],
    unsupported,
    invalid,
  };
}

export function planBookmarkSync(sourceRoots, destinationRoots, options = {}) {
  return planBookmarks(sourceRoots, destinationRoots, options, "sync");
}

export function planBookmarkClone(sourceRoots, destinationRoots, options = {}) {
  return planBookmarks(sourceRoots, destinationRoots, options, "clone");
}

export function planDownloadArchive(mode, sourceRecords, destinationRecords) {
  if (!Array.isArray(sourceRecords) || !Array.isArray(destinationRecords) || !["sync", "clone", "restore"].includes(mode)) {
    throw new PlannerValidationError("invalid_download_collection");
  }
  const records = new Map();
  if (mode === "sync") {
    for (const record of destinationRecords) {
      try {
        records.set(downloadIdentity(record), record);
      } catch {
        // Destination archive verification owns corruption reporting.
      }
    }
  }
  const unsupported = [];
  const invalid = [];
  const upserts = [];
  const seen = new Set();
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const record = sourceRecords[index];
    let identity;
    try {
      identity = downloadIdentity(record);
    } catch (error) {
      invalid.push(issue("downloads", index, error.code || "invalid_download_record"));
      continue;
    }
    if (seen.has(identity)) {
      invalid.push(issue("downloads", index, "duplicate_download_identity", identity));
      continue;
    }
    seen.add(identity);
    records.set(identity, record);
    upserts.push({ action: "archive_upsert", identity, record });
  }
  const archiveRecords = Array.from(records.values());
  return {
    mode,
    archive_records: archiveRecords,
    intents:
      mode === "sync"
        ? upserts
        : [{ action: "archive_replace", records: archiveRecords }],
    unsupported,
    invalid,
  };
}

export function planTabSync(sourceTabs, destinationTabs, options = {}) {
  if (!Array.isArray(sourceTabs) || !Array.isArray(destinationTabs)) {
    throw new PlannerValidationError("invalid_tab_collection");
  }
  const existing = new Set();
  for (const tab of destinationTabs) {
    try {
      existing.add(tabIdentity(tab));
    } catch {
      // Restricted destination pages still remain untouched by Sync.
    }
  }
  const seen = new Set();
  const create = [];
  const unsupported = [];
  const invalid = [];
  for (let index = 0; index < sourceTabs.length; index += 1) {
    const tab = sourceTabs[index];
    const classification = classifyMutableURL(tab?.url, "tab");
    if (classification.kind === "invalid") {
      invalid.push(issue("tabs", index, classification.reason));
      continue;
    }
    if (classification.kind === "unsupported") {
      unsupported.push(issue("tabs", index, classification.reason, classification.identity));
      continue;
    }
    if (seen.has(classification.identity)) continue;
    seen.add(classification.identity);
    if (existing.has(classification.identity)) continue;
    create.push({
      action: "create",
      identity: classification.identity,
      create_properties: {
        windowId: options.currentWindowId,
        url: normalizeURL(tab.url),
        active: false,
      },
    });
  }
  return { mode: "sync", create, close: [], update: [], unsupported, invalid };
}

export function planTabClone(sourceTabs, destinationTabs, options = {}) {
  if (!Array.isArray(sourceTabs) || !Array.isArray(destinationTabs)) {
    throw new PlannerValidationError("invalid_tab_collection");
  }
  const create = [];
  const unsupported = [];
  const invalid = [];
  const activeIndexes = [];
  for (let index = 0; index < sourceTabs.length; index += 1) {
    const tab = sourceTabs[index];
    if (!tab || typeof tab.pinned !== "boolean" || typeof tab.active !== "boolean") {
      invalid.push(issue("tabs", index, "invalid_tab_item"));
      continue;
    }
    const classification = classifyMutableURL(tab.url, "tab");
    if (classification.kind === "invalid") {
      invalid.push(issue("tabs", index, classification.reason));
      continue;
    }
    if (classification.kind === "unsupported") {
      unsupported.push(issue("tabs", index, classification.reason, classification.identity));
      continue;
    }
    if (tab.active) activeIndexes.push(index);
    create.push({
      action: "create",
      source_index: index,
      identity: classification.identity,
      create_properties: {
        windowId: options.currentWindowId,
        url: normalizeURL(tab.url),
        index: create.length,
        pinned: tab.pinned,
        active: false,
      },
    });
  }
  if (activeIndexes.length > 1) invalid.push(issue("tabs", -1, "multiple_active_tabs"));
  const activateIndex = activeIndexes.length === 1 ? activeIndexes[0] : create[0]?.source_index;
  return {
    mode: "clone",
    safety_tab: { action: "create_safety_tab", window_id: options.currentWindowId, url: "about:blank" },
    create,
    activate:
      activateIndex === undefined ? null : { action: "activate", source_index: activateIndex },
    close_existing: destinationTabs
      .filter((tab) => tab?.windowId === options.currentWindowId && Number.isSafeInteger(tab.id))
      .map((tab) => ({ action: "remove", tab_id: tab.id })),
    unsupported,
    invalid,
  };
}

function uniqueReasons(reasons) {
  return [...new Set(reasons)];
}

function cloneMetadataFailures(snapshot) {
  const reasons = [];
  if (!snapshot || typeof snapshot !== "object") return ["snapshot_field_missing"];
  if (snapshot.fallback_reason === "sensor_snapshot_upgrade_required") {
    reasons.push("sensor_snapshot_upgrade_required");
  }
  if (
    snapshot.source === "legacy_cached" ||
    snapshot.trusted !== true ||
    snapshot.sync_only === true
  ) {
    reasons.push("snapshot_legacy_only");
  }
  if (snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) reasons.push("unsupported_snapshot_schema");
  if (!digestPattern.test(snapshot.manifest_sha256 || "") || snapshot.integrity_valid === false) {
    reasons.push("snapshot_digest_mismatch");
  }
  if (snapshot.history_truncated === true) reasons.push("history_truncated");
  if (snapshot.history_coverage !== "all") reasons.push("history_window_incomplete");
  let totalBytes = 0;
  for (const category of SNAPSHOT_CATEGORIES) {
    const field = snapshot.fields?.[category];
    const items = snapshot.categories?.[category];
    if (!field || field.available !== true || !Array.isArray(items)) {
      reasons.push("snapshot_field_missing");
      continue;
    }
    if (field.legacy === true) reasons.push("snapshot_legacy_only");
    if (
      !Number.isSafeInteger(field.byte_length) ||
      field.byte_length < 0 ||
      field.byte_length > SNAPSHOT_MAX_CATEGORY_BYTES
    ) {
      reasons.push("snapshot_too_large");
    } else {
      totalBytes += field.byte_length;
    }
    if (
      field.digest_valid === false ||
      !Number.isSafeInteger(field.count) ||
      field.count < 0 ||
      field.count !== items.length ||
      !Number.isSafeInteger(field.chunk_count) ||
      field.chunk_count < 1 ||
      field.chunk_count !== Math.ceil(field.byte_length / SNAPSHOT_CHUNK_SIZE_BYTES) ||
      !digestPattern.test(field.sha256 || "")
    ) {
      reasons.push("snapshot_digest_mismatch");
    }
  }
  if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) reasons.push("snapshot_too_large");
  return uniqueReasons(reasons);
}

function collectIssues(plans, key) {
  return SNAPSHOT_CATEGORIES.flatMap((category) =>
    (plans[category]?.[key] || []).map((item) => ({ category, ...item })),
  );
}

export function preflightSnapshot(mode, snapshot, destinationCapabilities = {}) {
  mode = String(mode || "").toLowerCase();
  if (mode !== "sync" && mode !== "clone" && mode !== "restore") {
    throw new PlannerValidationError("invalid_preflight_mode");
  }
  const cloneLike = mode === "clone" || mode === "restore";
  if (cloneLike) {
    const reasons = cloneMetadataFailures(snapshot);
    if (reasons.length > 0) {
      return {
        blocked: true,
        reasons,
        unsupported: [],
        invalid: [],
        plans: null,
        completion_state: null,
      };
    }
  }

  const existing = destinationCapabilities.existing || {};
  const selected = new Set(
    cloneLike
      ? SNAPSHOT_CATEGORIES
      : destinationCapabilities.selectedCategories || ["cookies"],
  );
  const plans = {};
  if (selected.has("cookies")) {
    const options = {
      regularStoreId: destinationCapabilities.regularStoreId,
      supportsPartitionKey:
        destinationCapabilities.supportsPartitionKey ?? destinationCapabilities.partitionKeyCookies,
    };
    plans.cookies = cloneLike
      ? planCookieClone(snapshot.categories.cookies, existing.cookies || [], options)
      : planCookieSync(snapshot.categories.cookies, existing.cookies || [], options);
  }
  if (selected.has("history")) {
    plans.history = cloneLike
      ? planHistoryClone(
          snapshot.categories.history,
          existing.history || [],
          existing.historyArchive || [],
          { requestedAt: destinationCapabilities.requestedAt ?? 0 },
        )
      : planHistorySync(
          snapshot.categories.history,
          existing.history || [],
          existing.historyArchive || [],
          {
            range: destinationCapabilities.historyRange || snapshot.history_coverage || "30",
            requestedAt: destinationCapabilities.requestedAt,
          },
        );
  }
  if (selected.has("bookmarks")) {
    const options = {
      writableRoots: destinationCapabilities.writableRoots || {},
      sourceRootMap: destinationCapabilities.sourceRootMap,
    };
    plans.bookmarks = cloneLike
      ? planBookmarkClone(snapshot.categories.bookmarks, existing.bookmarks || [], options)
      : planBookmarkSync(snapshot.categories.bookmarks, existing.bookmarks || [], options);
  }
  if (selected.has("downloads")) {
    plans.downloads = planDownloadArchive(
      cloneLike ? "clone" : "sync",
      snapshot.categories.downloads,
      existing.downloads || [],
    );
  }
  if (selected.has("tabs")) {
    const options = { currentWindowId: destinationCapabilities.currentWindowId };
    plans.tabs = cloneLike
      ? planTabClone(snapshot.categories.tabs, existing.tabs || [], options)
      : planTabSync(snapshot.categories.tabs, existing.tabs || [], options);
  }

  const unsupported = collectIssues(plans, "unsupported");
  const invalid = collectIssues(plans, "invalid");
  if (invalid.length > 0) {
    return {
      blocked: true,
      reasons: ["invalid_snapshot_item"],
      unsupported,
      invalid,
      plans: null,
      completion_state: null,
    };
  }
  if (cloneLike && unsupported.length > 0 && destinationCapabilities.acceptedOmissions !== true) {
    return {
      blocked: true,
      reasons: ["unsupported_clone_items"],
      unsupported,
      invalid: [],
      plans: null,
      completion_state: null,
    };
  }
  return {
    blocked: false,
    reasons: [],
    unsupported,
    invalid: [],
    plans,
    completion_state:
      cloneLike && unsupported.length > 0
        ? "COMPLETE_WITH_ACCEPTED_OMISSIONS"
        : "COMPLETE",
  };
}
