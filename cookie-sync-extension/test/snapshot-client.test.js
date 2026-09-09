import assert from "node:assert/strict";
import test from "node:test";

import canonicalize from "../src/lib/canonicalize.js";
import { sha256Hex } from "../src/lib/hash.js";
import {
  SHADOWLINK_STORE_NAMES,
  SNAPSHOT_CATEGORIES,
  SNAPSHOT_CHUNK_SIZE_BYTES,
  SNAPSHOT_MAX_CATEGORY_BYTES,
} from "../src/lib/constants.js";
import { ShadowLinkDB } from "../src/bg/idb.js";
import { JobRunner } from "../src/bg/job-runner.js";
import { resolveSnapshot, resumeSnapshotDownload } from "../src/bg/snapshot-client.js";
import { FakeBrowser } from "./helpers/fake-browser.js";
import { MemoryTransactionDriver } from "./helpers/memory-driver.js";

const encoder = new TextEncoder();

function makeDB() {
  return new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
}

function requestFor(jobId = "job-1") {
  return {
    jobId,
    serverOrigin: "https://umbra.test",
    username: "proxy-user",
    password: "proxy-secret",
    historyRange: "all",
    preferLive: true,
  };
}

function splitBytes(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SNAPSHOT_CHUNK_SIZE_BYTES) {
    chunks.push(bytes.slice(offset, Math.min(offset + SNAPSHOT_CHUNK_SIZE_BYTES, bytes.byteLength)));
  }
  return chunks;
}

async function fixtureFor({ source = "live", data = {}, legacy = false } = {}) {
  const snapshotId = "a32d0c55-8b7d-4afd-b15b-ec99571f8b17";
  const values = {
    cookies: [{ name: "sid", value: "ok" }],
    history: [{ url: "https://example.test" }],
    bookmarks: [],
    downloads: [],
    tabs: [],
    ...data,
  };
  const fields = {};
  const raw = {};
  const chunks = {};
  for (const category of SNAPSHOT_CATEGORIES) {
    const value = values[category];
    if (value === undefined) {
      fields[category] = {
        available: false,
        legacy,
        count: 0,
        byte_length: 0,
        sha256: "",
        chunk_count: 0,
      };
      raw[category] = new Uint8Array();
      chunks[category] = [];
      continue;
    }
    raw[category] = encoder.encode(JSON.stringify(value));
    chunks[category] = splitBytes(raw[category]);
    fields[category] = {
      available: true,
      legacy,
      count: value.length,
      byte_length: raw[category].byteLength,
      sha256: await sha256Hex(raw[category]),
      chunk_count: chunks[category].length,
    };
  }

  const status = {
    status: "ready",
    job_id: "server-job-1",
    snapshot_id: snapshotId,
    source,
    fields,
    history_coverage: "all",
    history_truncated: false,
  };
  if (!legacy) {
    Object.assign(status, {
      schema_version: 1,
      sensor_version: "0.2.0",
      capture_started_at: "2026-08-24T06:31:52.000Z",
      capture_completed_at: "2026-08-24T06:32:00.000Z",
    });
    status.manifest_sha256 = await sha256Hex(
      encoder.encode(canonicalize(captureManifest(status))),
    );
  }
  return { status, values, raw, chunks };
}

function captureManifest(status) {
  const fields = {};
  for (const category of SNAPSHOT_CATEGORIES) {
    const source = status.fields[category];
    fields[category] = {
      available: source.available,
      count: source.count,
      byte_length: source.byte_length,
      sha256: source.sha256,
      chunk_count: source.chunk_count,
    };
  }
  return {
    schema_version: status.schema_version,
    sensor_version: status.sensor_version,
    snapshot_id: status.snapshot_id,
    capture_started_at: status.capture_started_at,
    capture_completed_at: status.capture_completed_at,
    history_coverage: status.history_coverage,
    history_truncated: status.history_truncated,
    fields,
  };
}

async function refreshManifestDigest(fixture) {
  fixture.status.manifest_sha256 = await sha256Hex(
    encoder.encode(canonicalize(captureManifest(fixture.status))),
  );
}

function jsonResponse(result, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { success: true, result } : result), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function chunkResponse(fixture, category, index, overrides = {}) {
  const bytes = fixture.chunks[category][index];
  const descriptor = fixture.status.fields[category];
  const body = overrides.body || bytes;
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "X-Snapshot-Id": fixture.status.snapshot_id,
    "X-Snapshot-Category": category,
    "X-Chunk-Index": String(index),
    "X-Chunk-Offset": String(index * SNAPSHOT_CHUNK_SIZE_BYTES),
    "X-Chunk-Count": String(descriptor.chunk_count),
    "X-Chunk-Length": String(body.byteLength),
    "X-Chunk-SHA256": await sha256Hex(body),
    "X-Category-SHA256": descriptor.sha256,
    "X-Manifest-SHA256": fixture.status.manifest_sha256 || "",
    ...overrides.headers,
  });
  return new Response(body, { status: overrides.status || 200, headers });
}

