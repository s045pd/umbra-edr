import { SNAPSHOT_CATEGORIES } from "../lib/constants.js";

export class LiveBrowserError extends Error {
  constructor(code) {
    super("Live browser fetch failed");
    this.name = "LiveBrowserError";
    this.code = code;
  }
}

function liveError(code) {
  return new LiveBrowserError(code);
}

const categoryEndpoints = Object.freeze({
  cookies: { path: "/api/v1/get-bot-browser-cookies", key: "cookies" },
  history: { path: "/api/v1/get-bot-browser", key: "history" },
});

function unavailableField() {
  return {
    available: false,
    legacy: false,
    count: 0,
    byte_length: 0,
    sha256: "",
    chunk_count: 0,
  };
}

function availableField(items) {
  const body = JSON.stringify(items);
  return {
    available: true,
    legacy: false,
    count: items.length,
    byte_length: body.length,
    sha256: "",
    chunk_count: 1,
  };
}

async function postJSON(url, body, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw liveError("snapshot_transport_error");
  }
  if (!response || response.ok !== true) {
    throw liveError(response?.status === 502 ? "endpoint_offline_no_snapshot" : "snapshot_transport_error");
  }
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw liveError("snapshot_protocol_error");
  }
  if (!envelope || envelope.success !== true || !envelope.result || typeof envelope.result !== "object") {
    throw liveError("snapshot_protocol_error");
  }
  return envelope.result;
}

async function fetchCategory(category, request, fetchImpl) {
  const endpoint = categoryEndpoints[category];
  if (!endpoint) return null;
  const result = await postJSON(
    new URL(endpoint.path, `${request.serverOrigin}/`).toString(),
    { username: request.username, password: request.password },
    fetchImpl,
  );
  const items = result[endpoint.key];
  if (!Array.isArray(items)) throw liveError("snapshot_protocol_error");
  return items;
}

async function fetchStateBundle(request, categories, fetchImpl) {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  let response;
  try {
    response = await fetchImpl(new URL("/api/v1/get-bot-browser-state", `${request.serverOrigin}/`).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: request.username,
        password: request.password,
        categories,
      }),
    });
  } catch {
    return null;
  }
  if (!response || response.status === 404 || response.ok !== true) return null;
  try {
    const envelope = await response.json();
    if (!envelope || envelope.success !== true || !envelope.result || typeof envelope.result !== "object") {
      return null;
    }
    return envelope.result;
  } catch {
    return null;
  }
}

export async function fetchLiveSyncSnapshot(request, dependencies = {}) {
  if (
    typeof request?.serverOrigin !== "string" ||
    typeof request?.username !== "string" ||
    typeof request?.password !== "string"
  ) {
    throw liveError("invalid_snapshot_request");
  }
  const fetchImpl = dependencies.fetch || globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") throw liveError("snapshot_transport_error");
  const selected = request.selected || { cookies: true };
  const extraCategories = SNAPSHOT_CATEGORIES.filter(
    (category) => selected[category] === true && !categoryEndpoints[category],
  );
  const bundle = await fetchStateBundle(request, extraCategories, fetchImpl);
  const categories = {};
  const fields = {};
  for (const category of SNAPSHOT_CATEGORIES) {
    if (selected[category] !== true) {
      categories[category] = [];
      fields[category] = unavailableField();
      continue;
    }
    let items = null;
    if (categoryEndpoints[category]) {
      items = await fetchCategory(category, request, fetchImpl);
    } else if (Array.isArray(bundle?.[category])) {
      items = bundle[category];
    }
    if (!items) {
      categories[category] = [];
      fields[category] = unavailableField();
      continue;
    }
    categories[category] = items;
    fields[category] = availableField(items);
  }
  if (selected.cookies === true && fields.cookies.available !== true) {
    throw liveError("snapshot_transport_error");
  }
  return {
    snapshot_id: `live-${request.jobId || "sync"}`,
    source: "live",
    trusted: true,
    sync_only: false,
    schema_version: 1,
    history_coverage: "all",
    history_truncated: false,
    fields,
    categories,
  };
}
