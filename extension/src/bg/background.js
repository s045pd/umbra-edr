// Umbra Sensor classic service-worker bootstrap.
importScripts(
  "./snapshot/canonicalize.js",
  "./snapshot/constants.js",
  "./snapshot/history-collector.js",
  "./snapshot/indexeddb-store.js",
  "./snapshot/snapshot-job.js",
  "./snapshot/rpc-response.js",
  "./cookie-collect.js",
  "./page-storage.js",
  "./background-core.js",
);
