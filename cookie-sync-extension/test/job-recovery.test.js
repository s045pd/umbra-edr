import assert from "node:assert/strict";
import test from "node:test";

import { prepareCloneJob } from "../src/bg/clone-job.js";
import { ShadowLinkDB } from "../src/bg/idb.js";
import { JobRunner, WorkerTerminatedError } from "../src/bg/job-runner.js";
import { SHADOWLINK_STORE_NAMES, SNAPSHOT_CATEGORIES } from "../src/lib/constants.js";
import { FakeBrowser } from "./helpers/fake-browser.js";
import { MemoryTransactionDriver } from "./helpers/memory-driver.js";

function recoverySnapshot() {
  const categories = {
    cookies: [
      {
        storeId: "source",
        domain: "source.example",
        hostOnly: true,
        path: "/",
        name: "sid",
        value: "source",
        secure: true,
        httpOnly: true,
        sameSite: "unspecified",
        session: true,
      },
    ],
    history: [{ url: "https://history.example/", title: "H", lastVisitTime: 10, typedCount: 0, visitCount: 1 }],
    bookmarks: [
      {
        root: "bookmark_bar",
        id: "source-root",
        children: [{ id: "source-b", title: "B", url: "https://bookmark.example/" }],
      },
      { root: "other", id: "source-other", children: [] },
    ],
    downloads: [{ url: "https://download.example/f", startTime: "2026-08-24T00:00:00Z", filename: "/tmp/f" }],
    tabs: [
      { url: "https://one.example/", pinned: true, active: false },
      { url: "https://two.example/", pinned: false, active: true },
    ],
  };
  const fields = Object.fromEntries(
    SNAPSHOT_CATEGORIES.map((category) => [
      category,
      {
        available: true,
        legacy: false,
        count: categories[category].length,
        byte_length: JSON.stringify(categories[category]).length,
        sha256: "a".repeat(64),
        chunk_count: 1,
      },
    ]),
  );
  return {
    snapshot_id: "snapshot-recovery",
    source: "live",
    trusted: true,
    sync_only: false,
    schema_version: 1,
    manifest_sha256: "b".repeat(64),
    history_coverage: "all",
    history_truncated: false,
    integrity_valid: true,
    fields,
    categories,
  };
}

async function recoveryEnvironment(target) {
  const db = new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
  const browser = new FakeBrowser();
  let clock = 100;
  let sequence = 0;
  let fired = false;
  const deps = {
    db,
    adapters: browser.adapters(),
    resolveSnapshot: async () => structuredClone(recoverySnapshot()),
    now: () => clock,
    randomUUID: () => `recovery-${++sequence}`,
    writableRoots: { bookmark_bar: "1", other: "2" },
    currentWindowId: 44,
    cookieEnumerationComplete: true,
    supportsPartitionKey: true,
    faultInjector: async (point, event) => {
      if (!fired && point === target.point && event.phase === target.phase) {
        fired = true;
        throw new WorkerTerminatedError();
      }
    },
  };
  const prepared = await prepareCloneJob(
    {
      jobId: target.jobId,
      serverOrigin: "https://umbra.test",
      username: "proxy-user",
      password: "proxy-secret",
    },
    deps,
  );
  return {
    db,
    browser,
    deps,
    prepared,
    now: () => clock,
    advance: (milliseconds) => (clock += milliseconds),
  };
}

