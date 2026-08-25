(function attachSnapshotJobs(root, factory) {
  let constants = root.UmbraSnapshotConstants;
  let canonicalize = root.UmbraCanonicalize;
  let history = root.UmbraSnapshotHistory;
  let storeAPI = root.UmbraSnapshotStore;
  if (typeof module === "object" && module && module.exports) {
    constants ||= require("./constants.js");
    canonicalize ||= require("./canonicalize.js");
    history ||= require("./history-collector.js");
    storeAPI ||= require("./indexeddb-store.js");
  }
  const api = factory(constants, canonicalize, history, storeAPI);
  root.UmbraSnapshotJobs = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeSnapshotJobs(constants, canonicalize, historyAPI, storeAPI) {
  "use strict";

  if (!constants || !canonicalize || !historyAPI || !storeAPI) {
    throw new Error("Umbra snapshot dependencies must load before snapshot jobs");
  }

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const categorySet = new Set(constants.CATEGORIES);

  function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function normalizeBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new Error("Expected byte array");
  }

  async function sha256Hex(value) {
    const bytes = normalizeBytes(value);
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes
        : bytes.slice();
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", exact));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require === "function") {
      return require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    }
    throw new Error("SHA-256 is unavailable");
  }

  function bytesToBase64(value) {
    const bytes = normalizeBytes(value);
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
    }
    let binary = "";
    const block = 0x8000;
    for (let index = 0; index < bytes.length; index += block) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + block));
    }
    return btoa(binary);
  }

  function safeNow(now) {
    const value = typeof now === "function" ? now() : now;
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid clock value");
    return value;
  }

  function validateBeginRequest(request, now) {
    if (!request || typeof request !== "object") throw codedError("invalid_snapshot_request");
    if (!UUID_V4.test(request.snapshot_id || "")) throw codedError("invalid_snapshot_id");
    if (request.schema_version !== constants.SCHEMA_VERSION) throw codedError("unsupported_snapshot_schema");
    if (!["7", "30", "90", "all"].includes(request.history_range)) throw codedError("invalid_history_range");
    const fixed = [
      ["chunk_size", constants.CHUNK_SIZE_BYTES],
      ["max_total_bytes", constants.MAX_TOTAL_BYTES],
      ["max_category_bytes", constants.MAX_CATEGORY_BYTES],
      ["max_items_per_category", constants.MAX_ITEMS_PER_CATEGORY],
    ];
    for (const [key, expected] of fixed) {
      if (request[key] !== expected) throw codedError("invalid_snapshot_limits");
    }
    const deadlineAt = Date.parse(request.deadline_at);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= now || deadlineAt - now > constants.CAPTURE_DEADLINE_MS) {
      throw codedError("invalid_snapshot_deadline");
    }
    return deadlineAt;
  }

  function requestFingerprint(request) {
    return JSON.stringify([
      request.schema_version,
      request.history_range,
      request.chunk_size,
      request.max_total_bytes,
      request.max_category_bytes,
      request.max_items_per_category,
      request.deadline_at,
    ]);
  }

  function publicStatus(job) {
    if (job.status === "failed") {
      return {
        status: "failed",
        snapshot_id: job.snapshot_id,
        error_code: job.error_code,
      };
    }
    if (job.status === "ready") {
      return {
        status: "ready",
        snapshot_id: job.snapshot_id,
        manifest_base64: job.manifest_base64,
        manifest_sha256: job.manifest_sha256,
      };
    }
    return {
      status: "pending",
      snapshot_id: job.snapshot_id,
      poll_after_ms: 1000,
      progress: {
        phase: constants.CATEGORIES[job.phase_index] || "finalize",
        completed: job.phase_index,
        total: constants.CATEGORIES.length,
      },
    };
  }

  function unavailableDescriptor() {
    return { available: false, count: 0, byte_length: 0, sha256: "", chunk_count: 0 };
  }

  function safeFailureCode(error, category) {
    const allowed = new Set([
      constants.ERROR_SNAPSHOT_TOO_LARGE,
      constants.ERROR_SNAPSHOT_ACQUISITION_TIMEOUT,
      constants.ERROR_HISTORY_API,
      constants.ERROR_HISTORY_INVALID_ITEM,
      constants.ERROR_HISTORY_WINDOW_INCOMPLETE,
    ]);
    if (error && allowed.has(error.code)) return error.code;
    return `${category}_api_error`;
  }

  function strictChromeCall(chromeAPI, category, invoke) {
    return new Promise((resolve, reject) => {
      try {
        invoke((items) => {
          const lastError = chromeAPI.runtime && chromeAPI.runtime.lastError;
          if (lastError) {
            reject(codedError(`${category}_api_error`));
            return;
          }
          if (!Array.isArray(items)) {
            reject(codedError(`${category}_api_error`));
            return;
          }
          resolve(items);
        });
      } catch (_error) {
        reject(codedError(`${category}_api_error`));
      }
    });
  }

  function createChromeSnapshotCollectors(chromeAPI) {
    const requireAPI = (name, method) => {
      if (!chromeAPI || !chromeAPI[name] || typeof chromeAPI[name][method] !== "function") {
        throw codedError(`${name}_api_error`);
      }
    };
    return {
      cookies: async () => {
        requireAPI("cookies", "getAll");
        return strictChromeCall(chromeAPI, "cookies", (done) => chromeAPI.cookies.getAll({}, done));
      },
      bookmarks: async () => {
        requireAPI("bookmarks", "getTree");
        return strictChromeCall(chromeAPI, "bookmarks", (done) => chromeAPI.bookmarks.getTree(done));
      },
      downloads: async () => {
        requireAPI("downloads", "search");
        return strictChromeCall(chromeAPI, "downloads", (done) => chromeAPI.downloads.search({}, done));
      },
      tabs: async () => {
        requireAPI("tabs", "query");
        const tabs = await strictChromeCall(chromeAPI, "tabs", (done) => chromeAPI.tabs.query({ currentWindow: true }, done));
        return tabs.slice().sort((left, right) => (left.index || 0) - (right.index || 0));
      },
    };
  }

  function effectiveLimits(options) {
    const requested = options.limits || {};
    const lower = (value, fixed) => {
      if (value === undefined) return fixed;
      if (!Number.isSafeInteger(value) || value <= 0 || value > fixed) throw new Error("Invalid controller limit");
      return value;
    };
    return {
      maxTotalBytes: lower(requested.maxTotalBytes, constants.MAX_TOTAL_BYTES),
      maxCategoryBytes: lower(requested.maxCategoryBytes, constants.MAX_CATEGORY_BYTES),
      maxItems: lower(requested.maxItems, constants.MAX_ITEMS_PER_CATEGORY),
    };
  }

  function createSnapshotJobController(options = {}) {
    const store = options.store || storeAPI.createIndexedDBSnapshotStore();
    const now = options.now || Date.now;
    const sensorVersion = options.sensorVersion || "0.2.1";
    const collectors = options.collectors || createChromeSnapshotCollectors(options.chrome || globalThis.chrome);
    const limits = effectiveLimits(options);
    const historyLimits = { ...(options.historyLimits || {}), maxItems: limits.maxItems };
    const historyAdapters = options.historyAdapters || (
      options.chrome || globalThis.chrome
        ? { search: historyAPI.createChromeHistorySearch(options.chrome || globalThis.chrome) }
        : undefined
    );

    async function persist(job) {
      job.expires_at = safeNow(now) + constants.SENSOR_STAGING_TTL_MS;
      await store.putJob(job);
    }

    async function begin(request) {
      const at = safeNow(now);
      const deadlineAt = validateBeginRequest(request, at);
      const existing = await store.getJob(request.snapshot_id);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint(request)) {
          throw codedError("snapshot_request_mismatch");
        }
        existing.expires_at = at + constants.SENSOR_STAGING_TTL_MS;
        await store.putJob(existing);
        return publicStatus(existing);
      }
      const job = {
        snapshot_id: request.snapshot_id,
        request_fingerprint: requestFingerprint(request),
        schema_version: constants.SCHEMA_VERSION,
        sensor_version: sensorVersion,
        history_range: request.history_range,
        status: "pending",
        error_code: "",
        phase_index: 0,
        active: false,
        capture_started_at: new Date(at).toISOString(),
        capture_end_time_ms: at,
        deadline_at_ms: deadlineAt,
        expires_at: at + constants.SENSOR_STAGING_TTL_MS,
        fields: {},
        total_bytes: 0,
        total_chunks: 0,
        history_truncated: false,
      };
      await store.putJob(job);
      return publicStatus(job);
    }

    async function freezeCategory(job, category, items) {
      if (!Array.isArray(items)) throw codedError(`${category}_api_error`);
      if (items.length > limits.maxItems) throw codedError(constants.ERROR_SNAPSHOT_TOO_LARGE);
      let serialized;
      try {
        serialized = JSON.stringify(items);
      } catch (_error) {
        throw codedError(`${category}_api_error`);
      }
      if (typeof serialized !== "string") throw codedError(`${category}_api_error`);
      const bytes = new TextEncoder().encode(serialized);
      if (bytes.byteLength > limits.maxCategoryBytes || job.total_bytes + bytes.byteLength > limits.maxTotalBytes) {
        throw codedError(constants.ERROR_SNAPSHOT_TOO_LARGE);
      }
      const categorySHA256 = await sha256Hex(bytes);
      const chunkCount = Math.ceil(bytes.byteLength / constants.CHUNK_SIZE_BYTES);
      await store.putCategoryBytes(job.snapshot_id, category, bytes);
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * constants.CHUNK_SIZE_BYTES;
        const chunkBytes = bytes.slice(start, Math.min(bytes.byteLength, start + constants.CHUNK_SIZE_BYTES));
        await store.putChunk({
          snapshot_id: job.snapshot_id,
          category,
          chunk_index: index,
          chunk_count: chunkCount,
          byte_length: chunkBytes.byteLength,
          chunk_sha256: await sha256Hex(chunkBytes),
          category_sha256: categorySHA256,
          bytes: chunkBytes,
        });
      }
      job.fields[category] = {
        available: true,
        count: items.length,
        byte_length: bytes.byteLength,
        sha256: categorySHA256,
        chunk_count: chunkCount,
      };
      job.total_bytes += bytes.byteLength;
      job.total_chunks += chunkCount;
    }

    async function collectHistory(job) {
      if (typeof collectors.history === "function") {
        const items = await collectors.history(captureContext(job));
        await freezeCategory(job, "history", items);
        return true;
      }
      if (!historyAdapters || typeof historyAdapters.search !== "function") {
        throw codedError(constants.ERROR_HISTORY_API);
      }
      if (!job.history_state) {
        job.history_state = historyAPI.createHistoryCaptureState({
          historyRange: job.history_range,
          now: job.capture_end_time_ms,
          deadlineAt: job.deadline_at_ms,
          resultCeiling: historyLimits.resultCeiling,
          minimumWindowMs: historyLimits.minimumWindowMs,
          maxItems: limits.maxItems,
        });
        await persist(job);
      }
      const adapters = {
        ...historyAdapters,
        checkpoint: async (state) => {
          job.history_state = state;
          await persist(job);
        },
      };
      const result = await historyAPI.advanceHistoryCapture(job.history_state, adapters, historyLimits);
      job.history_state = result.state;
      if (result.status === "failed") throw codedError(result.error_code);
      if (result.status === "pending") return false;
      job.history_truncated = result.truncated;
      await freezeCategory(job, "history", result.items);
      return true;
    }

    function captureContext(job) {
      return {
        snapshotID: job.snapshot_id,
        historyRange: job.history_range,
        captureWindow: {
          startedAt: job.capture_started_at,
          endTime: job.capture_end_time_ms,
          deadlineAt: job.deadline_at_ms,
        },
      };
    }

    async function finalize(job) {
      const fields = {};
      for (const category of constants.CATEGORIES) fields[category] = { ...job.fields[category] };
      const manifest = {
        schema_version: constants.SCHEMA_VERSION,
        sensor_version: sensorVersion,
        snapshot_id: job.snapshot_id,
        capture_started_at: job.capture_started_at,
        capture_completed_at: new Date(safeNow(now)).toISOString(),
        history_coverage: job.history_range,
        history_truncated: job.history_truncated,
        fields,
      };
      const canonical = canonicalize(manifest);
      const bytes = new TextEncoder().encode(canonical);
      job.manifest_base64 = bytesToBase64(bytes);
      job.manifest_sha256 = await sha256Hex(bytes);
      job.status = "ready";
    }

    async function status(request) {
      if (!request || !UUID_V4.test(request.snapshot_id || "")) throw codedError("invalid_snapshot_id");
      const job = await store.getJob(request.snapshot_id);
      if (!job) throw codedError("snapshot_not_found");
      if (job.status !== "pending") {
        await persist(job);
        return publicStatus(job);
      }
      if (safeNow(now) >= job.deadline_at_ms) {
        job.status = "failed";
        job.error_code = constants.ERROR_SNAPSHOT_ACQUISITION_TIMEOUT;
        job.active = false;
        await persist(job);
        return publicStatus(job);
      }

      const category = constants.CATEGORIES[job.phase_index];
      if (!category) {
        await finalize(job);
        await persist(job);
        return publicStatus(job);
      }
      job.active = true;
      await persist(job);
      try {
        let complete = true;
        if (category === "history") {
          complete = await collectHistory(job);
        } else {
          const collector = collectors[category];
          if (typeof collector !== "function") throw codedError(`${category}_api_error`);
          await freezeCategory(job, category, await collector(captureContext(job)));
        }
        if (complete) job.phase_index += 1;
        if (job.phase_index >= constants.CATEGORIES.length) await finalize(job);
      } catch (error) {
        job.fields[category] = unavailableDescriptor();
        job.status = "failed";
        job.error_code = safeFailureCode(error, category);
      }
      job.active = false;
      await persist(job);
      return publicStatus(job);
    }

    async function chunk(request) {
      if (!request || !UUID_V4.test(request.snapshot_id || "")) throw codedError("invalid_snapshot_id");
      if (!categorySet.has(request.category)) throw codedError("invalid_snapshot_category");
      if (!Number.isSafeInteger(request.chunk_index) || request.chunk_index < 0) throw codedError("invalid_snapshot_chunk");
      const job = await store.getJob(request.snapshot_id);
      if (!job) throw codedError("snapshot_not_found");
      if (job.status !== "ready") throw codedError("snapshot_not_ready");
      const descriptor = job.fields[request.category];
      if (!descriptor || !descriptor.available || request.chunk_index >= descriptor.chunk_count) {
        throw codedError("invalid_snapshot_chunk");
      }
      const stored = await store.getChunk(request.snapshot_id, request.category, request.chunk_index);
      if (!stored || stored.snapshot_id !== request.snapshot_id || stored.category !== request.category ||
        stored.chunk_index !== request.chunk_index) {
        throw codedError("invalid_snapshot_chunk");
      }
      await persist(job);
      return {
        snapshot_id: stored.snapshot_id,
        category: stored.category,
        chunk_index: stored.chunk_index,
        chunk_count: stored.chunk_count,
        byte_length: stored.byte_length,
        chunk_sha256: stored.chunk_sha256,
        category_sha256: stored.category_sha256,
        bytes_base64: bytesToBase64(stored.bytes),
      };
    }

    async function release(request) {
      if (!request || !UUID_V4.test(request.snapshot_id || "")) throw codedError("invalid_snapshot_id");
      await store.deleteSnapshot(request.snapshot_id);
      return { released: true };
    }

    async function gc(at = safeNow(now)) {
      let released = 0;
      for (const job of await store.listJobs()) {
        if (!job.active && Number.isFinite(job.expires_at) && job.expires_at <= at) {
          await store.deleteSnapshot(job.snapshot_id);
          released += 1;
        }
      }
      return { released };
    }

    return Object.freeze({ begin, chunk, gc, release, status });
  }

  return Object.freeze({
    bytesToBase64,
    createChromeSnapshotCollectors,
    createSnapshotJobController,
    sha256Hex,
  });
});
