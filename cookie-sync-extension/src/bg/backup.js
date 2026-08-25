import canonicalize from "../lib/canonicalize.js";
import { sha256Hex } from "../lib/hash.js";
import {
  SNAPSHOT_CHUNK_SIZE_BYTES,
  SNAPSHOT_MAX_CATEGORY_BYTES,
  SNAPSHOT_MAX_CATEGORY_ITEMS,
  SNAPSHOT_MAX_TOTAL_BYTES,
} from "../lib/constants.js";
import { cookieIdentity, downloadIdentity, historyIdentity } from "../lib/identity.js";
import {
  bookmarkRootAssignments,
  unwrapBookmarkRoots,
} from "../lib/bookmark-roots.js";
import { SnapshotStorageError } from "./idb.js";

export const BACKUP_CATEGORIES = Object.freeze([
  "cookies",
  "native_history",
  "bookmarks",
  "tabs",
  "history_archive",
  "download_archive",
]);

const encoder = new TextEncoder();
const digestPattern = /^[0-9a-f]{64}$/;

const ERROR_MESSAGES = Object.freeze({
  backup_incomplete: "Destination backup is incomplete",
  snapshot_too_large: "Destination backup exceeds the supported limit",
  backup_quota_exceeded: "Destination backup storage quota was exceeded",
  backup_write_failed: "Destination backup could not be written",
  backup_verify_failed: "Destination backup verification failed",
  backup_not_found: "Destination backup was not found",
  backup_not_staged: "Destination backup is not staged",
  backup_in_use: "Destination backup is active and cannot be cancelled",
  backup_confirmation_mismatch: "Destination backup confirmation does not match",
});

export class BackupError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || "Destination backup operation failed");
    this.name = "BackupError";
    this.code = code;
  }
}

function backupError(code) {
  return new BackupError(code);
}

function normalizeStorageError(error, fallback = "backup_write_failed") {
  if (error instanceof BackupError) return error;
  if (error?.name === "QuotaExceededError") return backupError("backup_quota_exceeded");
  if (error instanceof SnapshotStorageError && ERROR_MESSAGES[error.code]) {
    return backupError(error.code);
  }
  return backupError(fallback);
}

function normalizeLimits(limits = {}) {
  const result = {
    maxItemsPerCategory:
      limits.maxItemsPerCategory === undefined
        ? SNAPSHOT_MAX_CATEGORY_ITEMS
        : limits.maxItemsPerCategory,
    maxCategoryBytes:
      limits.maxCategoryBytes === undefined ? SNAPSHOT_MAX_CATEGORY_BYTES : limits.maxCategoryBytes,
    maxTotalBytes:
      limits.maxTotalBytes === undefined ? SNAPSHOT_MAX_TOTAL_BYTES : limits.maxTotalBytes,
  };
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value < 0) throw backupError("backup_incomplete");
  }
  return result;
}

function requireArray(value) {
  if (!Array.isArray(value)) throw backupError("backup_incomplete");
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function normalizeCookies(cookies, storeId) {
  const identities = new Set();
  return requireArray(cookies)
    .map((cookie) => {
      if (
        !cookie ||
        typeof cookie !== "object" ||
        cookie.storeId !== storeId ||
        cookie.partitionKeyOmitted === true
      ) {
        throw backupError("backup_incomplete");
      }
      let identity;
      try {
        identity = cookieIdentity(cookie, storeId);
      } catch {
        throw backupError("backup_incomplete");
      }
      if (identities.has(identity)) throw backupError("backup_incomplete");
      identities.add(identity);
      return { identity, value: clone(cookie) };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity))
    .map((entry) => entry.value);
}

function normalizeHistory(items) {
  const identities = new Set();
  return requireArray(items)
    .map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        !Number.isFinite(item.lastVisitTime) ||
        item.lastVisitTime < 0
      ) {
        throw backupError("backup_incomplete");
      }
      let identity;
      try {
        identity = historyIdentity(item);
      } catch {
        throw backupError("backup_incomplete");
      }
      if (identities.has(identity)) throw backupError("backup_incomplete");
      identities.add(identity);
      return { identity, value: clone(item) };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity))
    .map((entry) => entry.value);
}

