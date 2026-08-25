import {
  ACTIVE_SNAPSHOT_JOB_STATES,
  ARCHIVE_POINTER_RECORD_ID,
  BACKUP_POINTER_RECORD_ID,
  MUTATION_LOCK_JOB_ID,
  SHADOWLINK_DB_NAME,
  SHADOWLINK_DB_VERSION,
  SNAPSHOT_MANIFEST_CATEGORY,
  SNAPSHOT_MANIFEST_CHUNK_INDEX,
} from "../lib/constants.js";

const STORE_SCHEMAS = Object.freeze({
  jobs: {
    keyPath: "job_id",
    indexes: [
      ["state", "state"],
      ["lease_expires_at", "lease_expires_at"],
    ],
  },
  backup_chunks: {
    keyPath: ["backup_id", "category", "chunk_index"],
    indexes: [["backup_id", "backup_id"]],
  },
  backup_manifests: {
    keyPath: "backup_id",
    indexes: [["state", "state"]],
  },
  history_archives: {
    keyPath: "archive_id",
    indexes: [["state", "state"]],
  },
  download_archives: {
    keyPath: "archive_id",
    indexes: [["state", "state"]],
  },
  snapshot_cache: {
    keyPath: ["job_id", "snapshot_id", "category", "chunk_index"],
    indexes: [
      ["job_id", "job_id"],
      ["snapshot_id", "snapshot_id"],
    ],
  },
});

const activeJobStates = new Set(ACTIVE_SNAPSHOT_JOB_STATES);
const terminalMutationStates = new Set([
  "COMPLETE",
  "COMPLETE_WITH_ACCEPTED_OMISSIONS",
  "ROLLED_BACK",
  "FAILED_BEFORE_MUTATION",
  "sync_complete",
  "sync_complete_with_errors",
  "sync_failed_before_apply",
]);

export class SnapshotStorageError extends Error {
  constructor(code, message = "Snapshot storage operation failed") {
    super(message);
    this.name = "SnapshotStorageError";
    this.code = code;
  }
}

export function upgradeShadowLinkDatabase(database) {
  for (const [name, schema] of Object.entries(STORE_SCHEMAS)) {
    if (database.objectStoreNames.contains(name)) continue;
    const store = database.createObjectStore(name, { keyPath: schema.keyPath });
    for (const [indexName, keyPath] of schema.indexes) {
      store.createIndex(indexName, keyPath, { unique: false });
    }
  }
}

export function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

export function transactionAsPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new DOMException("Transaction aborted", "AbortError"));
  });
}

class NativeTransactionDriver {
  constructor(database) {
    this.database = database;
  }

  async runTransaction(storeNames, mode, callback) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const transaction = this.database.transaction(names, mode);
    const completion = transactionAsPromise(transaction);
    const stores = new Map(names.map((name) => [name, transaction.objectStore(name)]));
    const store = (name) => {
      const value = stores.get(name);
      if (!value) throw new Error(`IndexedDB store ${name} is outside the transaction`);
      return value;
    };
    const tx = {
      get: (name, key) => requestAsPromise(store(name).get(key)),
      getAll: (name) => requestAsPromise(store(name).getAll()),
      put: (name, value, key) =>
        requestAsPromise(key === undefined ? store(name).put(value) : store(name).put(value, key)),
      delete: (name, key) => requestAsPromise(store(name).delete(key)),
    };

