(function attachSnapshotRPC(root, factory) {
  let constants = root.UmbraSnapshotConstants;
  if (!constants && typeof module === "object" && module && module.exports) {
    constants = require("./constants.js");
  }
  const api = factory(constants);
  root.UmbraSnapshotRPC = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeSnapshotRPC(constants) {
  "use strict";

  if (!constants) throw new Error("Umbra snapshot constants must load before RPC responses");

  const allowedCodes = new Set([
    constants.ERROR_HISTORY_API,
    constants.ERROR_HISTORY_INVALID_ITEM,
    constants.ERROR_HISTORY_WINDOW_INCOMPLETE,
    constants.ERROR_SNAPSHOT_TOO_LARGE,
    constants.ERROR_SNAPSHOT_ACQUISITION_TIMEOUT,
    constants.ERROR_SNAPSHOT_STORAGE,
    constants.ERROR_SENSOR_RUNTIME,
    "invalid_snapshot_request",
    "invalid_snapshot_id",
    "invalid_snapshot_limits",
    "invalid_snapshot_deadline",
    "invalid_history_range",
    "unsupported_snapshot_schema",
    "snapshot_request_mismatch",
    ...constants.CATEGORIES.map((category) => `${category}_api_error`),
  ]);

  function safeCode(error) {
    if (typeof error?.code === "string" && allowedCodes.has(error.code)) return error.code;
    const name = typeof error?.name === "string" ? error.name : "";
    const message = typeof error?.message === "string" ? error.message : "";
    if (
      ["AbortError", "ConstraintError", "DataError", "InvalidStateError", "QuotaExceededError", "TransactionInactiveError", "UnknownError"].includes(name) ||
      /indexeddb|object store|transaction|snapshot store/i.test(message)
    ) {
      return constants.ERROR_SNAPSHOT_STORAGE;
    }
    return constants.ERROR_SENSOR_RUNTIME;
  }

  async function invoke(controller, method, request) {
    try {
      if (!controller || typeof controller[method] !== "function") {
        throw new Error("Snapshot controller method unavailable");
      }
      return await controller[method](request);
    } catch (error) {
      return {
        status: "failed",
        snapshot_id: typeof request?.snapshot_id === "string" ? request.snapshot_id : "",
        error_code: safeCode(error),
      };
    }
  }

  return Object.freeze({ invoke, safeCode });
});