function normalizeBookmarkNode(node) {
  if (!node || typeof node !== "object" || typeof node.title !== "string") {
    throw backupError("backup_incomplete");
  }
  if (node.url !== undefined) {
    if (typeof node.url !== "string" || node.url.length === 0) {
      throw backupError("backup_incomplete");
    }
    try {
      new URL(node.url);
    } catch {
      throw backupError("backup_incomplete");
    }
    return { title: node.title, url: node.url };
  }
  if (!Array.isArray(node.children)) throw backupError("backup_incomplete");
  return { title: node.title, children: node.children.map(normalizeBookmarkNode) };
}

function countBookmarkNodes(nodes) {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (Array.isArray(node.children)) count += countBookmarkNodes(node.children);
  }
  return count;
}

function normalizeBookmarks(tree, writableRoots) {
  const roots = unwrapBookmarkRoots(requireArray(tree));
  const normalized = [];
  let assignments;
  try {
    assignments = new Map(
      bookmarkRootAssignments(roots).map((assignment) => [assignment.id, assignment.logical]),
    );
  } catch {
    throw backupError("backup_incomplete");
  }
  for (const [logical, destinationID] of Object.entries(writableRoots || {})) {
    const root = roots.find((candidate) => candidate?.id === destinationID);
    if (!root || assignments.get(destinationID) !== logical || !Array.isArray(root.children)) {
      throw backupError("backup_incomplete");
    }
    normalized.push({
      root: logical,
      children: root.children.map(normalizeBookmarkNode),
    });
  }
  if (normalized.length === 0) throw backupError("backup_incomplete");
  return normalized;
}

function normalizeTabs(tabs, currentWindowId) {
  tabs = requireArray(tabs);
  if (!Number.isSafeInteger(currentWindowId)) throw backupError("backup_incomplete");
  const indexes = new Set();
  let activeCount = 0;
  const normalized = tabs.map((tab) => {
    if (
      !tab ||
      tab.windowId !== currentWindowId ||
      !Number.isSafeInteger(tab.index) ||
      tab.index < 0 ||
      indexes.has(tab.index) ||
      typeof tab.url !== "string" ||
      tab.url.length === 0 ||
      typeof tab.pinned !== "boolean" ||
      typeof tab.active !== "boolean"
    ) {
      throw backupError("backup_incomplete");
    }
    try {
      new URL(tab.url);
    } catch {
      throw backupError("backup_incomplete");
    }
    indexes.add(tab.index);
    if (tab.active) activeCount += 1;
    return { url: tab.url, index: tab.index, pinned: tab.pinned, active: tab.active };
  });
  if (normalized.length > 0 && activeCount !== 1) throw backupError("backup_incomplete");
  normalized.sort((left, right) => left.index - right.index);
  return normalized;
}

function normalizeArchive(records, identityFunction) {
  const seen = new Set();
  return requireArray(records)
    .map((record) => {
      let identity;
      try {
        identity = identityFunction(record);
      } catch {
        throw backupError("backup_incomplete");
      }
      if (seen.has(identity)) throw backupError("backup_incomplete");
      seen.add(identity);
      return { identity, value: clone(record) };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity))
    .map((entry) => entry.value);
}

function itemCount(category, value) {
  switch (category) {
    case "cookies":
    case "native_history":
    case "tabs":
      return value.items.length;
    case "bookmarks":
      return value.roots.reduce((total, root) => total + countBookmarkNodes(root.children), 0);
    case "history_archive":
    case "download_archive":
      return value.records.length;
    default:
      throw backupError("backup_verify_failed");
  }
}

function splitBytes(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SNAPSHOT_CHUNK_SIZE_BYTES) {
    chunks.push(bytes.slice(offset, Math.min(offset + SNAPSHOT_CHUNK_SIZE_BYTES, bytes.byteLength)));
  }
  return chunks;
}

