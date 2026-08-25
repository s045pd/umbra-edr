function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function buildBackupRows(manifests = [], { undoRestoreBackupId = "" } = {}) {
  return manifests
    .filter((manifest) => manifest && typeof manifest.backup_id === "string")
    .map((manifest) => {
      const totalCount = Object.values(manifest.categories || {}).reduce(
        (total, descriptor) => total + safeCount(descriptor?.count),
        0,
      );
      return Object.freeze({
        backupId: manifest.backup_id,
        state: manifest.state || "unknown",
        purpose: manifest.purpose || "unknown",
        createdAt: manifest.created_at || 0,
        verified: manifest.verified === true,
        totalCount,
        isUndoRestore: manifest.backup_id === undoRestoreBackupId,
        canRestore:
          manifest.verified === true && ["active", "previous"].includes(manifest.state),
        canDelete: manifest.state !== "active",
        categoryCounts: Object.fromEntries(
          Object.entries(manifest.categories || {}).map(([category, descriptor]) => [
            category,
            safeCount(descriptor?.count),
          ]),
        ),
      });
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

function searchableText(record) {
  if (!record || typeof record !== "object") return "";
  return Object.values(record)
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .join(" ")
    .toLocaleLowerCase();
}

export function filterArchivePage(records = [], options = {}) {
  const query = String(options.query || "").trim().toLocaleLowerCase();
  const pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize > 0
    ? options.pageSize
    : 20;
  const filtered = query
    ? records.filter((record) => searchableText(record).includes(query))
    : [...records];
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Number.isSafeInteger(options.page) ? options.page : 1;
  const page = Math.max(1, Math.min(requestedPage, totalPages));
  const start = (page - 1) * pageSize;
  return Object.freeze({
    query,
    page,
    pageSize,
    total: filtered.length,
    totalPages,
    records: filtered.slice(start, start + pageSize),
  });
}

export function buildArchiveExport(kind, records = [], exportedAt = Date.now()) {
  if (!["history", "downloads"].includes(kind) || !Array.isArray(records)) {
    throw new TypeError("invalid archive export");
  }
  const payload = {
    schema_version: 1,
    kind,
    exported_at: exportedAt,
    count: records.length,
    records,
  };
  return {
    filename: `shadowlink-${kind}-${exportedAt}.json`,
    json: JSON.stringify(payload, null, 2),
  };
}
