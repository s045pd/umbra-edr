import canonicalize from "../lib/canonicalize.js";
import { sha256Hex } from "../lib/hash.js";
import {
  LEGACY_SNAPSHOT_SOURCE,
  SNAPSHOT_ACQUISITION_TIMEOUT_MS,
  SNAPSHOT_CATEGORIES,
  SNAPSHOT_CHUNK_SIZE_BYTES,
  SNAPSHOT_DOWNLOAD_LEASE_MS,
  SNAPSHOT_ENDPOINTS,
  SNAPSHOT_MAX_CATEGORY_BYTES,
  SNAPSHOT_MAX_CATEGORY_ITEMS,
  SNAPSHOT_MAX_POLL_MS,
  SNAPSHOT_MAX_TOTAL_BYTES,
  SNAPSHOT_MIN_POLL_MS,
  SNAPSHOT_SCHEMA_VERSION,
  TRUSTED_SNAPSHOT_SOURCES,
} from "../lib/constants.js";
import { SnapshotStorageError } from "./idb.js";

const encoder = new TextEncoder();
const trustedSources = new Set(TRUSTED_SNAPSHOT_SOURCES);
const historyCoverages = new Set(["7", "30", "90", "all"]);
const digestPattern = /^[0-9a-f]{64}$/;

const ERROR_MESSAGES = Object.freeze({
  invalid_snapshot_request: "Invalid snapshot request",
  snapshot_transport_error: "Snapshot service request failed",
  snapshot_protocol_error: "Snapshot service returned invalid metadata",
  snapshot_digest_mismatch: "Snapshot integrity verification failed",
  snapshot_too_large: "Snapshot exceeds the supported limit",
  snapshot_acquisition_timeout: "Snapshot acquisition timed out",
  unsupported_snapshot_schema: "Snapshot schema is not supported",
  snapshot_job_busy: "Snapshot job is active in another worker",
  snapshot_job_not_found: "Snapshot job was not found",
  snapshot_job_conflict: "Snapshot job identity conflict",
  snapshot_manifest_mismatch: "Immutable snapshot metadata changed",
  snapshot_storage_error: "Snapshot storage operation failed",
  sensor_snapshot_upgrade_required: "The target Umbra Sensor must be updated or reloaded",
  sensor_snapshot_runtime_error: "The target Umbra Sensor snapshot runtime failed",
  cookies_api_error: "The target browser cookies API failed",
  history_api_error: "The target browser history API failed",
  history_invalid_item: "The target browser returned invalid history data",
  bookmarks_api_error: "The target browser bookmarks API failed",
  downloads_api_error: "The target browser downloads API failed",
  tabs_api_error: "The target browser tabs API failed",
});

export class SnapshotClientError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || "Snapshot operation failed");
    this.name = "SnapshotClientError";
    this.code = code;
  }
}

function clientError(code) {
  return new SnapshotClientError(code);
}