test("lease/recovery takes only expired Clone leases and rechecks or deterministically restarts uncertain phases", async (t) => {
  const cases = [
    { name: "cookie intent before effect", point: "after_intent", phase: "APPLYING_COOKIES" },
    { name: "cookie effect before result", point: "after_effect", phase: "APPLYING_COOKIES" },
    { name: "history replacement", point: "after_effect", phase: "APPLYING_HISTORY" },
    { name: "bookmark replacement", point: "after_effect", phase: "APPLYING_BOOKMARKS" },
    { name: "tab reconciliation", point: "after_effect", phase: "APPLYING_TABS" },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const target = { ...item, jobId: `recover-${item.name.replaceAll(" ", "-")}` };
      const env = await recoveryEnvironment(target);
      const runnerOne = new JobRunner({
        db: env.db,
        workerId: "worker-one",
        leaseMs: 50,
        now: env.now,
        cloneDependencies: env.deps,
      });
      const termination = await runnerOne
        .confirmClone(target.jobId, {
          backupId: env.prepared.backup_id,
          manifestSHA256: env.prepared.backup_manifest_sha256,
        })
        .catch((error) => error);
      assert.equal(termination.code, "worker_terminated");
      const interrupted = await env.db.getJob(target.jobId);
      assert.equal(interrupted.current_intent.status, "started");
      const interruptedState = interrupted.state;

      const runnerTwo = new JobRunner({
        db: env.db,
        workerId: "worker-two",
        leaseMs: 50,
        now: env.now,
        cloneDependencies: { ...env.deps, faultInjector: undefined },
      });
      assert.deepEqual(await runnerTwo.recoverJobs(), [], "an unexpired owner cannot be stolen");
      assert.equal((await env.db.getJob(target.jobId)).state, interruptedState, "stale work is not merely unlocked");

      env.advance(51);
      assert.deepEqual(await runnerTwo.recoverJobs(), [target.jobId]);
      const completed = await env.db.getJob(target.jobId);
      assert.equal(completed.state, "COMPLETE");
      assert.equal(completed.current_intent, undefined);
      assert.equal(completed.credentials, undefined);
      if (item.phase === "APPLYING_HISTORY") {
        assert.equal(
          env.browser.operations.filter((operation) => operation.method === "history.deleteAll").length >= 2,
          true,
          "history recovery restarts deleteAll deterministically",
        );
      }
      if (item.phase === "APPLYING_BOOKMARKS") {
        assert.equal(
          env.browser.operations.filter((operation) => operation.method === "bookmarks.removeTree").length >= 2,
          true,
          "bookmark recovery re-clears writable roots",
        );
      }
      if (item.phase === "APPLYING_TABS") {
        assert.deepEqual(env.browser.tabs.map((tab) => tab.url), ["https://one.example/", "https://two.example/"]);
      }
      const popup = await runnerTwo.handleMessage({ type: "GET_JOB_STATUS", jobId: target.jobId });
      assert.equal(popup.state, "COMPLETE", "popup reads durable state after recovery");
    });
  }
});

test("recovery resumes ROLLING_BACK rather than clearing a stale RUNNING record", async () => {
  const env = await recoveryEnvironment({
    name: "rollback",
    jobId: "recover-rollback",
    point: "after_effect",
    phase: "APPLYING_COOKIES",
  });
  env.browser.failNext("cookies.set");
  env.deps.faultInjector = undefined;
  env.deps.onRollbackStart = async () => {
    throw new WorkerTerminatedError();
  };
  const runnerOne = new JobRunner({
    db: env.db,
    workerId: "worker-one",
    leaseMs: 10,
    now: env.now,
    cloneDependencies: env.deps,
  });
  const error = await runnerOne
    .confirmClone("recover-rollback", {
      backupId: env.prepared.backup_id,
      manifestSHA256: env.prepared.backup_manifest_sha256,
    })
    .catch((caught) => caught);
  assert.equal(error.code, "worker_terminated");
  assert.equal((await env.db.getJob("recover-rollback")).state, "ROLLING_BACK");
  env.advance(11);
  const runnerTwo = new JobRunner({
    db: env.db,
    workerId: "worker-two",
    leaseMs: 10,
    now: env.now,
    cloneDependencies: { ...env.deps, onRollbackStart: undefined },
  });
  await runnerTwo.recoverJobs();
  assert.equal((await env.db.getJob("recover-rollback")).state, "ROLLED_BACK");
});

