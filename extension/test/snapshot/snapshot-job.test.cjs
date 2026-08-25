const assert = require("node:assert/strict");
const test = require("node:test");

const constants = require("../../src/bg/snapshot/constants.js");
const { createMemoryIDBAdapter, createSnapshotStore } = require("../../src/bg/snapshot/indexeddb-store.js");
const { createSnapshotJobController, sha256Hex } = require("../../src/bg/snapshot/snapshot-job.js");

const SNAPSHOT_ID = "11111111-2222-4333-8444-555555555555";
const SECOND_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = Date.UTC(2026, 7, 24, 6, 31, 52);

function beginRequest(snapshotID = SNAPSHOT_ID, historyRange = "all") {
  return {
    snapshot_id: snapshotID,
    schema_version: 1,
    history_range: historyRange,
    chunk_size: constants.CHUNK_SIZE_BYTES,
    max_total_bytes: constants.MAX_TOTAL_BYTES,
    max_category_bytes: constants.MAX_CATEGORY_BYTES,
    max_items_per_category: constants.MAX_ITEMS_PER_CATEGORY,
    deadline_at: new Date(NOW + constants.CAPTURE_DEADLINE_MS).toISOString(),
  };
}

function basicCollectors(overrides = {}) {
  const defaults = {
    cookies: async () => [{ name: "sid", value: "safe" }],
    history: async () => [{ url: "https://history.test/", lastVisitTime: 1 }],
    bookmarks: async () => [{ title: "root", children: [] }],
    downloads: async () => [{ url: "https://download.test/a.zip" }],
    tabs: async () => [{ url: "https://tab.test/", active: true }],
  };
  return { ...defaults, ...overrides };
}

async function drain(controller, snapshotID = SNAPSHOT_ID, max = 40) {
  let result;
  for (let i = 0; i < max; i += 1) {
    result = await controller.status({ snapshot_id: snapshotID });
    if (result.status !== "pending") return result;
  }
  throw new Error(`snapshot did not finish: ${JSON.stringify(result)}`);
}

test("snapshot job BEGIN is idempotent, pending-fast, and all collectors share one capture window", async () => {
  const store = createSnapshotStore(createMemoryIDBAdapter());
  const windows = [];
  let calls = 0;
  const collectors = {};
  for (const category of constants.CATEGORIES) {
    collectors[category] = async (context) => {
      calls += 1;
      windows.push(context.captureWindow);
      return [];
    };
  }
  const controller = createSnapshotJobController({ store, collectors, now: () => NOW });
  const first = await controller.begin(beginRequest());
  const second = await controller.begin(beginRequest());
  assert.deepEqual(first, second);
  assert.equal(first.status, "pending");
  assert.equal(calls, 0, "BEGIN must not block on a Chrome collector");

  const ready = await drain(controller);
  assert.equal(ready.status, "ready");
  assert.equal(calls, 5);
  assert.ok(windows.every((window) => window.startedAt === windows[0].startedAt));
  assert.ok(windows.every((window) => window.endTime === windows[0].endTime));
  assert.ok(windows.every((window) => window.deadlineAt === windows[0].deadlineAt));
});

test("snapshot job category failure is unavailable, terminal, and never leaks the error payload", async () => {
  const sentinel = "SENTINEL_COOKIE_VALUE_DO_NOT_LEAK";
  const store = createSnapshotStore(createMemoryIDBAdapter());
  const controller = createSnapshotJobController({
    store,
    collectors: basicCollectors({
      cookies: async () => {
        throw new Error(`collector failed near ${sentinel}`);
      },
    }),
    now: () => NOW,
  });
  await controller.begin(beginRequest());
  const failed = await controller.status({ snapshot_id: SNAPSHOT_ID });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "cookies_api_error");
  assert.equal(JSON.stringify(failed).includes(sentinel), false);
  const job = await store.getJob(SNAPSHOT_ID);
  assert.deepEqual(job.fields.cookies, {
    available: false,
    count: 0,
    byte_length: 0,
    sha256: "",
    chunk_count: 0,
  });
  assert.equal(job.manifest_base64, undefined);
});

