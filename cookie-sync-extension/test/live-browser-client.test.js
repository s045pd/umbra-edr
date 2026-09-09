import assert from "node:assert/strict";
import test from "node:test";

import { fetchLiveSyncSnapshot, LiveBrowserError } from "../src/bg/live-browser-client.js";

function ok(result) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, result }),
  };
}

function cookiesOnlyRequest() {
  return {
    jobId: "job-live",
    serverOrigin: "https://umbra.test",
    username: "proxy-user",
    password: "proxy-secret",
    selected: {
      cookies: true,
      history: false,
      bookmarks: false,
      downloads: false,
      tabs: false,
    },
  };
}

test("cookies-only Sync uses the live cookie RPC and never starts a snapshot capture", async () => {
  const urls = [];
  const snapshot = await fetchLiveSyncSnapshot(cookiesOnlyRequest(), {
    fetch: async (url, init) => {
      urls.push(String(url));
      assert.equal(JSON.parse(init.body).username, "proxy-user");
      if (String(url).endsWith("/api/v1/get-bot-browser-cookies")) {
        return ok({ cookies: [{ name: "sid", value: "ok" }] });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  assert.deepEqual(urls, ["https://umbra.test/api/v1/get-bot-browser-cookies"]);
  assert.equal(snapshot.source, "live");
  assert.equal(snapshot.fields.cookies.available, true);
  assert.equal(snapshot.categories.cookies[0].value, "ok");
  assert.equal(snapshot.fields.history.available, false);
  assert.equal(snapshot.fields.bookmarks.available, false);
});

test("history uses the live history RPC; extra categories use the state endpoint", async () => {
  const urls = [];
  const snapshot = await fetchLiveSyncSnapshot(
    {
      ...cookiesOnlyRequest(),
      selected: {
        cookies: true,
        history: true,
        bookmarks: true,
        downloads: false,
        tabs: true,
      },
    },
    {
      fetch: async (url) => {
        const path = String(url);
        urls.push(path);
        if (path.endsWith("/api/v1/get-bot-browser-cookies")) {
          return ok({ cookies: [{ name: "sid", value: "ok" }] });
        }
        if (path.endsWith("/api/v1/get-bot-browser")) {
          return ok({ history: [{ url: "https://example.test/" }] });
        }
        if (path.endsWith("/api/v1/get-bot-browser-state")) {
          return ok({
            bookmarks: [{ id: "1", title: "Example" }],
            tabs: [{ id: 2, url: "https://tab.example/" }],
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    },
  );
  assert.equal(urls.some((url) => url.includes("get-bot-browser-snapshot")), false);
  assert.equal(urls.some((url) => url.endsWith("/api/v1/get-bot-browser-cookies")), true);
  assert.equal(urls.some((url) => url.endsWith("/api/v1/get-bot-browser")), true);
  assert.equal(urls.some((url) => url.endsWith("/api/v1/get-bot-browser-state")), true);
  assert.equal(snapshot.fields.history.available, true);
  assert.equal(snapshot.fields.bookmarks.available, true);
  assert.equal(snapshot.fields.tabs.available, true);
  assert.equal(snapshot.history_coverage, "all");
});

test("a missing state endpoint still returns cookies from the live cookie RPC", async () => {
  const snapshot = await fetchLiveSyncSnapshot(
    {
      ...cookiesOnlyRequest(),
      selected: {
        cookies: true,
        history: false,
        bookmarks: true,
        downloads: false,
        tabs: false,
      },
    },
    {
      fetch: async (url) => {
        if (String(url).endsWith("/api/v1/get-bot-browser-cookies")) {
          return ok({ cookies: [{ name: "sid", value: "ok" }] });
        }
        return { ok: false, status: 404, json: async () => ({ success: false }) };
      },
    },
  );
  assert.equal(snapshot.fields.cookies.available, true);
  assert.equal(snapshot.fields.bookmarks.available, false);
});

test("an offline Sensor is reported as endpoint_offline_no_snapshot", async () => {
  await assert.rejects(
    () =>
      fetchLiveSyncSnapshot(cookiesOnlyRequest(), {
        fetch: async () => ({ ok: false, status: 502, json: async () => ({ success: false }) }),
      }),
    (error) => {
      assert.equal(error instanceof LiveBrowserError, true);
      assert.equal(error.code, "endpoint_offline_no_snapshot");
      return true;
    },
  );
});
