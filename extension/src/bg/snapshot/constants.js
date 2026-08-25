(function attachSnapshotConstants(root, factory) {
  const constants = factory();
  root.UmbraSnapshotConstants = constants;
  if (typeof module === "object" && module && module.exports) {
    module.exports = constants;
  }
})(globalThis, function makeSnapshotConstants() {
  "use strict";

  return Object.freeze({
    SCHEMA_VERSION: 1,
    CATEGORIES: Object.freeze(["cookies", "history", "bookmarks", "downloads", "tabs"]),
    CHUNK_SIZE_BYTES: 524288,
    MAX_TOTAL_BYTES: 67108864,
    MAX_CATEGORY_BYTES: 33554432,
    MAX_ITEMS_PER_CATEGORY: 250000,
    CAPTURE_DEADLINE_MS: 300000,
    SENSOR_STAGING_TTL_MS: 600000,
    DEFAULT_HISTORY_RESULT_CEILING: 10000,
    DEFAULT_MIN_HISTORY_WINDOW_MS: 60000,
    DAY_MS: 86400000,
    ERROR_HISTORY_API: "history_api_error",
    ERROR_HISTORY_INVALID_ITEM: "history_invalid_item",
    ERROR_HISTORY_WINDOW_INCOMPLETE: "history_window_incomplete",
    ERROR_SNAPSHOT_TOO_LARGE: "snapshot_too_large",
    ERROR_SNAPSHOT_ACQUISITION_TIMEOUT: "snapshot_acquisition_timeout",
    ERROR_SNAPSHOT_STORAGE: "snapshot_storage_error",
    ERROR_SENSOR_RUNTIME: "sensor_snapshot_runtime_error",
  });
});
