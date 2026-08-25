import { createChromeAdapters } from "./chrome-adapters.js";
import { confirmCloneJob, prepareCloneJob, resumeCloneJob } from "./clone-job.js";
import { openShadowLinkDB } from "./idb.js";
import {
  confirmRestoreJob,
  deleteBackup,
  prepareRestoreJob,
  resumeRestoreJob,
} from "./restore-job.js";
import { normalizeSyncOptions, runSyncJob } from "./sync-job.js";
import {
  BookmarkRootError,
  inferWritableBookmarkRoots,
} from "../lib/bookmark-roots.js";

export const JOB_RUNNER_ALARM = "shadowlink-job-recovery";

const RECOVERABLE_CLONE_STATES = new Set([
  "RECHECKING_DESTINATION_DIGESTS",
  "PROMOTING_BACKUP",
  "APPLYING_COOKIES",
  "APPLYING_HISTORY",
  "APPLYING_BOOKMARKS",
  "APPLYING_DOWNLOAD_ARCHIVE",
  "APPLYING_TABS",
  "VERIFYING_DESTINATION",
  "ROLLING_BACK",
]);

const RECOVERABLE_RESTORE_STATES = new Set([
  "RECHECKING_DESTINATION_DIGESTS",
  "PROMOTING_RESTORE_RECOVERY_BACKUP",
  "APPLYING_RESTORE",
  "APPLYING_COOKIES",
  "APPLYING_HISTORY",
  "APPLYING_BOOKMARKS",
  "APPLYING_DOWNLOAD_ARCHIVE",
  "APPLYING_TABS",
  "VERIFYING_DESTINATION",
  "ROLLING_BACK",
]);

export class JobRunnerError extends Error {
  constructor(code) {
    super("ShadowLink background job operation failed");
    this.name = "JobRunnerError";
    this.code = code;
  }
}

export class WorkerTerminatedError extends Error {
  constructor() {
    super("ShadowLink worker terminated");
    this.name = "WorkerTerminatedError";
    this.code = "worker_terminated";
  }
}

function runnerError(code) {
  return new JobRunnerError(code);
}

function defaultWorkerID() {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return randomUUID ? `shadowlink-worker-${randomUUID()}` : `shadowlink-worker-${Date.now()}`;
}

function isWorkerTermination(error) {
  return error?.code === "worker_terminated";
}

function publicJobStatus(job) {
  if (!job) return null;
  const result = structuredClone(job);
  delete result.credentials;
  delete result.clone_snapshot;
  delete result.clone_plan;
  if (result.current_intent) {
    delete result.current_intent.payload;
  }
  return result;
}

function cloneConfirmation(message) {
  const source = message?.confirmation || message || {};
  return {
    backupId: source.backupId || source.backup_id,
    manifestSHA256: source.manifestSHA256 || source.manifest_sha256,
  };
}

function publicBackupManifest(manifest) {
  return {
    backup_id: manifest.backup_id,
    schema_version: manifest.schema_version,
    purpose: manifest.purpose,
    created_at: manifest.created_at,
    verified_at: manifest.verified_at,
    state: manifest.state,
    verified: manifest.verified === true,
    awaiting_confirmation: manifest.awaiting_confirmation === true,
    categories: Object.fromEntries(
      Object.entries(manifest.categories || {}).map(([category, descriptor]) => [
        category,
        {
          available: descriptor.available === true,
          complete: descriptor.complete === true,
          count: descriptor.count,
          byte_length: descriptor.byte_length,
          sha256: descriptor.sha256,
        },
      ]),
    ),
  };
}