function normalizedError(error) {
  if (error instanceof SnapshotClientError) return error;
  if (error instanceof SnapshotStorageError) {
    if (ERROR_MESSAGES[error.code]) return clientError(error.code);
    return clientError("snapshot_storage_error");
  }
  return clientError("snapshot_storage_error");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function normalizeRequest(request) {
  const credentials = request?.credentials || {
    username: request?.username,
    password: request?.password,
  };
  if (
    typeof request?.jobId !== "string" ||
    request.jobId.length === 0 ||
    typeof request?.serverOrigin !== "string" ||
    request.serverOrigin.length === 0 ||
    typeof credentials?.username !== "string" ||
    credentials.username.length === 0 ||
    typeof credentials?.password !== "string" ||
    credentials.password.length === 0 ||
    !historyCoverages.has(request.historyRange)
  ) {
    throw clientError("invalid_snapshot_request");
  }
  let serverOrigin;
  try {
    const parsed = new URL(request.serverOrigin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
    serverOrigin = parsed.origin;
  } catch {
    throw clientError("invalid_snapshot_request");
  }
  return {
    jobId: request.jobId,
    serverOrigin,
    credentials: { username: credentials.username, password: credentials.password },
    historyRange: request.historyRange,
    preferLive: request.preferLive !== false,
  };
}

function normalizeDependencies(deps) {
  const fetchImplementation = deps?.fetch || globalThis.fetch?.bind(globalThis);
  if (!deps?.db || typeof deps.db.getJob !== "function" || typeof fetchImplementation !== "function") {
    throw clientError("invalid_snapshot_request");
  }
  return {
    db: deps.db,
    fetch: fetchImplementation,
    sleep: deps.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: deps.now || (() => Date.now()),
    parseJSON: deps.parseJSON || JSON.parse,
    leaseOwner: deps.leaseOwner || globalThis.crypto?.randomUUID?.() || `worker-${Date.now()}`,
    endpoints: { ...SNAPSHOT_ENDPOINTS, ...(deps.endpoints || {}) },
    acquisitionTimeoutMs: deps.acquisitionTimeoutMs || SNAPSHOT_ACQUISITION_TIMEOUT_MS,
    leaseMs: deps.leaseMs || SNAPSHOT_DOWNLOAD_LEASE_MS,
  };
}

function endpointURL(serverOrigin, path) {
  return new URL(path, `${serverOrigin}/`).toString();
}

async function postJSON(url, body, deps) {
  let response;
  try {
    response = await deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw clientError("snapshot_transport_error");
  }
  if (!response || response.ok !== true) {
    throw clientError("snapshot_transport_error");
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw clientError("snapshot_protocol_error");
  }
  if (!isPlainObject(envelope) || envelope.success !== true || !isPlainObject(envelope.result)) {
    throw clientError("snapshot_protocol_error");
  }
  return envelope.result;
}

function safeRemoteFailureCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value)
    ? value
    : "snapshot_transport_error";
}

async function persistFailure(db, jobId, error, now, leaseOwner) {
  const sanitized = normalizedError(error);
  try {
    await db.failJob(jobId, sanitized.code, now(), leaseOwner);
  } catch {
    // Do not replace the original sanitized failure with a storage payload/error.
  }
  return sanitized;
}

export async function resolveSnapshot(request, dependencies) {
  const normalizedRequest = normalizeRequest(request);
  const deps = normalizeDependencies(dependencies);
  const { db, now } = deps;
  try {
    let job = await db.initializeSnapshotJob(
      normalizedRequest.jobId,
      normalizedRequest.credentials,
      {
        server_origin: normalizedRequest.serverOrigin,
        history_range: normalizedRequest.historyRange,
        prefer_live: normalizedRequest.preferLive,
      },
      now(),
    );
    const claimed = await db.claimJobLease(
      normalizedRequest.jobId,
      deps.leaseOwner,
      deps.leaseMs,
      now(),
    );
    if (!claimed) throw clientError("snapshot_job_busy");

    let readyStatus = job.snapshot_ready_status;
    if (!readyStatus) {
      const startedAt = now();
      let status = await postJSON(
        endpointURL(normalizedRequest.serverOrigin, deps.endpoints.start),
        {
          username: normalizedRequest.credentials.username,
          password: normalizedRequest.credentials.password,
          history_range: normalizedRequest.historyRange,
          prefer_live: normalizedRequest.preferLive,
        },
        deps,
      );
      let polls = 0;
      const maximumPolls = Math.max(
        1,
        Math.ceil(deps.acquisitionTimeoutMs / SNAPSHOT_MIN_POLL_MS),
      );
      while (status.status === "pending") {
        if (
          typeof status.job_id !== "string" ||
          status.job_id.length === 0 ||
          now() - startedAt > deps.acquisitionTimeoutMs ||
          polls >= maximumPolls
        ) {
          throw clientError("snapshot_acquisition_timeout");
        }
        const delay = Math.min(
          SNAPSHOT_MAX_POLL_MS,
          Math.max(
            SNAPSHOT_MIN_POLL_MS,
            finiteInteger(status.poll_after_ms) ? status.poll_after_ms : SNAPSHOT_MIN_POLL_MS,
          ),
        );
        await deps.sleep(delay);
        status = await postJSON(
          endpointURL(normalizedRequest.serverOrigin, deps.endpoints.status),
          {
            username: normalizedRequest.credentials.username,
            password: normalizedRequest.credentials.password,
            job_id: status.job_id,
          },
          deps,
        );
        polls += 1;
        await db.renewJobLease(
          normalizedRequest.jobId,
          deps.leaseOwner,
          deps.leaseMs,
          now(),
        );
      }
      if (status.status === "failed") {
        throw clientError(safeRemoteFailureCode(status.error_code));
      }
      if (status.status !== "ready") throw clientError("snapshot_protocol_error");
      readyStatus = status;
    }

    return await resumeSnapshotDownload(normalizedRequest.jobId, readyStatus, {
      ...dependencies,
      db,
      fetch: deps.fetch,
      now,
      sleep: deps.sleep,
      parseJSON: deps.parseJSON,
      leaseOwner: deps.leaseOwner,
      leaseMs: deps.leaseMs,
      serverOrigin: normalizedRequest.serverOrigin,
      credentials: normalizedRequest.credentials,
    });
  } catch (error) {
    throw await persistFailure(db, normalizedRequest.jobId, error, now, deps.leaseOwner);
  }
}