test("snapshot job freezes authoritative empty arrays as exact UTF-8 []", async () => {
  const store = createSnapshotStore(createMemoryIDBAdapter());
  const controller = createSnapshotJobController({
    store,
    collectors: basicCollectors(Object.fromEntries(constants.CATEGORIES.map((category) => [category, async () => []]))),
    now: () => NOW,
  });
  await controller.begin(beginRequest());
  const ready = await drain(controller);
  const manifestBytes = Buffer.from(ready.manifest_base64, "base64");
  assert.equal(ready.manifest_sha256, await sha256Hex(manifestBytes));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const emptyDigest = await sha256Hex(new TextEncoder().encode("[]"));
  for (const category of constants.CATEGORIES) {
    assert.deepEqual(manifest.fields[category], {
      available: true,
      count: 0,
      byte_length: 2,
      sha256: emptyDigest,
      chunk_count: 1,
    });
    assert.equal(new TextDecoder().decode(await store.getCategoryBytes(SNAPSHOT_ID, category)), "[]");
  }
});

test("snapshot job serializes once and serves repeatable immutable chunks with strict request validation", async () => {
  let toJSONCalls = 0;
  const large = {
    toJSON() {
      toJSONCalls += 1;
      return { url: "https://large.test/", payload: "x".repeat(constants.CHUNK_SIZE_BYTES + 64) };
    },
  };
  const store = createSnapshotStore(createMemoryIDBAdapter());
  const controller = createSnapshotJobController({
    store,
    collectors: basicCollectors({ history: async () => [large] }),
    now: () => NOW,
  });
  await controller.begin(beginRequest());
  const ready = await drain(controller);
  assert.equal(ready.status, "ready");
  assert.equal(toJSONCalls, 1);

  const first = await controller.chunk({ snapshot_id: SNAPSHOT_ID, category: "history", chunk_index: 0 });
  const repeated = await controller.chunk({ snapshot_id: SNAPSHOT_ID, category: "history", chunk_index: 0 });
  const second = await controller.chunk({ snapshot_id: SNAPSHOT_ID, category: "history", chunk_index: 1 });
  assert.deepEqual(repeated, first);
  assert.equal(first.snapshot_id, SNAPSHOT_ID);
  assert.equal(first.category, "history");
  assert.equal(first.chunk_index, 0);
  assert.equal(first.chunk_count, 2);
  assert.equal(Buffer.from(first.bytes_base64, "base64").length, constants.CHUNK_SIZE_BYTES);
  assert.ok(Buffer.from(second.bytes_base64, "base64").length < constants.CHUNK_SIZE_BYTES);
  assert.equal(toJSONCalls, 1, "CHUNK must read frozen bytes, never serialize source objects again");

  await assert.rejects(() => controller.chunk({ snapshot_id: SECOND_ID, category: "history", chunk_index: 0 }), /snapshot/i);
  await assert.rejects(() => controller.chunk({ snapshot_id: SNAPSHOT_ID, category: "sessions", chunk_index: 0 }), /category/i);
  await assert.rejects(() => controller.chunk({ snapshot_id: SNAPSHOT_ID, category: "history", chunk_index: 2 }), /chunk/i);
});

