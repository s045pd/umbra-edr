const KEY_PATHS = Object.freeze({
  jobs: "job_id",
  backup_chunks: ["backup_id", "category", "chunk_index"],
  backup_manifests: "backup_id",
  history_archives: "archive_id",
  download_archives: "archive_id",
  snapshot_cache: ["job_id", "snapshot_id", "category", "chunk_index"],
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function keyFor(storeName, value, explicitKey) {
  if (explicitKey !== undefined) return explicitKey;
  const keyPath = KEY_PATHS[storeName];
  if (!keyPath) throw new Error(`unknown test store: ${storeName}`);
  return Array.isArray(keyPath) ? keyPath.map((key) => value[key]) : value[keyPath];
}

function serialized(key) {
  return JSON.stringify(key);
}

export class MemoryTransactionDriver {
  constructor(storeNames = Object.keys(KEY_PATHS)) {
    this.stores = new Map(storeNames.map((name) => [name, new Map()]));
    this.failures = [];
  }

  failNextPut(storeName, predicate, error) {
    this.failures.push({ storeName, predicate, error });
  }

  async runTransaction(storeNames, mode, callback) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const working = new Map();
    for (const name of names) {
      const source = this.stores.get(name);
      if (!source) throw new Error(`missing test store: ${name}`);
      working.set(name, new Map(Array.from(source, ([key, value]) => [key, clone(value)])));
    }

    const assertWritable = () => {
      if (mode !== "readwrite") throw new Error("readonly transaction");
    };
    const store = (name) => {
      const target = working.get(name);
      if (!target) throw new Error(`store ${name} is outside transaction`);
      return target;
    };
    const tx = {
      get: async (name, key) => clone(store(name).get(serialized(key))),
      getAll: async (name) => Array.from(store(name).values(), clone),
      put: async (name, value, explicitKey) => {
        assertWritable();
        const key = keyFor(name, value, explicitKey);
        const failureIndex = this.failures.findIndex(
          (failure) => failure.storeName === name && failure.predicate(value, key),
        );
        if (failureIndex >= 0) {
          const [failure] = this.failures.splice(failureIndex, 1);
          throw failure.error;
        }
        store(name).set(serialized(key), clone(value));
        return clone(key);
      },
      delete: async (name, key) => {
        assertWritable();
        store(name).delete(serialized(key));
      },
    };

    const result = await callback(tx);
    if (mode === "readwrite") {
      for (const name of names) this.stores.set(name, working.get(name));
    }
    return result;
  }

  read(storeName, key) {
    return clone(this.stores.get(storeName)?.get(serialized(key)));
  }

  all(storeName) {
    return Array.from(this.stores.get(storeName)?.values() || [], clone);
  }
}

export class SchemaDatabaseFake {
  constructor(existing = []) {
    this.schemas = new Map();
    for (const name of existing) this.schemas.set(name, { name, keyPath: undefined, indexes: [] });
    this.objectStoreNames = {
      contains: (name) => this.schemas.has(name),
      [Symbol.iterator]: () => this.schemas.keys(),
    };
  }

  createObjectStore(name, options = {}) {
    if (this.schemas.has(name)) throw new Error(`duplicate store: ${name}`);
    const schema = { name, keyPath: options.keyPath, indexes: [] };
    this.schemas.set(name, schema);
    return {
      createIndex: (indexName, keyPath, indexOptions = {}) => {
        schema.indexes.push({ name: indexName, keyPath, unique: Boolean(indexOptions.unique) });
      },
    };
  }
}