function selectedManifestCore(manifest) {
  const categories = {};
  for (const category of BACKUP_CATEGORIES) {
    const descriptor = manifest.categories[category];
    categories[category] = {
      available: descriptor.available,
      complete: descriptor.complete,
      count: descriptor.count,
      byte_length: descriptor.byte_length,
      sha256: descriptor.sha256,
      chunk_count: descriptor.chunk_count,
      chunks: descriptor.chunks.map((chunk) => ({
        chunk_index: chunk.chunk_index,
        byte_length: chunk.byte_length,
        sha256: chunk.sha256,
      })),
    };
  }
  return {
    backup_id: manifest.backup_id,
    schema_version: manifest.schema_version,
    purpose: manifest.purpose,
    created_at: manifest.created_at,
    destination_profile: manifest.destination_profile,
    destination_window_id: manifest.destination_window_id,
    categories,
  };
}

async function captureDestination(identity, deps) {
  const { db, adapters } = deps;
  if (!db || !adapters) throw backupError("backup_incomplete");
  const limits = normalizeLimits(deps.limits);
  let store;
  let cookies;
  let history;
  let bookmarkTree;
  let tabs;
  let historyArchive;
  let downloadArchive;
  try {
    store = await adapters.getCurrentRegularCookieStore();
    if (!store || store.incognito === true || typeof store.id !== "string") {
      throw backupError("backup_incomplete");
    }
    if (deps.cookieEnumerationComplete === false) throw backupError("backup_incomplete");
    cookies = normalizeCookies(await adapters.enumerateCookies(store.id), store.id);
    history = normalizeHistory(
      await adapters.enumerateHistory({ startTime: 0, endTime: deps.now() }),
    );
    bookmarkTree = normalizeBookmarks(await adapters.enumerateBookmarks(), deps.writableRoots);
    tabs = normalizeTabs(await adapters.enumerateTabs({ currentWindow: true }), deps.currentWindowId);
    historyArchive = normalizeArchive(
      (await db.readActiveArchive("history")).records,
      historyIdentity,
    );
    downloadArchive = normalizeArchive(
      (await db.readActiveArchive("downloads")).records,
      downloadIdentity,
    );
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw backupError("backup_incomplete");
  }

  const values = {
    cookies: { regular_store_id: store.id, items: cookies },
    native_history: { coverage: "all", truncated: false, items: history },
    bookmarks: { roots: bookmarkTree },
    tabs: { window_id: deps.currentWindowId, items: tabs },
    history_archive: { records: historyArchive },
    download_archive: { records: downloadArchive },
  };
  const descriptors = {};
  const records = [];
  let totalBytes = 0;
  for (const category of BACKUP_CATEGORIES) {
    const count = itemCount(category, values[category]);
    if (count > limits.maxItemsPerCategory) throw backupError("backup_incomplete");
    let canonical;
    try {
      canonical = canonicalize(values[category]);
    } catch {
      throw backupError("backup_incomplete");
    }
    const bytes = encoder.encode(canonical);
    if (bytes.byteLength > limits.maxCategoryBytes) throw backupError("snapshot_too_large");
    totalBytes += bytes.byteLength;
    if (totalBytes > limits.maxTotalBytes) throw backupError("snapshot_too_large");
    const pieces = splitBytes(bytes);
    const chunkDescriptors = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      const digest = await sha256Hex(piece);
      chunkDescriptors.push({ chunk_index: index, byte_length: piece.byteLength, sha256: digest });
      records.push({
        backup_id: identity.backupId,
        category,
        chunk_index: index,
        byte_length: piece.byteLength,
        sha256: digest,
        bytes: piece.slice().buffer,
      });
    }
    descriptors[category] = {
      available: true,
      complete: true,
      count,
      byte_length: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      chunk_count: pieces.length,
      chunks: chunkDescriptors,
    };
  }

  const manifest = {
    backup_id: identity.backupId,
    schema_version: 1,
    purpose: identity.purpose,
    created_at: identity.createdAt,
    destination_profile: { regular_store_id: store.id },
    destination_window_id: deps.currentWindowId,
    categories: descriptors,
  };
  const manifestCanonical = canonicalize(selectedManifestCore(manifest));
  const manifestSHA256 = await sha256Hex(encoder.encode(manifestCanonical));
  return { values, chunks: records, manifest, manifestCanonical, manifestSHA256 };
}