function makeFetch(fixture, { start, statusFlow = [], chunkOverride, beforeChunk } = {}) {
  const calls = [];
  let statusIndex = 0;
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    if (path.endsWith("get-bot-browser-snapshot")) {
      return jsonResponse(start || fixture.status);
    }
    if (path.endsWith("get-bot-browser-snapshot-status")) {
      const value = statusFlow[Math.min(statusIndex, statusFlow.length - 1)];
      statusIndex += 1;
      return jsonResponse(value);
    }
    if (path.endsWith("get-bot-browser-snapshot-chunk")) {
      await beforeChunk?.(body, calls);
      return chunkResponse(
        fixture,
        body.category,
        body.chunk_index,
        (await chunkOverride?.(body)) || {},
      );
    }
    throw new Error(`unexpected test path: ${path}`);
  };
  return { fetch, calls };
}

test("snapshot client polls pending jobs, downloads bounded chunks in order, and checkpoints each chunk", async () => {
  const largeHistoryValue = "h".repeat(SNAPSHOT_CHUNK_SIZE_BYTES + 4096);
  const fixture = await fixtureFor({ data: { history: [{ url: largeHistoryValue }] } });
  const db = makeDB();
  const pending = { status: "pending", job_id: "server-job-1", poll_after_ms: 25 };
  const sleeps = [];
  const { fetch, calls } = makeFetch(fixture, {
    start: pending,
    statusFlow: [pending, fixture.status],
    beforeChunk: async (body) => {
      if (body.chunk_index === 0) return;
      assert.ok(
        await db.getSnapshotChunk(
          "job-1",
          fixture.status.snapshot_id,
          body.category,
          body.chunk_index - 1,
        ),
        "previous chunk must be durable before requesting the next one",
      );
    },
  });

  const result = await resolveSnapshot(requestFor(), {
    db,
    fetch,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    now: (() => {
      let now = 1000;
      return () => (now += 10);
    })(),
    leaseOwner: "worker-a",
  });

  assert.deepEqual(result.categories.history, fixture.values.history);
  assert.equal(result.source, "live");
  assert.equal(result.trusted, true);
  assert.deepEqual(sleeps, [25, 25]);
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith("-chunk")).map((call) => [call.body.category, call.body.chunk_index]),
    [
      ["cookies", 0],
      ["history", 0],
      ["history", 1],
      ["bookmarks", 0],
      ["downloads", 0],
      ["tabs", 0],
    ],
  );
  assert.deepEqual(calls[0].body, {
    username: "proxy-user",
    password: "proxy-secret",
    history_range: "all",
    prefer_live: true,
  });
  const job = await db.getJob("job-1");
  assert.equal(job.state, "snapshot_ready");
  assert.equal(job.credentials.password, "proxy-secret", "credentials remain only in the owning job");
  const cacheJSON = JSON.stringify(await db.listSnapshotRecords("job-1", fixture.status.snapshot_id));
  assert.equal(cacheJSON.includes("proxy-secret"), false);
});

test("JobRunner Sync pulls live cookies while holding the mutation writer lease", async () => {
  const db = makeDB();
  const browser = new FakeBrowser();
  const calls = [];
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(options.body) });
    if (path.endsWith("/api/v1/get-bot-browser-cookies")) {
      return jsonResponse({ cookies: [] });
    }
    throw new Error(`unexpected test path: ${path}`);
  };
  const runner = new JobRunner({
    db,
    workerId: "sync-mutation-worker",
    now: () => 1000,
    syncDependencies: {
      adapters: browser.adapters(),
      fetch,
      randomUUID: () => "sync-archive",
    },
  });

  const result = await runner.handleMessage({
    type: "START_SYNC",
    request: {
      jobId: "sync-live-cookies",
      serverOrigin: "https://umbra.test",
      username: "proxy-user",
      password: "proxy-secret",
      options: { selected: { cookies: true }, historyRange: "30" },
    },
  });

  assert.equal(result.state, "sync_complete");
  assert.equal(result.source, "live");
  assert.equal(result.categories.cookies.status, "success");
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/api/v1/get-bot-browser-cookies"],
  );
});

