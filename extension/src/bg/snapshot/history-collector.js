(function attachHistoryCollector(root, factory) {
  let constants = root.UmbraSnapshotConstants;
  if (!constants && typeof module === "object" && module && module.exports) {
    constants = require("./constants.js");
  }
  const api = factory(constants);
  root.UmbraSnapshotHistory = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeHistoryCollector(constants) {
  "use strict";

  if (!constants) {
    throw new Error("Umbra snapshot constants must load before the history collector");
  }

  const VALID_COVERAGE = new Set(["7", "30", "90", "all"]);

  function coverageStartTime(historyRange, endTime) {
    if (!VALID_COVERAGE.has(historyRange)) {
      throw new Error(`Invalid history coverage: ${historyRange}`);
    }
    if (!Number.isFinite(endTime) || endTime < 0) {
      throw new Error("Invalid history end time");
    }
    if (historyRange === "all") return 0;
    return Math.max(0, endTime - Number(historyRange) * constants.DAY_MS);
  }

  function positiveInteger(value, fallback, name) {
    const selected = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(selected) || selected <= 0) {
      throw new Error(`Invalid ${name}`);
    }
    return selected;
  }

  function readNow(now) {
    const value = typeof now === "function" ? now() : now;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Invalid capture time");
    }
    return value;
  }

  function createHistoryCaptureState(options = {}) {
    const historyRange = options.historyRange || "30";
    const endTime = readNow(options.now === undefined ? Date.now : options.now);
    const startTime = coverageStartTime(historyRange, endTime);
    const resultCeiling = positiveInteger(
      options.resultCeiling,
      constants.DEFAULT_HISTORY_RESULT_CEILING,
      "history result ceiling",
    );
    const minimumWindowMs = positiveInteger(
      options.minimumWindowMs,
      constants.DEFAULT_MIN_HISTORY_WINDOW_MS,
      "minimum history window",
    );
    const maxItems = positiveInteger(
      options.maxItems,
      constants.MAX_ITEMS_PER_CATEGORY,
      "history item limit",
    );
    const deadlineAt = options.deadlineAt === undefined
      ? endTime + constants.CAPTURE_DEADLINE_MS
      : readNow(options.deadlineAt);
    if (deadlineAt <= endTime) {
      throw new Error("History deadline must be after capture start");
    }

    return {
      version: 1,
      status: "pending",
      errorCode: "",
      historyRange,
      requestedStartTime: startTime,
      requestedEndTime: endTime,
      startedAt: endTime,
      deadlineAt,
      resultCeiling,
      minimumWindowMs,
      maxItems,
      windows: [{ startTime, endTime }],
      cursor: 0,
      completedWindows: [],
      itemsByURL: {},
      truncated: false,
    };
  }

  function createChromeHistorySearch(chromeAPI) {
    return function searchChromeHistory(query) {
      return new Promise((resolve, reject) => {
        if (!chromeAPI || !chromeAPI.history || typeof chromeAPI.history.search !== "function") {
          reject(codedError(constants.ERROR_HISTORY_API, "Chrome history API is unavailable"));
          return;
        }
        try {
          chromeAPI.history.search(query, (items) => {
            const lastError = chromeAPI.runtime && chromeAPI.runtime.lastError;
            if (lastError) {
              reject(codedError(constants.ERROR_HISTORY_API, lastError.message || "Chrome history API failed"));
              return;
            }
            if (!Array.isArray(items)) {
              reject(codedError(constants.ERROR_HISTORY_API, "Chrome history API returned a non-array"));
              return;
            }
            resolve(items);
          });
        } catch (error) {
          reject(codedError(constants.ERROR_HISTORY_API, error && error.message ? error.message : "Chrome history API failed"));
        }
      });
    };
  }

  function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function isValidHistoryItem(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    if (typeof item.url !== "string" || item.url.length === 0) return false;
    try {
      // Chrome may return http(s), file, chrome, data, and extension schemes.
      // URL parsing rejects arbitrary object keys such as "__proto__".
      new URL(item.url);
    } catch (_error) {
      return false;
    }
    for (const key of ["lastVisitTime", "typedCount", "visitCount"]) {
      if (item[key] !== undefined && (!Number.isFinite(item[key]) || item[key] < 0)) {
        return false;
      }
    }
    return true;
  }

  function stableObjectText(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableObjectText).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableObjectText(value[key])}`).join(",")}}`;
  }

  function numericValue(value) {
    return Number.isFinite(value) ? value : 0;
  }

  function mergeHistoryItem(existing, incoming) {
    if (!existing) return { ...incoming };
    const oldVisit = numericValue(existing.lastVisitTime);
    const newVisit = numericValue(incoming.lastVisitTime);
    let selected;
    if (newVisit > oldVisit) {
      selected = incoming;
    } else if (newVisit < oldVisit) {
      selected = existing;
    } else {
      selected = stableObjectText(incoming) > stableObjectText(existing) ? incoming : existing;
    }
    const merged = { ...selected, url: incoming.url };
    const lastVisitTime = Math.max(oldVisit, newVisit);
    const typedCount = Math.max(numericValue(existing.typedCount), numericValue(incoming.typedCount));
    const visitCount = Math.max(numericValue(existing.visitCount), numericValue(incoming.visitCount));
    if (existing.lastVisitTime !== undefined || incoming.lastVisitTime !== undefined) merged.lastVisitTime = lastVisitTime;
    if (existing.typedCount !== undefined || incoming.typedCount !== undefined) merged.typedCount = typedCount;
    if (existing.visitCount !== undefined || incoming.visitCount !== undefined) merged.visitCount = visitCount;
    return merged;
  }

  function sortedItems(state) {
    return Object.keys(state.itemsByURL)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((url) => state.itemsByURL[url]);
  }

  function resultFor(state) {
    if (state.status === "failed") {
      return {
        status: "failed",
        available: false,
        error_code: state.errorCode || constants.ERROR_HISTORY_WINDOW_INCOMPLETE,
        state,
      };
    }
    if (state.status === "ready") {
      return {
        status: "ready",
        available: true,
        coverage: state.historyRange,
        requested_start_time: state.requestedStartTime,
        requested_end_time: state.requestedEndTime,
        result_ceiling: state.resultCeiling,
        completed_windows: state.completedWindows.map((window) => ({ ...window })),
        truncated: state.truncated,
        clone_eligible: state.historyRange === "all" && !state.truncated,
        items: sortedItems(state),
        state,
      };
    }
    return {
      status: "pending",
      available: false,
      progress: { completed: state.cursor, total: state.windows.length },
      state,
    };
  }

  async function checkpoint(state, adapters) {
    if (adapters && typeof adapters.checkpoint === "function") {
      await adapters.checkpoint(state);
    }
  }

  async function fail(state, adapters, code) {
    state.status = "failed";
    state.errorCode = code;
    try {
      await checkpoint(state, adapters);
    } catch (_error) {
      // The original stable failure code is more useful than leaking storage
      // details or falsely returning an available empty array.
    }
    return resultFor(state);
  }

  function validWindow(window) {
    return window && Number.isFinite(window.startTime) && Number.isFinite(window.endTime) &&
      window.startTime >= 0 && window.endTime >= window.startTime;
  }

  async function advanceHistoryCapture(state, adapters = {}, limits = {}) {
    if (!state || typeof state !== "object" || state.version !== 1) {
      throw new Error("Invalid history capture state");
    }
    if (state.status === "ready" || state.status === "failed") return resultFor(state);

    const now = readNow(adapters.now === undefined ? Date.now : adapters.now);
    const deadlineAt = limits.deadlineAt === undefined ? state.deadlineAt : readNow(limits.deadlineAt);
    if (now >= deadlineAt) {
      return fail(state, adapters, constants.ERROR_SNAPSHOT_ACQUISITION_TIMEOUT);
    }
    const ceiling = positiveInteger(limits.resultCeiling, state.resultCeiling, "history result ceiling");
    const minimumWindowMs = positiveInteger(limits.minimumWindowMs, state.minimumWindowMs, "minimum history window");
    const maxItems = positiveInteger(limits.maxItems, state.maxItems, "history item limit");

    if (!Array.isArray(state.windows) || !Number.isSafeInteger(state.cursor) || state.cursor < 0) {
      return fail(state, adapters, constants.ERROR_HISTORY_WINDOW_INCOMPLETE);
    }
    if (state.cursor >= state.windows.length) {
      state.status = "ready";
      await checkpoint(state, adapters);
      return resultFor(state);
    }

    const window = state.windows[state.cursor];
    if (!validWindow(window) || typeof adapters.search !== "function") {
      return fail(state, adapters, constants.ERROR_HISTORY_WINDOW_INCOMPLETE);
    }

    let items;
    try {
      items = await adapters.search({
        text: "",
        startTime: window.startTime,
        endTime: window.endTime,
        maxResults: ceiling,
      });
    } catch (error) {
      const code = error && error.code === constants.ERROR_HISTORY_INVALID_ITEM
        ? constants.ERROR_HISTORY_INVALID_ITEM
        : constants.ERROR_HISTORY_API;
      return fail(state, adapters, code);
    }
    if (!Array.isArray(items)) {
      return fail(state, adapters, constants.ERROR_HISTORY_API);
    }
    for (const item of items) {
      if (!isValidHistoryItem(item)) {
        return fail(state, adapters, constants.ERROR_HISTORY_INVALID_ITEM);
      }
    }

    const saturated = items.length >= ceiling;
    const width = window.endTime - window.startTime;
    if (saturated && width > minimumWindowMs) {
      const midpoint = window.startTime + Math.floor(width / 2);
      if (midpoint <= window.startTime || midpoint >= window.endTime) {
        return fail(state, adapters, constants.ERROR_HISTORY_WINDOW_INCOMPLETE);
      }
      state.windows.splice(
        state.cursor,
        1,
        { startTime: window.startTime, endTime: midpoint },
        { startTime: midpoint, endTime: window.endTime },
      );
      await checkpoint(state, adapters);
      return resultFor(state);
    }

    for (const item of items) {
      const existing = Object.prototype.hasOwnProperty.call(state.itemsByURL, item.url)
        ? state.itemsByURL[item.url]
        : undefined;
      state.itemsByURL[item.url] = mergeHistoryItem(existing, item);
    }
    if (Object.keys(state.itemsByURL).length > maxItems) {
      return fail(state, adapters, constants.ERROR_SNAPSHOT_TOO_LARGE);
    }
    if (saturated) state.truncated = true;
    state.completedWindows.push({
      startTime: window.startTime,
      endTime: window.endTime,
      resultCount: items.length,
      saturated,
    });
    state.cursor += 1;
    if (state.cursor >= state.windows.length) state.status = "ready";
    await checkpoint(state, adapters);
    return resultFor(state);
  }

  return Object.freeze({
    advanceHistoryCapture,
    coverageStartTime,
    createChromeHistorySearch,
    createHistoryCaptureState,
    mergeHistoryItem,
  });
});
