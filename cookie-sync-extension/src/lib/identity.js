import canonicalize from "./canonicalize.js";

const supportedSameSite = new Set(["no_restriction", "lax", "strict", "unspecified"]);
const mutableSchemes = new Set(["http:", "https:"]);

export class IdentityValidationError extends Error {
  constructor(code) {
    super("Invalid browser item identity");
    this.name = "IdentityValidationError";
    this.code = code;
  }
}

function requireString(value, code, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new IdentityValidationError(code);
  }
  return value;
}

export function stableIdentity(prefix, parts) {
  return `${prefix}:${canonicalize(parts)}`;
}

export function normalizeURL(value) {
  requireString(value, "invalid_url");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new IdentityValidationError("invalid_url");
  }
  if (!parsed.protocol || !parsed.hostname && parsed.protocol !== "file:") {
    throw new IdentityValidationError("invalid_url");
  }
  return parsed.href;
}

// Download history is archived as data and is never navigated or replayed.
// Chrome can legitimately report opaque absolute URLs such as blob:, data:,
// and filesystem:, so archive identities must not require a hostname.
export function normalizeArchiveURL(value) {
  requireString(value, "invalid_url");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new IdentityValidationError("invalid_url");
  }
  if (!parsed.protocol) throw new IdentityValidationError("invalid_url");
  return parsed.href;
}

export function normalizeComparableURL(value) {
  let parsed;
  try {
    parsed = new URL(requireString(value, "invalid_tab_url"));
  } catch (error) {
    if (error instanceof IdentityValidationError) throw error;
    throw new IdentityValidationError("invalid_tab_url");
  }
  parsed.hash = "";
  if (parsed.pathname === "/") {
    return `${parsed.origin}${parsed.search}`;
  }
  return parsed.href;
}

export function normalizePartitionKey(partitionKey) {
  if (partitionKey === undefined || partitionKey === null) return null;
  if (!partitionKey || typeof partitionKey !== "object" || Array.isArray(partitionKey)) {
    throw new IdentityValidationError("invalid_cookie_partition_key");
  }
  let site;
  try {
    const parsed = new URL(requireString(partitionKey.topLevelSite, "invalid_cookie_partition_key"));
    if (!mutableSchemes.has(parsed.protocol)) throw new Error("scheme");
    site = parsed.origin;
  } catch {
    throw new IdentityValidationError("invalid_cookie_partition_key");
  }
  const normalized = { topLevelSite: site };
  if (partitionKey.hasCrossSiteAncestor !== undefined) {
    if (typeof partitionKey.hasCrossSiteAncestor !== "boolean") {
      throw new IdentityValidationError("invalid_cookie_partition_key");
    }
    normalized.hasCrossSiteAncestor = partitionKey.hasCrossSiteAncestor;
  }
  return normalized;
}

export function cookieIdentity(cookie, mappedStoreId) {
  requireString(mappedStoreId, "invalid_cookie_store");
  const domain = requireString(cookie?.domain, "invalid_cookie_domain").toLowerCase();
  const path = requireString(cookie?.path, "invalid_cookie_path");
  const name = requireString(cookie?.name, "invalid_cookie_name", { allowEmpty: true });
  return stableIdentity("cookie", [
    mappedStoreId,
    normalizePartitionKey(cookie.partitionKey),
    domain,
    path,
    name,
  ]);
}

function cookieHost(cookie) {
  return String(cookie?.domain || "").replace(/^\./, "").toLowerCase();
}

function cookieIsHostOnly(cookie) {
  return typeof cookie?.hostOnly === "boolean" ? cookie.hostOnly : !String(cookie?.domain || "").startsWith(".");
}

function domainCoversHost(cookie, host) {
  const base = cookieHost(cookie);
  if (!base || !host) return false;
  if (cookieIsHostOnly(cookie)) return base === host;
  return host === base || host.endsWith(`.${base}`);
}

function domainsOverlap(left, right) {
  return domainCoversHost(left, cookieHost(right)) || domainCoversHost(right, cookieHost(left));
}

function pathMatches(cookiePath, requestPath) {
  if (typeof cookiePath !== "string" || typeof requestPath !== "string") return false;
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  if (cookiePath.endsWith("/")) return true;
  return requestPath.charAt(cookiePath.length) === "/";
}

function pathsOverlap(left, right) {
  return pathMatches(left?.path, right?.path) || pathMatches(right?.path, left?.path);
}

function samePartitionKey(left, right) {
  try {
    return (
      canonicalize(normalizePartitionKey(left?.partitionKey)) ===
      canonicalize(normalizePartitionKey(right?.partitionKey))
    );
  } catch {
    return false;
  }
}

// Two cookies conflict when Chrome would send both on some request. The older
// destination cookie is listed first in Cookie, so a leftover logged-out SID
// makes a successful Sync still replay as logged out.
export function cookiesConflict(left, right) {
  if (!left || !right || left.name !== right.name) return false;
  if (!samePartitionKey(left, right)) return false;
  return domainsOverlap(left, right) && pathsOverlap(left, right);
}