function validateDescriptor(category, value, legacy) {
  if (!isPlainObject(value) || typeof value.available !== "boolean" || value.legacy !== legacy) {
    throw clientError("snapshot_protocol_error");
  }
  if (
    !finiteInteger(value.count) ||
    !finiteInteger(value.byte_length) ||
    !finiteInteger(value.chunk_count)
  ) {
    throw clientError("snapshot_protocol_error");
  }
  if (value.count > SNAPSHOT_MAX_CATEGORY_ITEMS || value.byte_length > SNAPSHOT_MAX_CATEGORY_BYTES) {
    throw clientError("snapshot_too_large");
  }
  if (!value.available) {
    if (value.count !== 0 || value.byte_length !== 0 || value.chunk_count !== 0 || value.sha256 !== "") {
      throw clientError("snapshot_protocol_error");
    }
  } else {
    if (
      value.byte_length < 2 ||
      !digestPattern.test(value.sha256) ||
      value.chunk_count < 1 ||
      value.chunk_count !== Math.ceil(value.byte_length / SNAPSHOT_CHUNK_SIZE_BYTES)
    ) {
      throw clientError("snapshot_protocol_error");
    }
  }
  return {
    available: value.available,
    legacy,
    count: value.count,
    byte_length: value.byte_length,
    sha256: value.sha256,
    chunk_count: value.chunk_count,
    ...(category === "history" && typeof value.coverage === "string"
      ? { coverage: value.coverage, truncated: Boolean(value.truncated) }
      : {}),
  };
}