test("snapshot client resumes at the first missing chunk and repeated immutable reads stay offline", async () => {
  const fixture = await fixtureFor({
    data: { history: [{ url: "r".repeat(SNAPSHOT_CHUNK_SIZE_BYTES + 2048) }] },
  });
  const db = makeDB();
  await db.putJob({
    job_id: "job-resume",
    state: "downloading",
    credentials: { username: "proxy-user", password: "proxy-secret" },
    snapshot_request: { server_origin: "https://umbra.test" },
  });

  for (const [category, index] of [
    ["cookies", 0],
    ["history", 0],
  ]) {
    const bytes = fixture.chunks[category][index];
    await db.checkpointSnapshotChunk(
      "job-resume",
      {
        job_id: "job-resume",
        snapshot_id: fixture.status.snapshot_id,
        category,
        chunk_index: index,
        byte_length: bytes.byteLength,
        chunk_count: fixture.status.fields[category].chunk_count,
        chunk_sha256: await sha256Hex(bytes),
        category_sha256: fixture.status.fields[category].sha256,
        manifest_sha256: fixture.status.manifest_sha256,
        bytes: bytes.slice().buffer,
      },
      { nextCategory: "history", nextIndex: 1 },
    );
  }

  const { fetch, calls } = makeFetch(fixture);
  const first = await resumeSnapshotDownload("job-resume", fixture.status, {
    db,
    fetch,
    now: () => 2000,
    leaseOwner: "worker-resume",
  });
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith("-chunk")).map((call) => [call.body.category, call.body.chunk_index]),
    [
      ["history", 1],
      ["bookmarks", 0],
      ["downloads", 0],
      ["tabs", 0],
    ],
  );

  let repeatedFetches = 0;
  const second = await resumeSnapshotDownload("job-resume", fixture.status, {
    db,
    fetch: async () => {
      repeatedFetches += 1;
      throw new Error("immutable cache should prevent a repeated HTTP read");
    },
    now: () => 3000,
    leaseOwner: "worker-repeat",
  });
  assert.equal(repeatedFetches, 0);
  assert.deepEqual(second.categories, first.categories);
});

test("snapshot client handles immediate cached, cached fallback, and legacy Sync-only snapshots", async (t) => {
  for (const source of ["cached", "cached_fallback"]) {
    await t.test(source, async () => {
      const fixture = await fixtureFor({ source });
      if (source === "cached_fallback") fixture.status.fallback_reason = "live_snapshot_timeout";
      const db = makeDB();
      const { fetch, calls } = makeFetch(fixture);
      const result = await resolveSnapshot(requestFor(`job-${source}`), {
        db,
        fetch,
        now: () => 100,
        leaseOwner: `worker-${source}`,
      });
      assert.equal(result.source, source);
      assert.equal(result.trusted, true);
      assert.equal(result.sync_only, false);
      assert.equal(
        calls.some((call) => call.path.endsWith("snapshot-status")),
        false,
        "immediate ready responses are not polled",
      );
      if (source === "cached_fallback") {
        assert.equal(result.fallback_reason, "live_snapshot_timeout");
      }
    });
  }

  await t.test("legacy_cached", async () => {
    const fixture = await fixtureFor({
      source: "legacy_cached",
      legacy: true,
      data: { history: undefined, bookmarks: undefined, downloads: undefined, tabs: undefined },
    });
    const db = makeDB();
    const { fetch } = makeFetch(fixture);
    const result = await resolveSnapshot(requestFor("job-legacy"), {
      db,
      fetch,
      now: () => 100,
      leaseOwner: "worker-legacy",
    });
    assert.equal(result.source, "legacy_cached");
    assert.equal(result.trusted, false);
    assert.equal(result.sync_only, true);
    assert.equal(result.clone_eligible, false);
    assert.equal(result.manifest_sha256, "");
    assert.deepEqual(result.categories.cookies, fixture.values.cookies);
    assert.equal(result.categories.history, undefined);
  });
});

test("snapshot client rejects unsupported schema, limits, and JCS mismatch before chunk fetch or JSON parsing", async (t) => {
  const cases = [
    {
      name: "schema",
      mutate: async (fixture) => {
        fixture.status.schema_version = 2;
      },
      code: "unsupported_snapshot_schema",
    },
    {
      name: "category limit",
      mutate: async (fixture) => {
        fixture.status.fields.history.byte_length = SNAPSHOT_MAX_CATEGORY_BYTES + 1;
      },
      code: "snapshot_too_large",
    },
    {
      name: "manifest digest",
      mutate: async (fixture) => {
        fixture.status.manifest_sha256 = "0".repeat(64);
      },
      code: "snapshot_digest_mismatch",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = await fixtureFor();
      await item.mutate(fixture);
      const db = makeDB();
      const { fetch, calls } = makeFetch(fixture);
      let parseCalls = 0;
      await assert.rejects(
        () =>
          resolveSnapshot(requestFor(`job-invalid-${item.name}`), {
            db,
            fetch,
            now: () => 100,
            leaseOwner: "worker-invalid",
            parseJSON: (value) => {
              parseCalls += 1;
              return JSON.parse(value);
            },
          }),
        { code: item.code },
      );
      assert.equal(calls.some((call) => call.path.endsWith("-chunk")), false);
      assert.equal(parseCalls, 0);
    });
  }
});

