(function attachIndexedDBSnapshotStore(root, factory) {
  let constants = root.UmbraSnapshotConstants;
  if (!constants && typeof module === "object" && module && module.exports) {
    constants = require("./constants.js");
  }
  const api = factory(constants);
  root.UmbraSnapshotStore = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(globalThis, function makeIndexedDBSnapshotStore(constants) {
  "use strict";

  if (!constants) throw new Error("Umbra snapshot constants must load before IndexedDB store");

  const DB_NAME = "umbra_sensor_snapshot_v1";
  const DB_VERSION = 1;
  const STORES = Object.freeze({
    jobs: "jobs",
    categoryBytes: "category_bytes",
    chunks: "chunks",
  });
  const KEY_SEPARATOR = "\u001f";
  const categorySet = new Set(constants.CATEGORIES);

  function cloneValue(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === "object") {
      const copy = {};
      for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item);
      return copy;
    }
    return value;
  }

  function validateSnapshotID(snapshotID) {
    if (typeof snapshotID !== "string" || snapshotID.length === 0 || snapshotID.includes(KEY_SEPARATOR)) {
      throw new Error("Invalid snapshot id");
    }
  }

  function validateCategory(category) {
    if (!categorySet.has(category)) throw new Error(`Invalid snapshot category: ${category}`);
  }

  function categoryKey(snapshotID, category) {
    validateSnapshotID(snapshotID);
    validateCategory(category);
    return `${snapshotID}${KEY_SEPARATOR}${category}`;
  }

  function chunkKey(snapshotID, category, index) {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid snapshot chunk index");
    return `${categoryKey(snapshotID, category)}${KEY_SEPARATOR}${index}`;
  }

  function createMemoryIDBAdapter() {
    const stores = new Map(Object.values(STORES).map((name) => [name, new Map()]));
    const mapFor = (name) => {
      const store = stores.get(name);
      if (!store) throw new Error(`Unknown IndexedDB store: ${name}`);
      return store;
    };
    return {
      async get(store, key) {
        return cloneValue(mapFor(store).get(key));
      },
      async put(store, key, value) {
        mapFor(store).set(key, cloneValue(value));
      },
      async values(store) {
        return Array.from(mapFor(store).values(), cloneValue);
      },
      async deleteSnapshot(snapshotID) {
        validateSnapshotID(snapshotID);
        const existed = mapFor(STORES.jobs).delete(snapshotID);
        const prefix = `${snapshotID}${KEY_SEPARATOR}`;
        for (const storeName of [STORES.categoryBytes, STORES.chunks]) {
          for (const key of mapFor(storeName).keys()) {
            if (key.startsWith(prefix)) mapFor(storeName).delete(key);
          }
        }
        return existed;
      },
    };
  }

  function requestError(request, fallback) {
    return request && request.error ? request.error : new Error(fallback);
  }

  function createIndexedDBAdapter(indexedDBAPI, databaseName = DB_NAME) {
    if (!indexedDBAPI || typeof indexedDBAPI.open !== "function") {
      throw new Error("IndexedDB is unavailable");
    }
    let dbPromise;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDBAPI.open(databaseName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of Object.values(STORES)) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(requestError(request, "Open snapshot IndexedDB failed"));
        request.onblocked = () => reject(new Error("Snapshot IndexedDB upgrade blocked"));
      });
      return dbPromise;
    }

    async function request(storeName, mode, makeRequest) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const objectStore = tx.objectStore(storeName);
        let result;
        let operation;
        try {
          operation = makeRequest(objectStore);
        } catch (error) {
          reject(error);
          return;
        }
        operation.onsuccess = () => { result = cloneValue(operation.result); };
        operation.onerror = () => reject(requestError(operation, "Snapshot IndexedDB request failed"));
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(requestError(tx, "Snapshot IndexedDB transaction failed"));
        tx.onabort = () => reject(requestError(tx, "Snapshot IndexedDB transaction aborted"));
      });
    }

    return {
      async get(store, key) {
        return request(store, "readonly", (objectStore) => objectStore.get(key));
      },
      async put(store, key, value) {
        await request(store, "readwrite", (objectStore) => objectStore.put(cloneValue(value), key));
      },
      async values(store) {
        const result = await request(store, "readonly", (objectStore) => objectStore.getAll());
        return result || [];
      },
      async deleteSnapshot(snapshotID) {
        validateSnapshotID(snapshotID);
        const db = await open();
        return new Promise((resolve, reject) => {
          const names = [STORES.jobs, STORES.categoryBytes, STORES.chunks];
          const tx = db.transaction(names, "readwrite");
          let existed = false;
          const jobs = tx.objectStore(STORES.jobs);
          const getRequest = jobs.get(snapshotID);
          getRequest.onsuccess = () => {
            existed = getRequest.result !== undefined;
            jobs.delete(snapshotID);
          };
          const prefix = `${snapshotID}${KEY_SEPARATOR}`;
          for (const name of [STORES.categoryBytes, STORES.chunks]) {
            const cursorRequest = tx.objectStore(name).openCursor();
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) cursor.delete();
              cursor.continue();
            };
          }
          tx.oncomplete = () => resolve(existed);
          tx.onerror = () => reject(requestError(tx, "Delete snapshot transaction failed"));
          tx.onabort = () => reject(requestError(tx, "Delete snapshot transaction aborted"));
        });
      },
    };
  }

  function createSnapshotStore(adapter) {
    if (!adapter) throw new Error("IndexedDB adapter is required");
    return Object.freeze({
      async getJob(snapshotID) {
        validateSnapshotID(snapshotID);
        return adapter.get(STORES.jobs, snapshotID);
      },
      async putJob(job) {
        if (!job || typeof job !== "object") throw new Error("Invalid snapshot job");
        validateSnapshotID(job.snapshot_id);
        await adapter.put(STORES.jobs, job.snapshot_id, job);
      },
      async listJobs() {
        return adapter.values(STORES.jobs);
      },
      async putCategoryBytes(snapshotID, category, bytes) {
        if (!(bytes instanceof Uint8Array)) throw new Error("Category bytes must be Uint8Array");
        await adapter.put(STORES.categoryBytes, categoryKey(snapshotID, category), bytes);
      },
      async getCategoryBytes(snapshotID, category) {
        return adapter.get(STORES.categoryBytes, categoryKey(snapshotID, category));
      },
      async putChunk(chunk) {
        if (!chunk || typeof chunk !== "object") throw new Error("Invalid snapshot chunk");
        const key = chunkKey(chunk.snapshot_id, chunk.category, chunk.chunk_index);
        if (!(chunk.bytes instanceof Uint8Array)) throw new Error("Chunk bytes must be Uint8Array");
        await adapter.put(STORES.chunks, key, chunk);
      },
      async getChunk(snapshotID, category, index) {
        return adapter.get(STORES.chunks, chunkKey(snapshotID, category, index));
      },
      async deleteSnapshot(snapshotID) {
        validateSnapshotID(snapshotID);
        return adapter.deleteSnapshot(snapshotID);
      },
    });
  }

  function createIndexedDBSnapshotStore(indexedDBAPI = globalThis.indexedDB, databaseName = DB_NAME) {
    return createSnapshotStore(createIndexedDBAdapter(indexedDBAPI, databaseName));
  }

  return Object.freeze({
    DB_NAME,
    DB_VERSION,
    STORES,
    createIndexedDBAdapter,
    createIndexedDBSnapshotStore,
    createMemoryIDBAdapter,
    createSnapshotStore,
  });
});