function selectedCaptureManifest(status, fields) {
  const manifestFields = {};
  for (const category of SNAPSHOT_CATEGORIES) {
    const descriptor = fields[category];
    manifestFields[category] = {
      available: descriptor.available,
      count: descriptor.count,
      byte_length: descriptor.byte_length,
      sha256: descriptor.sha256,
      chunk_count: descriptor.chunk_count,
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
    fields: manifestFields,
  };
}

async function validateReadyStatus(status) {
  if (
    !isPlainObject(status) ||
    status.status !== "ready" ||
    typeof status.snapshot_id !== "string" ||
    status.snapshot_id.length === 0 ||
    !isPlainObject(status.fields)
  ) {
    throw clientError("snapshot_protocol_error");
  }
  const keys = Object.keys(status.fields).sort();
  if (
    keys.length !== SNAPSHOT_CATEGORIES.length ||
    !SNAPSHOT_CATEGORIES.every((category) => keys.includes(category))
  ) {
    throw clientError("snapshot_protocol_error");
  }

  const legacy = status.source === LEGACY_SNAPSHOT_SOURCE;
  if (!legacy && !trustedSources.has(status.source)) throw clientError("snapshot_protocol_error");
  const fields = {};
  let totalBytes = 0;
  for (const category of SNAPSHOT_CATEGORIES) {
    fields[category] = validateDescriptor(category, status.fields[category], legacy);
    totalBytes += fields[category].byte_length;
  }
  if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) throw clientError("snapshot_too_large");

  let manifestSHA256 = "";
  let manifestCanonical = "";
  let sensorVersion = "";
  if (legacy) {
    if (status.schema_version !== undefined && status.schema_version !== 0) {
      throw clientError("unsupported_snapshot_schema");
    }
  } else {
    if (status.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
      throw clientError("unsupported_snapshot_schema");
    }
    const startedAt = Date.parse(status.capture_started_at);
    const completedAt = Date.parse(status.capture_completed_at);
    if (
      typeof status.sensor_version !== "string" ||
      status.sensor_version.trim().length === 0 ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      completedAt < startedAt ||
      !historyCoverages.has(status.history_coverage) ||
      typeof status.history_truncated !== "boolean" ||
      !digestPattern.test(status.manifest_sha256)
    ) {
      throw clientError("snapshot_protocol_error");
    }
    sensorVersion = status.sensor_version;
    try {
      manifestCanonical = canonicalize(selectedCaptureManifest(status, fields));
    } catch {
      throw clientError("snapshot_protocol_error");
    }
    manifestSHA256 = await sha256Hex(encoder.encode(manifestCanonical));
    if (manifestSHA256 !== status.manifest_sha256) {
      throw clientError("snapshot_digest_mismatch");
    }
  }

  const cloneEligible =
    !legacy &&
    status.history_coverage === "all" &&
    status.history_truncated === false &&
    SNAPSHOT_CATEGORIES.every((category) => fields[category].available);
  const publicStatus = {
    status: "ready",
    snapshot_id: status.snapshot_id,
    source: status.source,
    schema_version: legacy ? 0 : SNAPSHOT_SCHEMA_VERSION,
    sensor_version: sensorVersion,
    capture_started_at: legacy ? "" : status.capture_started_at,
    capture_completed_at: legacy ? "" : status.capture_completed_at,
    history_coverage: status.history_coverage || "",
    history_truncated: Boolean(status.history_truncated),
    fallback_reason:
      typeof status.fallback_reason === "string" && /^[a-z0-9_]*$/.test(status.fallback_reason)
        ? status.fallback_reason
        : "",
    fields,
    manifest_sha256: manifestSHA256,
    manifest_canonical: manifestCanonical,
    trusted: !legacy,
    sync_only: legacy,
    clone_eligible: cloneEligible,
  };
  publicStatus.descriptor_fingerprint = await sha256Hex(
    encoder.encode(
      canonicalize({
        snapshot_id: publicStatus.snapshot_id,
        source: publicStatus.source,
        schema_version: publicStatus.schema_version,
        fields: publicStatus.fields,
        manifest_sha256: publicStatus.manifest_sha256,
      }),
    ),
  );
  return publicStatus;
}

function expectedChunkLength(descriptor, index) {
  return Math.min(
    SNAPSHOT_CHUNK_SIZE_BYTES,
    descriptor.byte_length - index * SNAPSHOT_CHUNK_SIZE_BYTES,
  );
}

async function validCachedChunk(record, expected) {
  if (
    !record ||
    record.record_type !== "chunk" ||
    record.job_id !== expected.jobId ||
    record.snapshot_id !== expected.snapshotId ||
    record.category !== expected.category ||
    record.chunk_index !== expected.index ||
    record.chunk_count !== expected.descriptor.chunk_count ||
    record.byte_length !== expected.length ||
    record.category_sha256 !== expected.descriptor.sha256 ||
    record.manifest_sha256 !== expected.manifestSHA256 ||
    !(record.bytes instanceof ArrayBuffer) ||
    record.bytes.byteLength !== expected.length ||
    !digestPattern.test(record.chunk_sha256)
  ) {
    return false;
  }
  return (await sha256Hex(record.bytes)) === record.chunk_sha256;
}

function requiredHeader(headers, name) {
  const value = headers.get(name);
  if (value === null) throw clientError("snapshot_protocol_error");
  return value;
}

function integerHeader(headers, name) {
  const value = requiredHeader(headers, name);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw clientError("snapshot_protocol_error");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw clientError("snapshot_protocol_error");
  return parsed;
}