function isPlainIPHost(host) {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) return true;
  return host.includes(":") && !host.includes(".");
}

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

// Public hosts use https even for non-Secure cookies so schemeful Same-Site
// still sends them on https pages. IP/loopback stay on http unless Secure.
export function cookieRequestURL(cookie) {
  const domain = requireString(cookie?.domain, "invalid_cookie_domain");
  const path = requireString(cookie?.path, "invalid_cookie_path");
  if (!path.startsWith("/")) throw new IdentityValidationError("invalid_cookie_path");
  const host = domain.replace(/^\./, "");
  const useHttps = cookie?.secure === true || !(isPlainIPHost(host) || isLoopbackHost(host));
  const urlHost = isPlainIPHost(host) && host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    return new URL(`${useHttps ? "https" : "http"}://${urlHost}${path}`).href;
  } catch {
    throw new IdentityValidationError("invalid_cookie_domain");
  }
}

export function cookieRemoveParams(cookie, options = {}) {
  const storeId = requireString(options.regularStoreId, "invalid_cookie_store");
  const name = requireString(cookie?.name, "invalid_cookie_name", { allowEmpty: true });
  const params = { url: cookieRequestURL(cookie), name, storeId };
  const partitionKey = normalizePartitionKey(cookie.partitionKey);
  if (partitionKey) params.partitionKey = partitionKey;
  return params;
}

export function cookieWriteIntent(cookie, options = {}) {
  let identity;
  let partitionKey;
  try {
    identity = cookieIdentity(cookie, options.regularStoreId);
    partitionKey = normalizePartitionKey(cookie.partitionKey);
  } catch (error) {
    return { kind: "invalid", reason: error.code || "invalid_cookie" };
  }
  if (partitionKey && options.supportsPartitionKey !== true) {
    return { kind: "unsupported", reason: "cookie_partition_key_unsupported", identity };
  }
  if (!supportedSameSite.has(cookie.sameSite)) {
    return { kind: "unsupported", reason: "cookie_same_site_unsupported", identity };
  }
  if (cookie.sameSite === "no_restriction" && cookie.secure !== true) {
    return { kind: "unsupported", reason: "cookie_samesite_none_requires_secure", identity };
  }
  const sameSite = cookie.sameSite === "unspecified" ? "lax" : cookie.sameSite;
  if (
    typeof cookie.value !== "string" ||
    typeof cookie.secure !== "boolean" ||
    (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== "boolean") ||
    (cookie.session !== undefined && typeof cookie.session !== "boolean") ||
    !cookie.path.startsWith("/")
  ) {
    return { kind: "invalid", reason: "invalid_cookie", identity };
  }
  const hostOnly =
    typeof cookie.hostOnly === "boolean" ? cookie.hostOnly : !cookie.domain.startsWith(".");
  let url;
  try {
    url = cookieRequestURL(cookie);
  } catch {
    return { kind: "invalid", reason: "invalid_cookie_domain", identity };
  }
  const params = {
    url,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly === true,
    sameSite,
    storeId: options.regularStoreId,
  };
  if (!hostOnly) params.domain = cookie.domain.toLowerCase();
  if (partitionKey) params.partitionKey = partitionKey;
  if (cookie.session !== true) {
    if (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= 0) {
      return { kind: "invalid", reason: "invalid_cookie_expiration", identity };
    }
    if (Number.isFinite(options.nowSeconds) && cookie.expirationDate <= options.nowSeconds) {
      return { kind: "unsupported", reason: "cookie_expired", identity };
    }
    params.expirationDate = cookie.expirationDate;
  }
  return { kind: "supported", identity, params };
}

export function historyIdentity(item) {
  return `history:${normalizeURL(item?.url)}`;
}

export function downloadIdentity(item) {
  const url = normalizeArchiveURL(item?.url);
  const startedAt = Date.parse(item?.startTime);
  const filename = requireString(item?.filename, "invalid_download_filename").normalize("NFC");
  if (!Number.isFinite(startedAt)) throw new IdentityValidationError("invalid_download_start_time");
  return stableIdentity("download", [url, startedAt, filename]);
}

export function tabIdentity(tab) {
  return `tab:${normalizeComparableURL(tab?.url)}`;
}

export function classifyMutableURL(value, category) {
  let parsed;
  try {
    parsed = new URL(requireString(value, `invalid_${category}_url`));
  } catch {
    return { kind: "invalid", reason: `invalid_${category}_url` };
  }
  if (!mutableSchemes.has(parsed.protocol)) {
    const reason = category === "tab" ? "restricted_tab_url" : `unsupported_${category}_scheme`;
    return { kind: "unsupported", reason, identity: `${category}:${parsed.href}`, url: parsed.href };
  }
  const url = category === "tab" ? normalizeComparableURL(parsed.href) : parsed.href;
  return { kind: "supported", identity: `${category}:${url}`, url };
}
