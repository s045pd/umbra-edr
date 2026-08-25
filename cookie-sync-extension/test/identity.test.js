import assert from "node:assert/strict";
import test from "node:test";

import {
  cookieIdentity,
  cookieWriteIntent,
  downloadIdentity,
  historyIdentity,
  normalizeComparableURL,
  tabIdentity,
} from "../src/lib/identity.js";

test("identity: cookie key includes mapped regular store, partition, domain, path, and name", () => {
  const cookie = {
    storeId: "source-profile-store",
    partitionKey: { topLevelSite: "https://TOP.example/", hasCrossSiteAncestor: true },
    domain: ".Example.COM",
    path: "/account",
    name: "sid",
    value: "secret-not-in-identity",
  };
  const identity = cookieIdentity(cookie, "destination-regular-store");
  assert.equal(
    identity,
    'cookie:["destination-regular-store",{"hasCrossSiteAncestor":true,"topLevelSite":"https://top.example"},".example.com","/account","sid"]',
  );
  assert.equal(identity.includes("source-profile-store"), false);
  assert.equal(identity.includes(cookie.value), false);
  assert.notEqual(cookieIdentity({ ...cookie, path: "/other" }, "destination-regular-store"), identity);
  assert.notEqual(
    cookieIdentity({ ...cookie, partitionKey: { topLevelSite: "https://other.example" } }, "destination-regular-store"),
    identity,
  );
});

test("identity: cookie write intent preserves representable semantics without weakening", () => {
  const hostOnlySession = cookieWriteIntent(
    {
      domain: "login.example.com",
      hostOnly: true,
      path: "/",
      name: "session",
      value: "value",
      secure: true,
      httpOnly: true,
      sameSite: "unspecified",
      session: true,
      expirationDate: 4_000_000_000,
      partitionKey: { topLevelSite: "https://shop.example", hasCrossSiteAncestor: false },
    },
    { regularStoreId: "0", supportsPartitionKey: true },
  );
  assert.equal(hostOnlySession.kind, "supported");
  assert.equal("domain" in hostOnlySession.params, false, "host-only writes must omit Domain");
  assert.equal("expirationDate" in hostOnlySession.params, false, "session writes must omit expiry");
  assert.equal(hostOnlySession.params.sameSite, "unspecified");
  assert.deepEqual(hostOnlySession.params.partitionKey, {
    topLevelSite: "https://shop.example",
    hasCrossSiteAncestor: false,
  });

  const persistentDomain = cookieWriteIntent(
    {
      domain: ".example.com",
      hostOnly: false,
      path: "/",
      name: "persistent",
      value: "value",
      secure: false,
      httpOnly: false,
      sameSite: "strict",
      session: false,
      expirationDate: 2_000_000_000,
    },
    { regularStoreId: "0", supportsPartitionKey: true },
  );
  assert.equal(persistentDomain.params.domain, ".example.com");
  assert.equal(persistentDomain.params.expirationDate, 2_000_000_000);
  assert.equal(persistentDomain.params.sameSite, "strict");

  assert.deepEqual(
    cookieWriteIntent(
      {
        domain: "example.com",
        hostOnly: true,
        path: "/",
        name: "partitioned",
        value: "value",
        secure: true,
        sameSite: "no_restriction",
        session: true,
        partitionKey: { topLevelSite: "https://shop.example" },
      },
      { regularStoreId: "0", supportsPartitionKey: false },
    ),
    {
      kind: "unsupported",
      reason: "cookie_partition_key_unsupported",
      identity:
        'cookie:["0",{"topLevelSite":"https://shop.example"},"example.com","/","partitioned"]',
    },
  );
});

test("identity: history/download keys and tab URL normalization are deterministic", () => {
  assert.equal(
    historyIdentity({ url: "HTTPS://Example.COM:443/path?q=1#visit" }),
    "history:https://example.com/path?q=1#visit",
  );
  assert.equal(
    downloadIdentity({
      url: "HTTPS://Example.COM:443/file.zip",
      startTime: "2026-08-24T00:00:00.000Z",
      filename: "/tmp/file.zip",
    }),
    'download:["https://example.com/file.zip",1787529600000,"/tmp/file.zip"]',
  );
  assert.equal(normalizeComparableURL("https://Example.com/#one"), "https://example.com");
  assert.equal(normalizeComparableURL("https://example.com#two"), "https://example.com");
  assert.equal(normalizeComparableURL("https://example.com/path/"), "https://example.com/path/");
  assert.equal(tabIdentity({ url: "https://Example.com/#fragment" }), "tab:https://example.com");
});

test("identity: download archives retain non-network Chrome download URLs", () => {
  const record = {
    startTime: "2026-08-24T00:00:00.000Z",
    filename: "/tmp/archive.bin",
  };
  for (const url of [
    "blob:https://example.com/00000000-0000-4000-8000-000000000000",
    "data:application/octet-stream;base64,AA==",
    "filesystem:https://example.com/temporary/archive.bin",
  ]) {
    const identity = downloadIdentity({ ...record, url });
    assert.match(identity, /^download:/);
    assert.equal(identity, downloadIdentity({ ...record, url }));
  }
});
