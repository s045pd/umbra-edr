export const SHADOWLINK_DB_NAME = "shadowlink_sync_v1";
export const SHADOWLINK_DB_VERSION = 1;

export const SHADOWLINK_STORE_NAMES = Object.freeze([
  "jobs",
  "backup_chunks",
  "backup_manifests",
  "history_archives",
  "download_archives",
  "snapshot_cache",
]);

export const BACKUP_POINTER_RECORD_ID = "__shadowlink_backup_pointers__";
export const ARCHIVE_POINTER_RECORD_ID = "__shadowlink_active_archive__";
export const MUTATION_LOCK_JOB_ID = "__shadowlink_mutation_lock__";
export const SNAPSHOT_MANIFEST_CATEGORY = "__manifest__";
export const SNAPSHOT_MANIFEST_CHUNK_INDEX = -1;

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_CHUNK_SIZE_BYTES = 512 * 1024;
export const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const SNAPSHOT_MAX_CATEGORY_BYTES = 32 * 1024 * 1024;
export const SNAPSHOT_MAX_CATEGORY_ITEMS = 250_000;
export const SNAPSHOT_ACQUISITION_TIMEOUT_MS = 5 * 60 * 1000;
export const SNAPSHOT_DOWNLOAD_LEASE_MS = 30 * 1000;
export const SNAPSHOT_MIN_POLL_MS = 10;
export const SNAPSHOT_MAX_POLL_MS = 5 * 1000;

export const SNAPSHOT_CATEGORIES = Object.freeze([
  "cookies",
  "history",
  "bookmarks",
  "downloads",
  "tabs",
]);

export const TRUSTED_SNAPSHOT_SOURCES = Object.freeze([
  "live",
  "cached",
  "cached_fallback",
]);
export const LEGACY_SNAPSHOT_SOURCE = "legacy_cached";

export const SNAPSHOT_ENDPOINTS = Object.freeze({
  start: "/api/v1/get-bot-browser-snapshot",
  status: "/api/v1/get-bot-browser-snapshot-status",
  chunk: "/api/v1/get-bot-browser-snapshot-chunk",
});

export const ACTIVE_SNAPSHOT_JOB_STATES = Object.freeze([
  "running",
  "acquiring",
  "downloading",
  "backing_up",
  "awaiting_confirmation",
  "mutating",
  "rolling_back",
  "restoring",
]);