    try {
      const result = await callback(tx);
      await completion;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A request failure may already have aborted/completed the transaction.
      }
      try {
        await completion;
      } catch {
        // Preserve the original request/callback error (including quota errors).
      }
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

export async function openShadowLinkDB({
  indexedDB = globalThis.indexedDB,
  name = SHADOWLINK_DB_NAME,
  version = SHADOWLINK_DB_VERSION,
} = {}) {
  if (!indexedDB || typeof indexedDB.open !== "function") {
    throw new SnapshotStorageError("indexeddb_unavailable", "IndexedDB is unavailable");
  }

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      try {
        upgradeShadowLinkDatabase(request.result);
      } catch (error) {
        try {
          request.transaction?.abort();
        } catch {
          // The upgrade error below remains the useful failure.
        }
        reject(error);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () =>
      reject(new SnapshotStorageError("indexeddb_upgrade_blocked", "IndexedDB upgrade is blocked"));
  });
  return new ShadowLinkDB(new NativeTransactionDriver(database));
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

export class ShadowLinkDB {
  constructor(driver) {
    if (!driver || typeof driver.runTransaction !== "function") {
      throw new TypeError("ShadowLinkDB requires a transaction driver");
    }
    this.driver = driver;
  }

  runTransaction(storeNames, mode, callback) {
    return this.driver.runTransaction(storeNames, mode, callback);
  }

  close() {
    this.driver.close?.();
  }

  async getJob(jobId) {
    requireIdentifier(jobId, "jobId");
    return this.runTransaction("jobs", "readonly", (tx) => tx.get("jobs", jobId));
  }

  async putJob(job) {
    requireIdentifier(job?.job_id, "job.job_id");
    await this.runTransaction("jobs", "readwrite", (tx) => tx.put("jobs", job));
    return job;
  }