function normalizeDependencies(deps) {
  const now = deps?.now || (() => Date.now());
  const randomUUID = deps?.randomUUID || globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!deps?.db || !deps?.adapters || typeof now !== "function" || typeof randomUUID !== "function") {
    throw backupError("backup_incomplete");
  }
  return { ...deps, now, randomUUID };
}

export async function stageDestinationBackup(options = {}, dependencies = {}) {
  const deps = normalizeDependencies(dependencies);
  const backupId = options.backupId || deps.randomUUID();
  const createdAt = options.createdAt ?? deps.now();
  if (typeof backupId !== "string" || backupId.length === 0 || !Number.isFinite(createdAt)) {
    throw backupError("backup_incomplete");
  }
  const material = await captureDestination(
    { backupId, createdAt, purpose: options.purpose || "clone" },
    deps,
  );
  const storedManifest = {
    ...material.manifest,
    state: "staged",
    verified: false,
    awaiting_confirmation: false,
    manifest_sha256: material.manifestSHA256,
    manifest_canonical: material.manifestCanonical,
  };
  try {
    await deps.db.stageBackup(storedManifest, material.chunks);
  } catch (error) {
    throw normalizeStorageError(error);
  }
  return { backup_id: backupId, manifest: storedManifest };
}

function validateDescriptor(descriptor) {
  if (
    !descriptor ||
    descriptor.available !== true ||
    descriptor.complete !== true ||
    !Number.isSafeInteger(descriptor.count) ||
    descriptor.count < 0 ||
    !Number.isSafeInteger(descriptor.byte_length) ||
    descriptor.byte_length <= 0 ||
    !digestPattern.test(descriptor.sha256 || "") ||
    !Number.isSafeInteger(descriptor.chunk_count) ||
    descriptor.chunk_count < 1 ||
    !Array.isArray(descriptor.chunks) ||
    descriptor.chunks.length !== descriptor.chunk_count
  ) {
    throw backupError("backup_verify_failed");
  }
}

async function assembleCategory(db, manifest, category) {
  const descriptor = manifest.categories?.[category];
  validateDescriptor(descriptor);
  const chunks = await db.listBackupChunks(manifest.backup_id, category);
  if (chunks.length !== descriptor.chunk_count) throw backupError("backup_verify_failed");
  const bytes = new Uint8Array(descriptor.byte_length);
  let offset = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const expected = descriptor.chunks[index];
    if (
      chunk.chunk_index !== index ||
      expected.chunk_index !== index ||
      !(chunk.bytes instanceof ArrayBuffer) ||
      chunk.byte_length !== chunk.bytes.byteLength ||
      chunk.byte_length !== expected.byte_length ||
      chunk.sha256 !== expected.sha256 ||
      !digestPattern.test(chunk.sha256)
    ) {
      throw backupError("backup_verify_failed");
    }
    if ((await sha256Hex(chunk.bytes)) !== chunk.sha256 || offset + chunk.byte_length > bytes.byteLength) {
      throw backupError("backup_verify_failed");
    }
    bytes.set(new Uint8Array(chunk.bytes), offset);
    offset += chunk.byte_length;
  }
  if (offset !== descriptor.byte_length || (await sha256Hex(bytes)) !== descriptor.sha256) {
    throw backupError("backup_verify_failed");
  }
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw backupError("backup_verify_failed");
  }
  try {
    if (itemCount(category, value) !== descriptor.count) throw new Error("count");
  } catch {
    throw backupError("backup_verify_failed");
  }
  return value;
}

export async function verifyStagedBackup(backupId, { db, now = () => Date.now() } = {}) {
  if (!db) throw backupError("backup_not_found");
  const manifest = await db.getBackupManifest(backupId);
  if (!manifest) throw backupError("backup_not_found");
  if (manifest.state !== "staged") throw backupError("backup_not_staged");
  try {
    const canonical = canonicalize(selectedManifestCore(manifest));
    if (
      canonical !== manifest.manifest_canonical ||
      !digestPattern.test(manifest.manifest_sha256 || "") ||
      (await sha256Hex(encoder.encode(canonical))) !== manifest.manifest_sha256
    ) {
      throw backupError("backup_verify_failed");
    }
    for (const category of BACKUP_CATEGORIES) await assembleCategory(db, manifest, category);
    return await db.markBackupVerified(backupId, now());
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw backupError("backup_verify_failed");
  }
}