export class JobRunner {
  constructor({
    db,
    workerId = defaultWorkerID(),
    leaseMs = 60_000,
    now = () => Date.now(),
    cloneDependencies = {},
    restoreDependencies = {},
    syncDependencies = {},
  } = {}) {
    if (!db || typeof db.claimMutationLease !== "function") {
      throw new TypeError("JobRunner requires a ShadowLink database");
    }
    if (typeof workerId !== "string" || workerId.length === 0) {
      throw new TypeError("JobRunner workerId must be a non-empty string");
    }
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || typeof now !== "function") {
      throw new TypeError("JobRunner lease configuration is invalid");
    }
    this.db = db;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.now = now;
    this.cloneDependencies = { ...cloneDependencies, db };
    this.restoreDependencies = { ...restoreDependencies, db };
    this.syncDependencies = { ...syncDependencies, db };
    this.activeJobId = null;
  }

  async heartbeat(jobId = this.activeJobId) {
    if (!jobId) return false;
    return this.db.renewMutationLease(jobId, this.workerId, this.leaseMs, this.now());
  }

  async operationDependencies(
    baseDependencies,
    jobId,
    { currentWindow = true, bookmarkRoots = true } = {},
  ) {
    const dependencies = { ...baseDependencies, db: this.db, now: this.now };
    const job = jobId ? await this.db.getJob(jobId) : null;
    if (currentWindow && !Number.isSafeInteger(dependencies.currentWindowId)) {
      if (Number.isSafeInteger(job?.destination_window_id)) {
        dependencies.currentWindowId = job.destination_window_id;
      } else {
        const tabs = await dependencies.adapters.enumerateTabs({ currentWindow: true });
        const windowIDs = [...new Set(tabs.map((tab) => tab?.windowId).filter(Number.isSafeInteger))];
        if (windowIDs.length !== 1) throw runnerError("current_window_unavailable");
        dependencies.currentWindowId = windowIDs[0];
      }
    }
    if (bookmarkRoots) {
      const persistedRoots = job?.writable_roots;
      if (!dependencies.writableRoots || Object.keys(dependencies.writableRoots).length === 0) {
        if (persistedRoots && Object.keys(persistedRoots).length > 0) {
          dependencies.writableRoots = structuredClone(persistedRoots);
        } else {
          try {
            dependencies.writableRoots = inferWritableBookmarkRoots(
              await dependencies.adapters.enumerateBookmarks(),
            );
          } catch (error) {
            if (error instanceof BookmarkRootError) throw error;
            throw runnerError("bookmark_roots_unavailable");
          }
        }
      }
      if (Object.keys(dependencies.writableRoots).length === 0) {
        throw runnerError("bookmark_roots_unavailable");
      }
      dependencies.bookmarkRoots = dependencies.bookmarkRoots || dependencies.writableRoots;
    }
    dependencies.cookieEnumerationComplete = dependencies.cookieEnumerationComplete !== false;
    dependencies.supportsPartitionKey = dependencies.supportsPartitionKey !== false;
    return dependencies;
  }

  async runWithLease(jobId, operation, baseDependencies = this.cloneDependencies) {
    if (typeof jobId !== "string" || jobId.length === 0 || typeof operation !== "function") {
      throw runnerError("invalid_job_request");
    }
    const claimed = await this.db.claimMutationLease(jobId, this.workerId, this.leaseMs, this.now());
    if (!claimed) throw runnerError("job_lease_unavailable");
    this.activeJobId = jobId;
    const dependencies = {
      ...baseDependencies,
      db: this.db,
      now: this.now,
      heartbeat: () => this.heartbeat(jobId),
    };
    let terminated = false;
    try {
      return await operation(dependencies);
    } catch (error) {
      terminated = isWorkerTermination(error);
      throw error;
    } finally {
      // A simulated or real worker termination leaves the durable lease in
      // place. A later worker may take it only after the recorded expiry.
      this.activeJobId = null;
      if (!terminated) {
        await this.db.releaseMutationLease(jobId, this.workerId, this.now());
      }
    }
  }

  async confirmClone(jobId, confirmation) {
    const dependencies = await this.operationDependencies(this.cloneDependencies, jobId);
    return this.runWithLease(
      jobId,
      (leased) => confirmCloneJob(jobId, cloneConfirmation(confirmation), leased),
      dependencies,
    );
  }

  async confirmRestore(jobId, confirmation) {
    const dependencies = await this.operationDependencies(this.restoreDependencies, jobId);
    return this.runWithLease(
      jobId,
      (leased) => confirmRestoreJob(jobId, confirmation, leased),
      dependencies,
    );
  }

  async recoverJobs() {
    const jobs = (await this.db.listJobs())
      .filter(
        (job) =>
          (job.kind === "clone" && RECOVERABLE_CLONE_STATES.has(job.state)) ||
          (job.kind === "restore" && RECOVERABLE_RESTORE_STATES.has(job.state)),
      )
      .sort((left, right) => (left.created_at || 0) - (right.created_at || 0));
    const recovered = [];
    for (const job of jobs) {
      let claimed = false;
      let terminated = false;
      try {
        claimed = await this.db.claimMutationLease(
          job.job_id,
          this.workerId,
          this.leaseMs,
          this.now(),
        );
        if (!claimed) continue;
        this.activeJobId = job.job_id;
        const configuredDependencies =
          job.kind === "restore" ? this.restoreDependencies : this.cloneDependencies;
        const baseDependencies = await this.operationDependencies(
          configuredDependencies,
          job.job_id,
        );
        const resume = job.kind === "restore" ? resumeRestoreJob : resumeCloneJob;
        await resume(job.job_id, {
          ...baseDependencies,
          db: this.db,
          now: this.now,
          heartbeat: () => this.heartbeat(job.job_id),
        });
        recovered.push(job.job_id);
      } catch (error) {
        terminated = isWorkerTermination(error);
        if (terminated) throw error;
        // Recovery is best-effort per durable job. The record and lease are
        // preserved/released below; another wake can retry a recoverable state.
      } finally {
        this.activeJobId = null;
        if (claimed && !terminated) {
          await this.db.releaseMutationLease(job.job_id, this.workerId, this.now());
        }
      }
    }
    return recovered;
  }

  async getJobStatus(jobId) {
    if (typeof jobId !== "string" || jobId.length === 0) throw runnerError("invalid_job_request");
    return publicJobStatus(await this.db.getJob(jobId));
  }

  async listPublicJobs() {
    return (await this.db.listJobs())
      .sort((left, right) => (right.updated_at || 0) - (left.updated_at || 0))
      .map(publicJobStatus);
  }

  async handleMessage(message) {
    await this.recoverJobs();
    switch (message?.type) {
      case "GET_JOB_STATUS":
      case "GET_JOB":
        return this.getJobStatus(message.jobId || message.job_id);
      case "LIST_JOBS":
        return this.listPublicJobs();
      case "START_CLONE_PREFLIGHT":
        {
          const dependencies = await this.operationDependencies(this.cloneDependencies);
          return publicJobStatus(
            await prepareCloneJob(message.request || message, dependencies),
          );
        }
      case "CONFIRM_CLONE":
        return publicJobStatus(
          await this.confirmClone(
            message.jobId || message.job_id,
            message.confirmation || message,
          ),
        );
      case "START_RESTORE_PREFLIGHT":
        {
          const dependencies = await this.operationDependencies(this.restoreDependencies);
          return publicJobStatus(
            await prepareRestoreJob(message.request || message, dependencies),
          );
        }
      case "CONFIRM_RESTORE":
        return publicJobStatus(
          await this.confirmRestore(
            message.jobId || message.job_id,
            message.confirmation || message,
          ),
        );
      case "DELETE_BACKUP":
        return {
          deleted_chunks: await deleteBackup(
            message.backupId || message.backup_id,
            { db: this.db, now: this.now },
          ),
        };
      case "LIST_BACKUPS":
        return (await this.db.listBackupManifests()).map(publicBackupManifest);
      case "LIST_HISTORY_ARCHIVE":
        return this.db.readActiveArchive("history");
      case "LIST_DOWNLOAD_ARCHIVE":
        return this.db.readActiveArchive("downloads");
      case "START_SYNC":
        {
          const request = message.request || message;
          const credentials = request.credentials || {
            username: request.username,
            password: request.password,
          };
          const options = normalizeSyncOptions(request.options);
          const dependencies = await this.operationDependencies(
            this.syncDependencies,
            undefined,
            {
              currentWindow: options.selected.tabs,
              bookmarkRoots: options.selected.bookmarks,
            },
          );
          await this.db.initializeSyncJob(
            request.jobId,
            credentials,
            options,
            this.now(),
            {
              server_origin: request.serverOrigin,
              history_range: options.historyRange,
              prefer_live: true,
            },
          );
          return this.runWithLease(
            request.jobId,
            (leased) => runSyncJob(request, leased),
            dependencies,
          );
        }
      default:
        throw runnerError("unsupported_job_message");
    }
  }
}

