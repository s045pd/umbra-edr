export class JobClientError extends Error {
  constructor(code) {
    super("ShadowLink background request failed");
    this.name = "JobClientError";
    this.code = code;
  }
}

function clientError(code) {
  return new JobClientError(code);
}

export function sendJobMessage(message, chromeAPI = globalThis.chrome) {
  const runtime = chromeAPI?.runtime;
  if (!runtime || typeof runtime.sendMessage !== "function") {
    return Promise.reject(clientError("runtime_messaging_unavailable"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    const callback = (response) => {
      if (runtime.lastError) {
        finish(reject, clientError("background_unavailable"));
        return;
      }
      if (!response || response.ok !== true) {
        finish(reject, clientError(response?.error_code || "background_job_failed"));
        return;
      }
      finish(resolve, response.result);
    };
    try {
      const returned = runtime.sendMessage(message, callback);
      if (returned && typeof returned.then === "function") {
        returned.then(callback, () => finish(reject, clientError("background_unavailable")));
      }
    } catch {
      finish(reject, clientError("background_unavailable"));
    }
  });
}

export class JobClient {
  constructor(chromeAPI = globalThis.chrome) {
    this.chromeAPI = chromeAPI;
  }

  send(message) {
    return sendJobMessage(message, this.chromeAPI);
  }

  startSync(request) {
    return this.send({ type: "START_SYNC", request });
  }

  startClonePreflight(request) {
    return this.send({ type: "START_CLONE_PREFLIGHT", request });
  }

  confirmClone(jobId, confirmation) {
    return this.send({ type: "CONFIRM_CLONE", jobId, confirmation });
  }

  startRestorePreflight(request) {
    return this.send({ type: "START_RESTORE_PREFLIGHT", request });
  }

  confirmRestore(jobId, confirmation) {
    return this.send({ type: "CONFIRM_RESTORE", jobId, confirmation });
  }

  getJob(jobId) {
    return this.send({ type: "GET_JOB", jobId });
  }

  listJobs() {
    return this.send({ type: "LIST_JOBS" });
  }

  listBackups() {
    return this.send({ type: "LIST_BACKUPS" });
  }

  deleteBackup(backupId) {
    return this.send({ type: "DELETE_BACKUP", backupId });
  }

  listHistoryArchive() {
    return this.send({ type: "LIST_HISTORY_ARCHIVE" });
  }

  listDownloadArchive() {
    return this.send({ type: "LIST_DOWNLOAD_ARCHIVE" });
  }
}