export async function readBackupCategory(db, backupId, category) {
  if (!BACKUP_CATEGORIES.includes(category)) throw backupError("backup_verify_failed");
  const manifest = await db.getBackupManifest(backupId);
  if (!manifest) throw backupError("backup_not_found");
  return assembleCategory(db, manifest, category);
}

export async function cancelStagedBackup(backupId, { db } = {}) {
  if (!db) throw backupError("backup_not_found");
  try {
    return await db.deleteStagedBackup(backupId);
  } catch (error) {
    throw normalizeStorageError(error);
  }
}

function freshnessChanges(previous, current) {
  const changes = [];
  if (
    previous.destination_profile.regular_store_id !== current.destination_profile.regular_store_id ||
    previous.destination_window_id !== current.destination_window_id
  ) {
    changes.push({ category: "destination", identity: true, count: false, bytes: false, digest: false });
  }
  for (const category of BACKUP_CATEGORIES) {
    const before = previous.categories[category];
    const after = current.categories[category];
    if (
      before.count !== after.count ||
      before.byte_length !== after.byte_length ||
      before.sha256 !== after.sha256
    ) {
      changes.push({
        category,
        identity: before.count === after.count && before.byte_length === after.byte_length && before.sha256 !== after.sha256,
        count: before.count !== after.count,
        bytes: before.byte_length !== after.byte_length,
        digest: before.sha256 !== after.sha256,
      });
    }
  }
  return changes;
}

export async function confirmFreshnessAndPromote(
  confirmation,
  dependencies = {},
  beginMutation = async () => {},
) {
  const deps = normalizeDependencies(dependencies);
  const manifest = await deps.db.getBackupManifest(confirmation?.backupId);
  if (!manifest) throw backupError("backup_not_found");
  if (confirmation?.manifestSHA256 !== manifest.manifest_sha256) {
    throw backupError("backup_confirmation_mismatch");
  }
  if (manifest.state !== "staged" || manifest.verified !== true || manifest.awaiting_confirmation !== true) {
    throw backupError("backup_not_staged");
  }
  await verifyStagedBackup(manifest.backup_id, { db: deps.db, now: deps.now });

  let current;
  try {
    current = await captureDestination(
      {
        backupId: manifest.backup_id,
        createdAt: manifest.created_at,
        purpose: manifest.purpose,
      },
      deps,
    );
  } catch (error) {
    await deps.db.invalidateStagedBackup(manifest.backup_id, "backup_incomplete", deps.now());
    return {
      fresh: false,
      promoted: false,
      reason: "backup_incomplete",
      changes: [],
      requires_new_backup: true,
      requires_confirmation: true,
    };
  }
  if (current.manifestSHA256 !== manifest.manifest_sha256) {
    const changes = freshnessChanges(manifest, current.manifest);
    await deps.db.invalidateStagedBackup(manifest.backup_id, "destination_changed", deps.now());
    return {
      fresh: false,
      promoted: false,
      reason: "destination_changed",
      changes,
      requires_new_backup: true,
      requires_confirmation: true,
    };
  }

  if (typeof dependencies.beforePromote === "function") {
    await dependencies.beforePromote({
      backupId: manifest.backup_id,
      manifestSHA256: manifest.manifest_sha256,
    });
  }
  await deps.db.promoteBackup(manifest.backup_id, deps.now());
  await beginMutation({ backupId: manifest.backup_id, manifestSHA256: manifest.manifest_sha256 });
  return {
    fresh: true,
    promoted: true,
    backup_id: manifest.backup_id,
    manifest_sha256: manifest.manifest_sha256,
    requires_new_backup: false,
    requires_confirmation: false,
  };
}