  async initializeSyncJob(jobId, credentials, options, requestedAt, requestMetadata = {}) {
    requireIdentifier(jobId, "jobId");
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const existing = await tx.get("jobs", jobId);
      if (existing) {
        if (
          existing.credentials?.username !== credentials.username ||
          existing.credentials?.password !== credentials.password
        ) {
          throw new SnapshotStorageError("snapshot_job_conflict", "Sync job identity conflict");
        }
        if (!Number.isFinite(existing.requested_at)) existing.requested_at = requestedAt;
        existing.kind = "sync";
        existing.sync_options = existing.sync_options || { ...options };
        existing.snapshot_request = existing.snapshot_request || { ...requestMetadata };
        existing.updated_at = requestedAt;
        await tx.put("jobs", existing);
        return existing;
      }
      const job = {
        job_id: jobId,
        kind: "sync",
        state: "fetching",
        created_at: requestedAt,
        updated_at: requestedAt,
        requested_at: requestedAt,
        credentials: { username: credentials.username, password: credentials.password },
        sync_options: { ...options },
        snapshot_request: { ...requestMetadata },
        progress: { phase: "fetching", completed: 0, total: 0 },
      };
      await tx.put("jobs", job);
      return job;
    });
  }

  async initializeCloneJob(jobId, credentials, requestMetadata, now) {
    requireIdentifier(jobId, "jobId");
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const existing = await tx.get("jobs", jobId);
      if (existing) {
        if (
          existing.kind !== "clone" ||
          existing.credentials?.username !== credentials.username ||
          existing.credentials?.password !== credentials.password
        ) {
          throw new SnapshotStorageError("snapshot_job_conflict", "Clone job identity conflict");
        }
        return existing;
      }
      const job = {
        job_id: jobId,
        kind: "clone",
        state: "FETCHING",
        state_history: ["FETCHING"],
        created_at: now,
        updated_at: now,
        credentials: { username: credentials.username, password: credentials.password },
        clone_request: { ...requestMetadata },
        snapshot_request: {
          server_origin: requestMetadata.server_origin,
          history_range: "all",
          prefer_live: true,
        },
        mutation_started: false,
        rollback_required: false,
      };
      await tx.put("jobs", job);
      return job;
    });
  }

  async initializeRestoreJob(jobId, sourceBackupId, acceptedOmissions, now) {
    requireIdentifier(jobId, "jobId");
    requireIdentifier(sourceBackupId, "sourceBackupId");
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const existing = await tx.get("jobs", jobId);
      if (existing) {
        if (
          existing.kind !== "restore" ||
          existing.restore_source_backup_id !== sourceBackupId ||
          existing.accepted_omissions !== acceptedOmissions
        ) {
          throw new SnapshotStorageError("snapshot_job_conflict", "Restore job identity conflict");
        }
        return existing;
      }
      const job = {
        job_id: jobId,
        kind: "restore",
        state: "VALIDATING_RESTORE_SOURCE",
        state_history: ["VALIDATING_RESTORE_SOURCE"],
        created_at: now,
        updated_at: now,
        restore_source_backup_id: sourceBackupId,
        accepted_omissions: acceptedOmissions,
        mutation_started: false,
        rollback_required: false,
      };
      await tx.put("jobs", job);
      return job;
    });
  }

  async updateJob(jobId, updater) {
    requireIdentifier(jobId, "jobId");
    if (typeof updater !== "function") throw new TypeError("job updater must be a function");
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job) throw new SnapshotStorageError("snapshot_job_not_found", "Snapshot job not found");
      const updated = updater(job) || job;
      if (updated && typeof updated.then === "function") {
        throw new TypeError("job updater must be synchronous");
      }
      await tx.put("jobs", updated);
      return updated;
    });
  }

  async listJobs() {
    const jobs = await this.runTransaction("jobs", "readonly", (tx) => tx.getAll("jobs"));
    return jobs.filter((job) => job.job_id !== MUTATION_LOCK_JOB_ID);
  }

  async claimMutationLease(jobId, owner, ttlMs, now) {
    requireIdentifier(jobId, "jobId");
    requireIdentifier(owner, "owner");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now)) {
      throw new TypeError("invalid mutation lease timing");
    }
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job) throw new SnapshotStorageError("snapshot_job_not_found", "Mutation job not found");
      const lock = await tx.get("jobs", MUTATION_LOCK_JOB_ID);
      if (
        lock &&
        Number.isFinite(lock.lease_expires_at) &&
        lock.lease_expires_at > now &&
        (lock.owner !== owner || lock.target_job_id !== jobId)
      ) {
        return false;
      }
      if (
        job.lease_owner &&
        job.lease_owner !== owner &&
        Number.isFinite(job.lease_expires_at) &&
        job.lease_expires_at > now
      ) {
        return false;
      }
      const expiresAt = now + ttlMs;
      await tx.put("jobs", {
        job_id: MUTATION_LOCK_JOB_ID,
        kind: "mutation_lock",
        state: "locked",
        target_job_id: jobId,
        owner,
        lease_expires_at: expiresAt,
        updated_at: now,
      });
      job.lease_owner = owner;
      job.lease_expires_at = expiresAt;
      job.last_heartbeat_at = now;
      job.updated_at = now;
      await tx.put("jobs", job);
      return true;
    });
  }

  async renewMutationLease(jobId, owner, ttlMs, now) {
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const [job, lock] = await Promise.all([
        tx.get("jobs", jobId),
        tx.get("jobs", MUTATION_LOCK_JOB_ID),
      ]);
      if (!job || !lock || job.lease_owner !== owner || lock.owner !== owner || lock.target_job_id !== jobId) {
        return false;
      }
      const expiresAt = now + ttlMs;
      job.lease_expires_at = expiresAt;
      job.last_heartbeat_at = now;
      lock.lease_expires_at = expiresAt;
      lock.updated_at = now;
      await tx.put("jobs", job);
      await tx.put("jobs", lock);
      return true;
    });
  }

  async releaseMutationLease(jobId, owner, now) {
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const [job, lock] = await Promise.all([
        tx.get("jobs", jobId),
        tx.get("jobs", MUTATION_LOCK_JOB_ID),
      ]);
      if (job?.lease_owner === owner) {
        job.lease_owner = null;
        job.lease_expires_at = null;
        job.updated_at = now;
        await tx.put("jobs", job);
      }
      if (lock?.owner === owner && lock.target_job_id === jobId) {
        await tx.delete("jobs", MUTATION_LOCK_JOB_ID);
      }
      return true;
    });
  }

  async initializeSnapshotJob(jobId, credentials, metadata, now) {
    requireIdentifier(jobId, "jobId");
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const existing = await tx.get("jobs", jobId);
      if (existing) {
        const sameCredentials =
          existing.credentials?.username === credentials.username &&
          existing.credentials?.password === credentials.password;
        if (!sameCredentials) {
          throw new SnapshotStorageError("snapshot_job_conflict", "Snapshot job identity conflict");
        }
        return existing;
      }
      const job = {
        job_id: jobId,
        kind: "snapshot_download",
        state: "acquiring",
        created_at: now,
        updated_at: now,
        credentials: { username: credentials.username, password: credentials.password },
        snapshot_request: { ...metadata },
      };
      await tx.put("jobs", job);
      return job;
    });
  }

  async claimJobLease(jobId, owner, ttlMs, now) {
    requireIdentifier(jobId, "jobId");
    requireIdentifier(owner, "owner");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(now)) {
      throw new TypeError("invalid lease timing");
    }
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job) throw new SnapshotStorageError("snapshot_job_not_found", "Snapshot job not found");
      if (
        job.snapshot_lease_owner &&
        job.snapshot_lease_owner !== owner &&
        Number.isFinite(job.snapshot_lease_expires_at) &&
        job.snapshot_lease_expires_at > now
      ) {
        return false;
      }
      job.snapshot_lease_owner = owner;
      job.snapshot_lease_expires_at = now + ttlMs;
      job.snapshot_last_heartbeat_at = now;
      job.updated_at = now;
      await tx.put("jobs", job);
      return true;
    });
  }

  async renewJobLease(jobId, owner, ttlMs, now) {
    requireIdentifier(jobId, "jobId");
    requireIdentifier(owner, "owner");
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job || job.snapshot_lease_owner !== owner) return false;
      job.snapshot_lease_expires_at = now + ttlMs;
      job.snapshot_last_heartbeat_at = now;
      job.updated_at = now;
      await tx.put("jobs", job);
      return true;
    });
  }

  async failJob(jobId, errorCode, now, owner) {
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job) return false;
      if (
        typeof owner === "string" &&
        job.snapshot_lease_owner &&
        job.snapshot_lease_owner !== owner &&
        Number.isFinite(job.snapshot_lease_expires_at) &&
        job.snapshot_lease_expires_at > now
      ) {
        return false;
      }
      job.state = "failed";
      job.error_code = errorCode;
      job.snapshot_lease_owner = null;
      job.snapshot_lease_expires_at = null;
      job.updated_at = now;
      await tx.put("jobs", job);
      return true;
    });
  }

  async setSnapshotReadyStatus(jobId, readyStatus, now) {
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job) throw new SnapshotStorageError("snapshot_job_not_found", "Snapshot job not found");
      if (
        job.snapshot_ready_status &&
        (job.snapshot_ready_status.snapshot_id !== readyStatus.snapshot_id ||
          job.snapshot_ready_status.descriptor_fingerprint !== readyStatus.descriptor_fingerprint)
      ) {
        throw new SnapshotStorageError("snapshot_manifest_mismatch", "Immutable snapshot metadata changed");
      }
      job.snapshot_ready_status = { ...readyStatus };
      job.snapshot_id = readyStatus.snapshot_id;
      job.state = "downloading";
      job.updated_at = now;
      await tx.put("jobs", job);
      return job;
    });
  }

  async completeSnapshotJob(jobId, snapshotMetadata, now) {
    return this.runTransaction("jobs", "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job) throw new SnapshotStorageError("snapshot_job_not_found", "Snapshot job not found");
      job.state = "snapshot_ready";
      job.snapshot_id = snapshotMetadata.snapshot_id;
      job.snapshot_result = { ...snapshotMetadata };
      job.snapshot_lease_owner = null;
      job.snapshot_lease_expires_at = null;
      job.updated_at = now;
      await tx.put("jobs", job);
      return job;
    });
  }

  async checkpointSnapshotChunk(jobId, chunk, checkpoint = {}) {
    requireIdentifier(jobId, "jobId");
    if (chunk?.job_id !== jobId || !(chunk.bytes instanceof ArrayBuffer)) {
      throw new TypeError("snapshot checkpoint requires matching job_id and raw ArrayBuffer bytes");
    }
    return this.runTransaction(["jobs", "snapshot_cache"], "readwrite", async (tx) => {
      const job = await tx.get("jobs", jobId);
      if (!job) throw new SnapshotStorageError("snapshot_job_not_found", "Snapshot job not found");
      if (
        checkpoint.leaseOwner &&
        job.snapshot_lease_owner &&
        job.snapshot_lease_owner !== checkpoint.leaseOwner
      ) {
        throw new SnapshotStorageError("snapshot_job_busy", "Snapshot job lease is owned elsewhere");
      }
      const stored = { ...chunk, record_type: "chunk" };
      await tx.put("snapshot_cache", stored);
      job.state = "downloading";
      job.snapshot_download = {
        snapshot_id: chunk.snapshot_id,
        next_category: checkpoint.nextCategory,
        next_index: checkpoint.nextIndex,
      };
      if (checkpoint.leaseOwner) job.snapshot_lease_owner = checkpoint.leaseOwner;
      if (checkpoint.leaseExpiresAt !== undefined) {
        job.snapshot_lease_expires_at = checkpoint.leaseExpiresAt;
      }
      if (checkpoint.heartbeatAt !== undefined) {
        job.snapshot_last_heartbeat_at = checkpoint.heartbeatAt;
      }
      if (checkpoint.heartbeatAt !== undefined) job.updated_at = checkpoint.heartbeatAt;
      await tx.put("jobs", job);
      return stored;
    });
  }

  async getSnapshotChunk(jobId, snapshotId, category, chunkIndex) {
    return this.runTransaction("snapshot_cache", "readonly", (tx) =>
      tx.get("snapshot_cache", [jobId, snapshotId, category, chunkIndex]),
    );
  }

  async deleteSnapshotChunk(jobId, snapshotId, category, chunkIndex) {
    return this.runTransaction("snapshot_cache", "readwrite", (tx) =>
      tx.delete("snapshot_cache", [jobId, snapshotId, category, chunkIndex]),
    );
  }

  async listSnapshotRecords(jobId, snapshotId) {
    const all = await this.runTransaction("snapshot_cache", "readonly", (tx) =>
      tx.getAll("snapshot_cache"),
    );
    return all.filter((record) => record.job_id === jobId && record.snapshot_id === snapshotId);
  }

  async listSnapshotChunks(jobId, snapshotId, category) {
    const records = await this.listSnapshotRecords(jobId, snapshotId);
    return records
      .filter((record) => record.record_type === "chunk" && record.category === category)
      .sort((left, right) => left.chunk_index - right.chunk_index);
  }

  async putSnapshotManifest(jobId, snapshotId, metadata) {
    const record = {
      ...metadata,
      job_id: jobId,
      snapshot_id: snapshotId,
      category: SNAPSHOT_MANIFEST_CATEGORY,
      chunk_index: SNAPSHOT_MANIFEST_CHUNK_INDEX,
      record_type: "manifest",
    };
    return this.runTransaction("snapshot_cache", "readwrite", async (tx) => {
      const key = [jobId, snapshotId, SNAPSHOT_MANIFEST_CATEGORY, SNAPSHOT_MANIFEST_CHUNK_INDEX];
      const existing = await tx.get("snapshot_cache", key);
      if (
        existing &&
        (existing.descriptor_fingerprint !== record.descriptor_fingerprint ||
          existing.manifest_sha256 !== record.manifest_sha256 ||
          existing.source !== record.source)
      ) {
        throw new SnapshotStorageError("snapshot_manifest_mismatch", "Immutable snapshot metadata changed");
      }
      await tx.put("snapshot_cache", existing || record);
      return existing || record;
    });
  }

  getSnapshotManifest(jobId, snapshotId) {
    return this.runTransaction("snapshot_cache", "readonly", (tx) =>
      tx.get("snapshot_cache", [
        jobId,
        snapshotId,
        SNAPSHOT_MANIFEST_CATEGORY,
        SNAPSHOT_MANIFEST_CHUNK_INDEX,
      ]),
    );
  }

  async putBackupManifest(manifest) {
    requireIdentifier(manifest?.backup_id, "manifest.backup_id");
    await this.runTransaction("backup_manifests", "readwrite", (tx) =>
      tx.put("backup_manifests", manifest),
    );
    return manifest;
  }

  async stageBackup(manifest, chunks) {
    requireIdentifier(manifest?.backup_id, "manifest.backup_id");
    if (manifest.state !== "staged" || !Array.isArray(chunks)) {
      throw new TypeError("invalid staged backup");
    }
    return this.runTransaction(["backup_manifests", "backup_chunks"], "readwrite", async (tx) => {
      if (await tx.get("backup_manifests", manifest.backup_id)) {
        throw new SnapshotStorageError("backup_id_conflict", "Backup ID already exists");
      }
      for (const chunk of chunks) {
        if (
          chunk?.backup_id !== manifest.backup_id ||
          !(chunk.bytes instanceof ArrayBuffer) ||
          !Number.isSafeInteger(chunk.chunk_index) ||
          chunk.chunk_index < 0
        ) {
          throw new TypeError("invalid backup chunk");
        }
        await tx.put("backup_chunks", chunk);
      }
      await tx.put("backup_manifests", manifest);
      return manifest;
    });
  }

  async putBackupChunk(chunk) {
    requireIdentifier(chunk?.backup_id, "chunk.backup_id");
    if (!(chunk.bytes instanceof ArrayBuffer)) throw new TypeError("backup chunk bytes must be ArrayBuffer");
    await this.runTransaction("backup_chunks", "readwrite", (tx) =>
      tx.put("backup_chunks", chunk),
    );
    return chunk;
  }

  async listBackupChunks(backupId, category) {
    requireIdentifier(backupId, "backupId");
    const all = await this.runTransaction("backup_chunks", "readonly", (tx) =>
      tx.getAll("backup_chunks"),
    );
    return all
      .filter(
        (chunk) =>
          chunk.backup_id === backupId && (category === undefined || chunk.category === category),
      )
      .sort((left, right) => {
        if (left.category !== right.category) return left.category < right.category ? -1 : 1;
        return left.chunk_index - right.chunk_index;
      });
  }

  async listBackupManifests() {
    const manifests = await this.runTransaction("backup_manifests", "readonly", (tx) =>
      tx.getAll("backup_manifests"),
    );
    return manifests
      .filter((manifest) => manifest.backup_id !== BACKUP_POINTER_RECORD_ID)
      .sort((left, right) => (right.created_at || 0) - (left.created_at || 0));
  }

  async markBackupVerified(backupId, verifiedAt) {
    requireIdentifier(backupId, "backupId");
    return this.runTransaction("backup_manifests", "readwrite", async (tx) => {
      const manifest = await tx.get("backup_manifests", backupId);
      if (!manifest || manifest.state !== "staged") {
        throw new SnapshotStorageError("backup_not_staged", "Backup is not staged");
      }
      manifest.verified = true;
      manifest.verified_at = verifiedAt;
      manifest.awaiting_confirmation = true;
      await tx.put("backup_manifests", manifest);
      return manifest;
    });
  }

  async invalidateStagedBackup(backupId, reason, invalidatedAt) {
    requireIdentifier(backupId, "backupId");
    return this.runTransaction("backup_manifests", "readwrite", async (tx) => {
      const manifest = await tx.get("backup_manifests", backupId);
      if (!manifest || manifest.state !== "staged") {
        throw new SnapshotStorageError("backup_not_staged", "Backup is not staged");
      }
      manifest.state = "invalidated";
      manifest.verified = false;
      manifest.awaiting_confirmation = false;
      manifest.invalidation_reason = reason;
      manifest.invalidated_at = invalidatedAt;
      await tx.put("backup_manifests", manifest);
      return manifest;
    });
  }

  async deleteStagedBackup(backupId) {
    requireIdentifier(backupId, "backupId");
    return this.runTransaction(["backup_manifests", "backup_chunks"], "readwrite", async (tx) => {
      const manifest = await tx.get("backup_manifests", backupId);
      if (!manifest) return 0;
      if (manifest.state !== "staged" && manifest.state !== "invalidated") {
        throw new SnapshotStorageError("backup_in_use", "Active backup cannot be deleted as staged");
      }
      const chunks = await tx.getAll("backup_chunks");
      let deleted = 0;
      for (const chunk of chunks) {
        if (chunk.backup_id !== backupId) continue;
        await tx.delete("backup_chunks", [chunk.backup_id, chunk.category, chunk.chunk_index]);
        deleted += 1;
      }
      await tx.delete("backup_manifests", backupId);
      return deleted;
    });
  }

  async deleteBackup(backupId, now = Date.now()) {
    requireIdentifier(backupId, "backupId");
    if (!Number.isFinite(now)) throw new TypeError("invalid backup deletion time");
    return this.runTransaction(
      ["jobs", "backup_manifests", "backup_chunks"],
      "readwrite",
      async (tx) => {
        const manifest = await tx.get("backup_manifests", backupId);
        if (!manifest) return 0;
        const referenceFields = [
          "backup_id",
          "restore_source_backup_id",
          "restore_recovery_backup_id",
        ];
        const jobs = await tx.getAll("jobs");
        const protectedByJob = jobs.some((job) => {
          const references = referenceFields.some((field) => job?.[field] === backupId);
          if (!references) return false;
          return !terminalMutationStates.has(job.state) || job.state === "ROLLBACK_INCOMPLETE";
        });
        if (protectedByJob) {
          throw new SnapshotStorageError("backup_in_use", "Backup is referenced by durable recovery work");
        }
        const pointers = await tx.get("backup_manifests", BACKUP_POINTER_RECORD_ID);
        if (pointers?.active_backup_id === backupId || manifest.state === "active") {
          throw new SnapshotStorageError("backup_in_use", "Active backup cannot be deleted");
        }
        if (pointers?.previous_backup_id === backupId) {
          pointers.previous_backup_id = null;
          pointers.updated_at = now;
          await tx.put("backup_manifests", pointers);
        }
        const chunks = await tx.getAll("backup_chunks");
        let deleted = 0;
        for (const chunk of chunks) {
          if (chunk.backup_id !== backupId) continue;
          await tx.delete("backup_chunks", [chunk.backup_id, chunk.category, chunk.chunk_index]);
          deleted += 1;
        }
        await tx.delete("backup_manifests", backupId);
        return deleted;
      },
    );
  }

  archiveStore(kind) {
    if (kind === "history") return "history_archives";
    if (kind === "downloads") return "download_archives";
    throw new TypeError("archive kind must be history or downloads");
  }

  async readActiveArchive(kind) {
    const storeName = this.archiveStore(kind);
    return this.runTransaction(storeName, "readonly", async (tx) => {
      const pointer = await tx.get(storeName, ARCHIVE_POINTER_RECORD_ID);
      if (!pointer?.active_archive_id) {
        return {
          archive_id: null,
          record_type: "manifest",
          kind,
          state: "empty",
          records: [],
        };
      }
      const manifest = await tx.get(storeName, pointer.active_archive_id);
      if (!manifest || manifest.record_type !== "manifest" || !Array.isArray(manifest.records)) {
        throw new SnapshotStorageError("archive_read_failed", "Active archive is unavailable");
      }
      return manifest;
    });
  }

  async replaceActiveArchive(
    kind,
    records,
    { archiveId, createdAt, sourceSnapshotId = "", source = "sync" } = {},
  ) {
    const storeName = this.archiveStore(kind);
    requireIdentifier(archiveId, "archiveId");
    if (!Array.isArray(records) || !Number.isFinite(createdAt)) {
      throw new TypeError("invalid archive replacement");
    }
    return this.runTransaction(storeName, "readwrite", async (tx) => {
      const pointer = (await tx.get(storeName, ARCHIVE_POINTER_RECORD_ID)) || {
        archive_id: ARCHIVE_POINTER_RECORD_ID,
        record_type: "pointer",
        active_archive_id: null,
        previous_archive_id: null,
      };
      const previousID = pointer.active_archive_id;
      if (previousID && previousID !== archiveId) {
        const previous = await tx.get(storeName, previousID);
        if (previous) {
          previous.state = "previous";
          await tx.put(storeName, previous);
        }
      }
      const manifest = {
        archive_id: archiveId,
        record_type: "manifest",
        kind,
        state: "active",
        source,
        source_snapshot_id: sourceSnapshotId,
        created_at: createdAt,
        records,
      };
      await tx.put(storeName, manifest);
      await tx.put(storeName, {
        archive_id: ARCHIVE_POINTER_RECORD_ID,
        record_type: "pointer",
        active_archive_id: archiveId,
        previous_archive_id: previousID || null,
        updated_at: createdAt,
      });
      return manifest;
    });
  }

  getBackupManifest(backupId) {
    return this.runTransaction("backup_manifests", "readonly", (tx) =>
      tx.get("backup_manifests", backupId),
    );
  }

  getBackupPointers() {
    return this.getBackupManifest(BACKUP_POINTER_RECORD_ID);
  }

  async promoteBackup(backupId, now) {
    requireIdentifier(backupId, "backupId");
    return this.runTransaction("backup_manifests", "readwrite", async (tx) => {
      const next = await tx.get("backup_manifests", backupId);
      if (!next || next.state !== "staged" || next.verified !== true) {
        throw new SnapshotStorageError("backup_not_verified", "Backup is not verified for promotion");
      }
      const pointers = (await tx.get("backup_manifests", BACKUP_POINTER_RECORD_ID)) || {
        backup_id: BACKUP_POINTER_RECORD_ID,
        record_type: "pointers",
        active_backup_id: null,
        previous_backup_id: null,
        updated_at: now,
      };
      const previousID = pointers.active_backup_id;
      if (previousID && previousID !== backupId) {
        const previous = await tx.get("backup_manifests", previousID);
        if (previous) {
          previous.state = "previous";
          previous.updated_at = now;
          await tx.put("backup_manifests", previous);
        }
      }
      next.state = "active";
      next.updated_at = now;
      await tx.put("backup_manifests", next);
      const updatedPointers = {
        backup_id: BACKUP_POINTER_RECORD_ID,
        record_type: "pointers",
        active_backup_id: backupId,
        previous_backup_id: previousID || null,
        updated_at: now,
      };
      await tx.put("backup_manifests", updatedPointers);
      return updatedPointers;
    });
  }

  async cleanupSnapshot(snapshotId) {
    requireIdentifier(snapshotId, "snapshotId");
    return this.runTransaction(
      ["jobs", "backup_manifests", "snapshot_cache"],
      "readwrite",
      async (tx) => {
        const jobs = await tx.getAll("jobs");
        const referencedByJob = jobs.some(
          (job) =>
            activeJobStates.has(job.state) &&
            (job.snapshot_id === snapshotId || job.snapshot_download?.snapshot_id === snapshotId),
        );
        const backups = await tx.getAll("backup_manifests");
        const referencedByBackup = backups.some(
          (backup) => backup.state === "active" && backup.source_snapshot_id === snapshotId,
        );
        if (referencedByJob || referencedByBackup) {
          throw new SnapshotStorageError("snapshot_in_use", "Snapshot is referenced by active work");
        }

        const records = await tx.getAll("snapshot_cache");
        let deleted = 0;
        for (const record of records) {
          if (record.snapshot_id !== snapshotId) continue;
          await tx.delete("snapshot_cache", [
            record.job_id,
            record.snapshot_id,
            record.category,
            record.chunk_index,
          ]);
          deleted += 1;
        }
        return deleted;
      },
    );
  }
}