test("service-worker regression registers proxy listeners once and adds runner wake paths without replacing them", async () => {
  const listeners = {
    storage: [],
    auth: [],
    installed: [],
    startup: [],
    message: [],
    alarm: [],
  };
  const listener = (bucket) => ({ addListener: (callback) => listeners[bucket].push(callback) });
  globalThis.chrome = {
    storage: {
      local: {
        get: (_keys, callback) => callback({}),
      },
      onChanged: listener("storage"),
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {},
      setTitle() {},
    },
    runtime: {
      lastError: null,
      onInstalled: listener("installed"),
      onStartup: listener("startup"),
      onMessage: listener("message"),
    },
    webRequest: { onAuthRequired: listener("auth") },
    alarms: {
      create() {},
      onAlarm: listener("alarm"),
    },
  };
  try {
    await import(`../src/bg/sw.js?regression=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(listeners.storage.length, 1);
    assert.equal(listeners.auth.length, 1);
    assert.equal(listeners.message.length, 1);
    assert.equal(listeners.alarm.length, 1);
    assert.equal(listeners.startup.length, 2, "badge and recovery each keep one startup listener");
    assert.equal(listeners.installed.length, 2, "badge and recovery each keep one install listener");
  } finally {
    delete globalThis.chrome;
  }
});

function syncRunnerSnapshot() {
  const categories = {
    cookies: [
      {
        storeId: "source",
        domain: "example.com",
        hostOnly: true,
        path: "/",
        name: "sid",
        value: "source",
        secure: true,
        httpOnly: true,
        sameSite: "unspecified",
        session: true,
      },
    ],
    history: [],
    bookmarks: [],
    downloads: [],
    tabs: [],
  };
  return {
    snapshot_id: "snapshot-cookie-only",
    source: "live",
    trusted: true,
    sync_only: false,
    history_coverage: "all",
    history_truncated: false,
    fields: Object.fromEntries(
      SNAPSHOT_CATEGORIES.map((category) => [
        category,
        {
          available: true,
          legacy: false,
          count: categories[category].length,
          byte_length: JSON.stringify(categories[category]).length,
          sha256: "a".repeat(64),
          chunk_count: 1,
        },
      ]),
    ),
    categories,
  };
}

test("cookies-only START_SYNC never requires tabs or bookmark roots", async () => {
  const db = new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
  const calls = [];
  const destinationCookies = [];
  const adapters = {
    async enumerateTabs() {
      calls.push("tabs");
      throw Object.assign(new Error("tabs must not be read"), { code: "unexpected_tabs_dependency" });
    },
    async enumerateBookmarks() {
      calls.push("bookmarks");
      throw Object.assign(new Error("bookmarks must not be read"), { code: "unexpected_bookmark_dependency" });
    },
    async getCurrentRegularCookieStore() {
      calls.push("cookie-store");
      return { id: "0", incognito: false };
    },
    async enumerateCookies() {
      calls.push("cookies");
      return destinationCookies;
    },
    async setCookie(params) {
      calls.push("cookie-set");
      const stored = {
        ...params,
        domain: params.domain || new URL(params.url).hostname,
        hostOnly: !("domain" in params),
        session: !("expirationDate" in params),
        storeId: "0",
      };
      destinationCookies.push(stored);
      return stored;
    },
  };
  const runner = new JobRunner({
    db,
    workerId: "sync-cookie-only",
    now: () => 1_000,
    syncDependencies: {
      adapters,
      resolveSnapshot: async () => syncRunnerSnapshot(),
      randomUUID: () => "sync-archive",
    },
  });

  const result = await runner.handleMessage({
    type: "START_SYNC",
    jobId: "sync-cookie-only-job",
    serverOrigin: "https://umbra.test",
    username: "proxy-user",
    password: "proxy-secret",
    options: { cookies: true },
  });

  assert.equal(result.state, "sync_complete");
  assert.equal(result.categories.cookies.status, "success");
  assert.equal(calls.includes("tabs"), false);
  assert.equal(calls.includes("bookmarks"), false);
  assert.equal(calls.includes("cookie-set"), true);
});

test("bookmark roots use folderType with arbitrary IDs and preserve local/account roots", async () => {
  const db = new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
  const runner = new JobRunner({ db, workerId: "bookmark-roots" });
  const dependencies = await runner.operationDependencies({
    adapters: {
      async enumerateTabs() {
        return [{ id: 1, windowId: 44 }];
      },
      async enumerateBookmarks() {
        return [
          {
            id: "0",
            children: [
              { id: "account-bar-x7", folderType: "bookmarks-bar", syncing: true, children: [] },
              { id: "local-bar-y2", folderType: "bookmarks-bar", syncing: false, children: [] },
              { id: "other-z9", folderType: "other", syncing: true, children: [] },
              { id: "mobile-k4", folderType: "mobile", syncing: true, children: [] },
              { id: "managed-m1", folderType: "managed", children: [] },
            ],
          },
        ];
      },
    },
  });

  assert.equal(dependencies.currentWindowId, 44);
  assert.deepEqual(dependencies.writableRoots, {
    "bookmark_bar:syncing": "account-bar-x7",
    "bookmark_bar:local": "local-bar-y2",
    other: "other-z9",
    mobile: "mobile-k4",
  });
  assert.equal(Object.values(dependencies.writableRoots).includes("managed-m1"), false);
});

test("ambiguous duplicate bookmark roots fail closed instead of silently overwriting a root", async () => {
  const db = new ShadowLinkDB(new MemoryTransactionDriver(SHADOWLINK_STORE_NAMES));
  const runner = new JobRunner({ db, workerId: "ambiguous-bookmark-roots" });
  await assert.rejects(
    () =>
      runner.operationDependencies({
        adapters: {
          async enumerateTabs() {
            return [{ id: 1, windowId: 44 }];
          },
          async enumerateBookmarks() {
            return [
              {
                id: "0",
                children: [
                  { id: "bar-a", folderType: "bookmarks-bar", children: [] },
                  { id: "bar-b", folderType: "bookmarks-bar", children: [] },
                ],
              },
            ];
          },
        },
      }),
    { code: "bookmark_roots_ambiguous" },
  );
});