async function fetchChunk(jobId, ready, category, index, credentials, serverOrigin, deps) {
  const descriptor = ready.fields[category];
  let response;
  try {
    response = await deps.fetch(endpointURL(serverOrigin, deps.endpoints.chunk), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: credentials.username,
        password: credentials.password,
        snapshot_id: ready.snapshot_id,
        category,
        chunk_index: index,
      }),
    });
  } catch {
    throw clientError("snapshot_transport_error");
  }
  if (!response || response.ok !== true || response.status !== 200) {
    throw clientError("snapshot_transport_error");
  }
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/octet-stream")) {
    throw clientError("snapshot_protocol_error");
  }

  let bytes;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw clientError("snapshot_transport_error");
  }
  const length = expectedChunkLength(descriptor, index);
  if (bytes.byteLength !== length || bytes.byteLength <= 0 || bytes.byteLength > SNAPSHOT_CHUNK_SIZE_BYTES) {
    throw clientError("snapshot_protocol_error");
  }
  const manifestHeader = response.headers.get("X-Manifest-SHA256") || "";
  if (
    requiredHeader(response.headers, "X-Snapshot-Id") !== ready.snapshot_id ||
    requiredHeader(response.headers, "X-Snapshot-Category") !== category ||
    integerHeader(response.headers, "X-Chunk-Index") !== index ||
    integerHeader(response.headers, "X-Chunk-Offset") !== index * SNAPSHOT_CHUNK_SIZE_BYTES ||
    integerHeader(response.headers, "X-Chunk-Count") !== descriptor.chunk_count ||
    integerHeader(response.headers, "X-Chunk-Length") !== length ||
    requiredHeader(response.headers, "X-Category-SHA256") !== descriptor.sha256 ||
    manifestHeader !== ready.manifest_sha256
  ) {
    throw clientError("snapshot_protocol_error");
  }
  const headerDigest = requiredHeader(response.headers, "X-Chunk-SHA256");
  if (!digestPattern.test(headerDigest) || (await sha256Hex(bytes)) !== headerDigest) {
    throw clientError("snapshot_digest_mismatch");
  }
  return {
    job_id: jobId,
    snapshot_id: ready.snapshot_id,
    category,
    chunk_index: index,
    byte_length: length,
    chunk_count: descriptor.chunk_count,
    chunk_sha256: headerDigest,
    category_sha256: descriptor.sha256,
    manifest_sha256: ready.manifest_sha256,
    bytes,
  };
}

function nextCursor(ready, categoryIndex, chunkIndex) {
  const current = SNAPSHOT_CATEGORIES[categoryIndex];
  if (chunkIndex + 1 < ready.fields[current].chunk_count) {
    return { nextCategory: current, nextIndex: chunkIndex + 1 };
  }
  for (let index = categoryIndex + 1; index < SNAPSHOT_CATEGORIES.length; index += 1) {
    const category = SNAPSHOT_CATEGORIES[index];
    if (ready.fields[category].available) return { nextCategory: category, nextIndex: 0 };
  }
  return { nextCategory: null, nextIndex: 0 };
}

async function obtainCategoryBytes(jobId, ready, category, categoryIndex, credentials, serverOrigin, deps) {
  const descriptor = ready.fields[category];
  const result = new Uint8Array(descriptor.byte_length);
  let offset = 0;
  for (let index = 0; index < descriptor.chunk_count; index += 1) {
    const expected = {
      jobId,
      snapshotId: ready.snapshot_id,
      category,
      index,
      descriptor,
      length: expectedChunkLength(descriptor, index),
      manifestSHA256: ready.manifest_sha256,
    };
    let chunk = await deps.db.getSnapshotChunk(jobId, ready.snapshot_id, category, index);
    if (!(await validCachedChunk(chunk, expected))) {
      if (chunk) await deps.db.deleteSnapshotChunk(jobId, ready.snapshot_id, category, index);
      chunk = await fetchChunk(jobId, ready, category, index, credentials, serverOrigin, deps);
      const cursor = nextCursor(ready, categoryIndex, index);
      const heartbeat = deps.now();
      await deps.db.checkpointSnapshotChunk(jobId, chunk, {
        leaseOwner: deps.leaseOwner,
        leaseExpiresAt: heartbeat + deps.leaseMs,
        heartbeatAt: heartbeat,
        ...cursor,
      });
    }
    const bytes = new Uint8Array(chunk.bytes);
    if (offset + bytes.byteLength > result.byteLength) throw clientError("snapshot_protocol_error");
    result.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== descriptor.byte_length) throw clientError("snapshot_protocol_error");
  if ((await sha256Hex(result)) !== descriptor.sha256) {
    throw clientError("snapshot_digest_mismatch");
  }
  return result;
}

