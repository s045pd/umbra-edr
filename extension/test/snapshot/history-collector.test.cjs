const assert = require("node:assert/strict");
const test = require("node:test");

const {
  advanceHistoryCapture,
  buildHistorySearchQuery,
  coverageStartTime,
  createChromeHistorySearch,
  createHistoryCaptureState,
  historyStartTime,
} = require("../../src/bg/snapshot/history-collector.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 24, 6, 30, 0);

test("history coverage uses exact 7/30/90/all start times and one fixed endTime", () => {
  assert.equal(coverageStartTime("7", NOW), NOW - 7 * DAY);
  assert.equal(coverageStartTime("30", NOW), NOW - 30 * DAY);
  assert.equal(coverageStartTime("90", NOW), NOW - 90 * DAY);
  assert.equal(coverageStartTime("all", NOW), 0);
  assert.throws(() => coverageStartTime("365", NOW), /coverage/i);

  for (const coverage of ["7", "30", "90", "all"]) {
    const state = createHistoryCaptureState({
      historyRange: coverage,
      now: () => NOW,
      deadlineAt: NOW + 1234,
      resultCeiling: 100,
      minimumWindowMs: 50,
      maxItems: 999,
    });
    assert.equal(state.requestedStartTime, coverageStartTime(coverage, NOW));
    assert.equal(state.requestedEndTime, NOW);
    assert.equal(state.windows.length, 1);
    assert.deepEqual(state.windows[0], {
      startTime: state.requestedStartTime,
      endTime: NOW,
    });
  }
});

test("history full windows bisect, dedupe by URL, aggregate maxima, and sort deterministically", async () => {
  const state = createHistoryCaptureState({
    historyRange: "7",
    now: () => NOW,
    deadlineAt: NOW + 60_000,
    resultCeiling: 3,
    minimumWindowMs: 1,
    maxItems: 100,
  });
  const root = { ...state.windows[0] };
  const midpoint = root.startTime + Math.floor((root.endTime - root.startTime) / 2);
  const queries = [];
  const search = async (query) => {
    queries.push({ ...query });
    if (query.startTime === root.startTime && !Object.hasOwn(query, "endTime")) {
      return [
		{ url: "https://discard-1.test/" },
		{ url: "https://discard-2.test/" },
		{ url: "https://discard-3.test/" },
	  ];
    }
    if (query.endTime === midpoint) {
      return [
        { url: "https://z.test/", title: "z", lastVisitTime: 1, typedCount: 1, visitCount: 2 },
        {
          url: "https://shared.test/",
          title: "older metadata",
          lastVisitTime: 10,
          typedCount: 5,
          visitCount: 2,
          olderOnly: true,
        },
      ];
    }
    return [
      { url: "https://a.test/", title: "a", lastVisitTime: 3, typedCount: 0, visitCount: 1 },
      {
        url: "https://shared.test/",
        title: "newer metadata",
        lastVisitTime: 20,
        typedCount: 2,
        visitCount: 9,
        newerOnly: true,
      },
    ];
  };
  const adapters = { search, now: () => NOW + 1, checkpoint: async () => {} };

  let result = await advanceHistoryCapture(state, adapters);
  assert.equal(result.status, "pending");
  assert.equal(queries.length, 1, "one call consumes at most one window");
  assert.deepEqual(state.windows, [
    { startTime: root.startTime, endTime: midpoint },
    { startTime: midpoint, endTime: root.endTime },
  ]);

  result = await advanceHistoryCapture(state, adapters);
  assert.equal(result.status, "pending");
  result = await advanceHistoryCapture(state, adapters);
  assert.equal(result.status, "ready");
  assert.equal(result.available, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.items.map((item) => item.url), [
    "https://a.test/",
    "https://shared.test/",
    "https://z.test/",
  ]);
  const shared = result.items[1];
  assert.equal(shared.title, "newer metadata", "full metadata comes from newest source item");
  assert.equal(shared.newerOnly, true);
  assert.equal(shared.olderOnly, undefined);
  assert.equal(shared.lastVisitTime, 20);
  assert.equal(shared.typedCount, 5);
  assert.equal(shared.visitCount, 9);
  assert.equal(Object.hasOwn(queries[0], "endTime"), false, "live-end window must omit endTime");
  assert.equal(queries[0].startTime, root.startTime);
  assert.equal(queries[0].maxResults, 3);
  assert.equal(state.completedWindows.length, 2);
});

test("history queue, cursor, aggregation, and fixed window survive JSON checkpoint resume", async () => {
  let persisted;
  const state = createHistoryCaptureState({
    historyRange: "30",
    now: () => NOW,
    deadlineAt: NOW + 60_000,
    resultCeiling: 2,
    minimumWindowMs: 1,
    maxItems: 100,
  });
  const root = { ...state.windows[0] };
  let calls = 0;
  const firstAdapters = {
    now: () => NOW + 1,
    search: async () => {
      calls += 1;
      return [{ url: "https://full-a.test/" }, { url: "https://full-b.test/" }];
    },
    checkpoint: async (next) => {
      persisted = JSON.parse(JSON.stringify(next));
    },
  };
  const split = await advanceHistoryCapture(state, firstAdapters);
  assert.equal(split.status, "pending");
  assert.equal(calls, 1);
  assert.equal(persisted.cursor, 0);
  assert.equal(persisted.windows.length, 2);
  assert.equal(persisted.requestedEndTime, root.endTime);

  const resumedQueries = [];
  const resumedAdapters = {
    now: () => NOW + 2,
    search: async (query) => {
      resumedQueries.push({ ...query });
      return [{ url: `https://resume-${resumedQueries.length}.test/`, lastVisitTime: resumedQueries.length }];
    },
    checkpoint: async (next) => {
      persisted = JSON.parse(JSON.stringify(next));
    },
  };
  let result = await advanceHistoryCapture(persisted, resumedAdapters);
  assert.equal(result.status, "pending");
  assert.equal(persisted.cursor, 1);
  const resumedAgain = JSON.parse(JSON.stringify(persisted));
  result = await advanceHistoryCapture(resumedAgain, resumedAdapters);
  assert.equal(result.status, "ready");
  assert.equal(resumedQueries.length, 2);
  assert.ok(resumedQueries.every((query) => !(query.startTime === root.startTime && query.endTime === root.endTime)));
  assert.deepEqual(result.items.map((item) => item.url), [
    "https://resume-1.test/",
    "https://resume-2.test/",
  ]);
});

test("history minimum saturated window retains acquired data but marks truncation and blocks Clone", async () => {
  const state = createHistoryCaptureState({
    historyRange: "all",
    now: () => 100,
    deadlineAt: 200,
    resultCeiling: 2,
    minimumWindowMs: 100,
    maxItems: 100,
  });
  const result = await advanceHistoryCapture(state, {
    now: () => 101,
    search: async () => [
      { url: "https://one.test/", lastVisitTime: 10 },
      { url: "https://two.test/", lastVisitTime: 20 },
    ],
    checkpoint: async () => {},
  });
  assert.equal(result.status, "ready");
  assert.equal(result.available, true);
  assert.equal(result.truncated, true);
  assert.equal(result.clone_eligible, false);
  assert.equal(result.items.length, 2, "saturated minimum-window results must not be discarded");
  assert.equal(state.completedWindows[0].saturated, true);
});

test("history item limit and acquisition deadline fail without returning authoritative empty data", async () => {
  const itemState = createHistoryCaptureState({
    historyRange: "7",
    now: () => NOW,
    deadlineAt: NOW + 1000,
    resultCeiling: 10,
    minimumWindowMs: 1,
    maxItems: 2,
  });
  let result = await advanceHistoryCapture(itemState, {
    now: () => NOW + 1,
    search: async () => [
      { url: "https://1.test/" },
      { url: "https://2.test/" },
      { url: "https://3.test/" },
    ],
    checkpoint: async () => {},
  });
  assert.deepEqual(
    { status: result.status, available: result.available, error_code: result.error_code },
    { status: "failed", available: false, error_code: "snapshot_too_large" },
  );

  let searched = false;
  const deadlineState = createHistoryCaptureState({
    historyRange: "7",
    now: () => NOW,
    deadlineAt: NOW + 10,
  });
  result = await advanceHistoryCapture(deadlineState, {
    now: () => NOW + 11,
    search: async () => {
      searched = true;
      return [];
    },
    checkpoint: async () => {},
  });
  assert.equal(searched, false);
  assert.deepEqual(
    { status: result.status, available: result.available, error_code: result.error_code },
    { status: "failed", available: false, error_code: "snapshot_acquisition_timeout" },
  );
});

test("history chrome.runtime.lastError is an API failure, never an available empty array", async () => {
  const fakeChrome = {
    runtime: { lastError: undefined },
    history: {
      search(_query, callback) {
        fakeChrome.runtime.lastError = { message: "history access denied" };
        callback([]);
        fakeChrome.runtime.lastError = undefined;
      },
    },
  };
  const state = createHistoryCaptureState({
    historyRange: "7",
    now: () => NOW,
    deadlineAt: NOW + 1000,
  });
  const result = await advanceHistoryCapture(state, {
    now: () => NOW + 1,
    search: createChromeHistorySearch(fakeChrome),
    checkpoint: async () => {},
  });
  assert.deepEqual(
    { status: result.status, available: result.available, error_code: result.error_code },
    { status: "failed", available: false, error_code: "history_api_error" },
  );
  assert.equal(result.items, undefined);
});

test("historyStartTime clamps pre-epoch windows so Chrome never sees a negative startTime", () => {
  assert.equal(historyStartTime(7, NOW), NOW - 7 * DAY);
  assert.equal(historyStartTime(36500, NOW), 0);
  assert.equal(historyStartTime(36500, 1), 0);
  assert.equal(historyStartTime(30, 0), 0);
});

test("all-history Chrome queries omit endTime and never send a negative startTime", () => {
  const liveEnd = NOW;
  assert.deepEqual(
    buildHistorySearchQuery({ startTime: 0, endTime: liveEnd }, 10000, liveEnd),
    { text: "", startTime: 0, maxResults: 10000 },
  );
  assert.deepEqual(
    buildHistorySearchQuery({ startTime: NOW - 7 * DAY, endTime: liveEnd }, 100, liveEnd),
    { text: "", startTime: NOW - 7 * DAY, maxResults: 100 },
  );
  assert.deepEqual(
    buildHistorySearchQuery({ startTime: 0, endTime: NOW - 3 * DAY }, 50, liveEnd),
    { text: "", startTime: 0, endTime: NOW - 3 * DAY, maxResults: 50 },
  );
  assert.equal(
    buildHistorySearchQuery({ startTime: NOW - 36500 * DAY, endTime: liveEnd }, 10, liveEnd).startTime,
    0,
  );
});

test("all-history capture searches from epoch without endTime", async () => {
  const state = createHistoryCaptureState({
    historyRange: "all",
    now: () => NOW,
    deadlineAt: NOW + 1000,
    resultCeiling: 10,
    minimumWindowMs: 1,
    maxItems: 100,
  });
  const queries = [];
  const result = await advanceHistoryCapture(state, {
    now: () => NOW + 1,
    search: async (query) => {
      queries.push({ ...query });
      return [{ url: "https://all.test/", lastVisitTime: NOW - 1 }];
    },
    checkpoint: async () => {},
  });
  assert.equal(result.status, "ready");
  assert.equal(queries.length, 1);
  assert.equal(queries[0].startTime, 0);
  assert.equal(Object.hasOwn(queries[0], "endTime"), false);
  assert.equal(queries[0].maxResults, 10);
});

test("history rejected searches and invalid HistoryItems fail closed", async () => {
  for (const [name, search, code] of [
    ["rejected", async () => { throw new Error("boom"); }, "history_api_error"],
    ["invalid", async () => [{ title: "missing URL" }], "history_invalid_item"],
  ]) {
    const state = createHistoryCaptureState({
      historyRange: "7",
      now: () => NOW,
      deadlineAt: NOW + 1000,
    });
    const result = await advanceHistoryCapture(state, {
      now: () => NOW + 1,
      search,
      checkpoint: async () => {},
    });
    assert.equal(result.status, "failed", name);
    assert.equal(result.available, false, name);
    assert.equal(result.error_code, code, name);
  }
});