test("snapshot history resumes persisted bisection after worker termination on every window", async () => {
  const store = createSnapshotStore(createMemoryIDBAdapter());
  const queries = [];
  const makeController = () => createSnapshotJobController({
    store,
    collectors: basicCollectors({ history: undefined }),
    historyAdapters: {
      now: () => NOW + 1,
      search: async (query) => {
        queries.push({ ...query });
        if (queries.length === 1) {
          return [{ url: "https://full-1.test/" }, { url: "https://full-2.test/" }];
        }
        return [{ url: `https://piece-${queries.length}.test/`, lastVisitTime: queries.length }];
      },
    },
    historyLimits: { resultCeiling: 2, minimumWindowMs: 1 },
    now: () => NOW,
  });
  let controller = makeController();
  await controller.begin(beginRequest());
  await controller.status({ snapshot_id: SNAPSHOT_ID }); // cookies
  let final;
  for (let i = 0; i < 20; i += 1) {
    controller = makeController(); // simulate MV3 termination/reload
    final = await controller.status({ snapshot_id: SNAPSHOT_ID });
    if (final.status !== "pending") break;
  }
  assert.equal(final.status, "ready");
  assert.equal(queries.length, 3, "the saturated root window must not be repeated after checkpoint");
  const history = JSON.parse(new TextDecoder().decode(await store.getCategoryBytes(SNAPSHOT_ID, "history")));
  assert.deepEqual(history.map((item) => item.url), ["https://piece-2.test/", "https://piece-3.test/"]);
});

test("snapshot job enforces lowered test byte/item limits and the acquisition deadline", async (t) => {
  const cases = [
    {
      name: "category bytes",
      limits: { maxCategoryBytes: 32, maxTotalBytes: 1000, maxItems: 100 },
      collectors: basicCollectors({ cookies: async () => [{ value: "x".repeat(100) }] }),
      code: "snapshot_too_large",
    },
    {
      name: "total bytes",
      limits: { maxCategoryBytes: 200, maxTotalBytes: 100, maxItems: 100 },
      collectors: basicCollectors(Object.fromEntries(constants.CATEGORIES.map((category) => [category, async () => [{ value: `${category}-${"x".repeat(30)}` }]]))),
      code: "snapshot_too_large",
    },
    {
      name: "item count",
      limits: { maxCategoryBytes: 1000, maxTotalBytes: 5000, maxItems: 2 },
      collectors: basicCollectors({ tabs: async () => [{ url: "https://1.test/" }, { url: "https://2.test/" }, { url: "https://3.test/" }] }),
      code: "snapshot_too_large",
    },
  ];
  for (const tc of cases) {
    await t.test(tc.name, async () => {
      const store = createSnapshotStore(createMemoryIDBAdapter());
      const controller = createSnapshotJobController({ store, collectors: tc.collectors, limits: tc.limits, now: () => NOW });
      await controller.begin(beginRequest());
      const result = await drain(controller);
      assert.equal(result.status, "failed");
      assert.equal(result.error_code, tc.code);
    });
  }

  let clock = NOW;
  const store = createSnapshotStore(createMemoryIDBAdapter());
  const controller = createSnapshotJobController({ store, collectors: basicCollectors(), now: () => clock });
  await controller.begin(beginRequest());
  clock = NOW + constants.CAPTURE_DEADLINE_MS;
  const timeout = await controller.status({ snapshot_id: SNAPSHOT_ID });
  assert.equal(timeout.status, "failed");
  assert.equal(timeout.error_code, "snapshot_acquisition_timeout");
});

test("snapshot RELEASE and staging TTL GC are idempotent and preserve active jobs", async () => {
  const store = createSnapshotStore(createMemoryIDBAdapter());
  const controller = createSnapshotJobController({ store, collectors: basicCollectors(), now: () => NOW });
  await controller.begin(beginRequest(SNAPSHOT_ID));
  await controller.begin(beginRequest(SECOND_ID));
  const expired = await store.getJob(SNAPSHOT_ID);
  expired.expires_at = NOW - 1;
  expired.active = false;
  await store.putJob(expired);
  const active = await store.getJob(SECOND_ID);
  active.expires_at = NOW - 1;
  active.active = true;
  await store.putJob(active);

  assert.deepEqual(await controller.gc(NOW), { released: 1 });
  assert.equal(await store.getJob(SNAPSHOT_ID), undefined);
  assert.ok(await store.getJob(SECOND_ID));
  assert.deepEqual(await controller.release({ snapshot_id: SECOND_ID }), { released: true });
  assert.deepEqual(await controller.release({ snapshot_id: SECOND_ID }), { released: true });
});