async function defaultRunnerFactory(chromeAPI) {
  const db = await openShadowLinkDB();
  const adapters = createChromeAdapters(chromeAPI);
  const dependencies = { db, adapters };
  return new JobRunner({
    db,
    cloneDependencies: dependencies,
    restoreDependencies: dependencies,
    syncDependencies: dependencies,
  });
}

export function installJobRunnerWakePaths(
  chromeAPI = globalThis.chrome,
  { runnerFactory = () => defaultRunnerFactory(chromeAPI) } = {},
) {
  if (!chromeAPI?.runtime || !chromeAPI?.alarms) {
    throw new TypeError("Chrome runtime and alarms APIs are required");
  }
  let runnerPromise;
  const getRunner = () => {
    if (!runnerPromise) runnerPromise = Promise.resolve().then(runnerFactory);
    return runnerPromise;
  };
  const recover = async () => {
    try {
      return await (await getRunner()).recoverJobs();
    } catch {
      // Wake handlers cannot surface asynchronous failures to Chrome. Durable
      // job state remains the source of truth for the next wake/popup message.
      return [];
    }
  };

  chromeAPI.runtime.onStartup.addListener(() => void recover());
  chromeAPI.runtime.onInstalled.addListener(() => void recover());
  chromeAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void (async () => {
      try {
        const runner = await getRunner();
        // Every job message first invokes recoverJobs inside handleMessage.
        sendResponse({ ok: true, result: await runner.handleMessage(message) });
      } catch (error) {
        sendResponse({
          ok: false,
          error_code:
            typeof error?.code === "string" ? error.code : "background_job_failed",
        });
      }
    })();
    return true;
  });
  chromeAPI.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === JOB_RUNNER_ALARM) void recover();
  });
  chromeAPI.alarms.create(JOB_RUNNER_ALARM, { periodInMinutes: 1 });
  void recover();
  return Object.freeze({ getRunner, recover });
}