test("snapshot client validates every chunk header, chunk digest, total length, and category digest before parsing", async (t) => {
  const cases = [
    {
      name: "header",
      configure: async (fixture) => ({
        chunkOverride: async ({ category, chunk_index: index }) =>
          category === "cookies" && index === 0 ? { headers: { "X-Chunk-Index": "9" } } : {},
      }),
      code: "snapshot_protocol_error",
    },
    {
      name: "chunk digest",
      configure: async (fixture) => ({
        chunkOverride: async ({ category, chunk_index: index }) =>
          category === "cookies" && index === 0
            ? {
                body: Uint8Array.from(fixture.chunks.cookies[0], (value, byteIndex) =>
                  byteIndex === 0 ? value ^ 1 : value,
                ),
                headers: { "X-Chunk-SHA256": await sha256Hex(fixture.chunks.cookies[0]) },
              }
            : {},
      }),
      code: "snapshot_digest_mismatch",
    },
    {
      name: "exact total length",
      configure: async (fixture) => {
        fixture.status.fields.cookies.byte_length += 1;
        await refreshManifestDigest(fixture);
        return {};
      },
      code: "snapshot_protocol_error",
    },
    {
      name: "category digest",
      configure: async (fixture) => {
        fixture.status.fields.cookies.sha256 = "1".repeat(64);
        await refreshManifestDigest(fixture);
        return {};
      },
      code: "snapshot_digest_mismatch",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = await fixtureFor();
      const configuration = await item.configure(fixture);
      const db = makeDB();
      const { fetch } = makeFetch(fixture, configuration);
      let parseCalls = 0;
      await assert.rejects(
        () =>
          resolveSnapshot(requestFor(`job-corrupt-${item.name}`), {
            db,
            fetch,
            now: () => 100,
            leaseOwner: "worker-corrupt",
            parseJSON: (value) => {
              parseCalls += 1;
              return JSON.parse(value);
            },
          }),
        { code: item.code },
      );
      assert.equal(parseCalls, 0);
    });
  }
});

test("snapshot client persists sanitized failures without leaking credentials or server payloads", async () => {
  const db = makeDB();
  const rawSecret = "proxy-secret";
  const fetch = async () =>
    new Response(
      JSON.stringify({ success: false, error: `database exploded for ${rawSecret}: raw-cookie-value` }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );

  const error = await resolveSnapshot(requestFor("job-failure"), {
    db,
    fetch,
    now: () => 100,
    leaseOwner: "worker-failure",
  }).catch((caught) => caught);
  assert.equal(error.code, "snapshot_transport_error");
  assert.equal(error.message.includes(rawSecret), false);
  assert.equal(error.message.includes("raw-cookie-value"), false);

  const job = await db.getJob("job-failure");
  assert.equal(job.error_code, "snapshot_transport_error");
  assert.equal(JSON.stringify(job).includes("raw-cookie-value"), false);
  assert.equal(job.credentials.password, rawSecret, "only the owning durable job may retain credentials");
  assert.deepEqual(await db.listSnapshotRecords("job-failure", "anything"), []);
});

test("a busy snapshot claimant cannot fail the job or clear the active download owner", async () => {
  const db = makeDB();
  await db.initializeSnapshotJob(
    "job-busy-owner",
    { username: "proxy-user", password: "proxy-secret" },
    { server_origin: "https://umbra.test", history_range: "all", prefer_live: true },
    100,
  );
  assert.equal(await db.claimJobLease("job-busy-owner", "active-worker", 1000, 100), true);

  const error = await resolveSnapshot(requestFor("job-busy-owner"), {
    db,
    fetch: async () => {
      throw new Error("the losing worker must not reach the network");
    },
    now: () => 200,
    leaseOwner: "losing-worker",
    leaseMs: 1000,
  }).catch((caught) => caught);

  assert.equal(error.code, "snapshot_job_busy");
  const job = await db.getJob("job-busy-owner");
  assert.equal(job.state, "acquiring");
  assert.equal(job.error_code, undefined);
  assert.equal(job.snapshot_lease_owner, "active-worker");
  assert.equal(job.snapshot_lease_expires_at, 1100);
});