function decodeCategory(bytes, descriptor, parseJSON) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw clientError("snapshot_protocol_error");
  }
  let value;
  try {
    value = parseJSON(text);
  } catch {
    throw clientError("snapshot_protocol_error");
  }
  if (!Array.isArray(value) || value.length !== descriptor.count) {
    throw clientError("snapshot_protocol_error");
  }
  return value;
}

function resultMetadata(ready) {
  return {
    snapshot_id: ready.snapshot_id,
    source: ready.source,
    schema_version: ready.schema_version,
    sensor_version: ready.sensor_version,
    capture_started_at: ready.capture_started_at,
    capture_completed_at: ready.capture_completed_at,
    history_coverage: ready.history_coverage,
    history_truncated: ready.history_truncated,
    fallback_reason: ready.fallback_reason,
    fields: ready.fields,
    manifest_sha256: ready.manifest_sha256,
    descriptor_fingerprint: ready.descriptor_fingerprint,
    trusted: ready.trusted,
    sync_only: ready.sync_only,
    clone_eligible: ready.clone_eligible,
  };
}

export async function resumeSnapshotDownload(jobId, readyStatus, dependencies) {
  const deps = normalizeDependencies(dependencies);
  try {
    const job = await deps.db.getJob(jobId);
    const serverOrigin = dependencies.serverOrigin || job?.snapshot_request?.server_origin;
    const credentials = dependencies.credentials || job?.credentials;
    if (
      !job ||
      typeof credentials?.username !== "string" ||
      typeof credentials?.password !== "string" ||
      typeof serverOrigin !== "string"
    ) {
      throw clientError("snapshot_job_not_found");
    }
    const ready = await validateReadyStatus(readyStatus);
    const claimed = await deps.db.claimJobLease(jobId, deps.leaseOwner, deps.leaseMs, deps.now());
    if (!claimed) throw clientError("snapshot_job_busy");
    await deps.db.setSnapshotReadyStatus(
      jobId,
      {
        ...ready,
        manifest_canonical: undefined,
      },
      deps.now(),
    );
    const existingManifest = await deps.db.getSnapshotManifest(jobId, ready.snapshot_id);
    if (
      existingManifest &&
      (existingManifest.descriptor_fingerprint !== ready.descriptor_fingerprint ||
        existingManifest.manifest_sha256 !== ready.manifest_sha256 ||
        existingManifest.source !== ready.source)
    ) {
      throw clientError("snapshot_manifest_mismatch");
    }

    const categories = {};
    for (let categoryIndex = 0; categoryIndex < SNAPSHOT_CATEGORIES.length; categoryIndex += 1) {
      const category = SNAPSHOT_CATEGORIES[categoryIndex];
      const descriptor = ready.fields[category];
      if (!descriptor.available) continue;
      const bytes = await obtainCategoryBytes(
        jobId,
        ready,
        category,
        categoryIndex,
        credentials,
        serverOrigin,
        deps,
      );
      categories[category] = decodeCategory(bytes, descriptor, deps.parseJSON);
      await deps.db.renewJobLease(jobId, deps.leaseOwner, deps.leaseMs, deps.now());
    }

    const metadata = resultMetadata(ready);
    await deps.db.putSnapshotManifest(jobId, ready.snapshot_id, {
      ...metadata,
      manifest_canonical: ready.manifest_canonical,
      verified: true,
      verified_at: deps.now(),
    });
    await deps.db.completeSnapshotJob(jobId, metadata, deps.now());
    return { ...metadata, categories };
  } catch (error) {
    throw await persistFailure(deps.db, jobId, error, deps.now, deps.leaseOwner);
  }
}
