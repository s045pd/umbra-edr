const LEGACY_ROOT_IDS = Object.freeze({
  "1": "bookmark_bar",
  "2": "other",
  "3": "mobile",
});

const FOLDER_TYPE_ROOTS = Object.freeze({
  "bookmarks-bar": "bookmark_bar",
  other: "other",
  mobile: "mobile",
});

const LOGICAL_ROOT_PATTERN = /^(bookmark_bar|other|mobile)(?::(?:syncing|local))?$/;

export class BookmarkRootError extends Error {
  constructor(code) {
    super("Browser bookmark roots could not be mapped safely");
    this.name = "BookmarkRootError";
    this.code = code;
  }
}

export function unwrapBookmarkRoots(tree) {
  if (!Array.isArray(tree)) return [];
  return tree.length === 1 && tree[0]?.id === "0" && Array.isArray(tree[0].children)
    ? tree[0].children
    : tree;
}

function normalizeLogicalRoot(value) {
  if (value === "bookmarks-bar") return "bookmark_bar";
  return typeof value === "string" && LOGICAL_ROOT_PATTERN.test(value) ? value : null;
}

function logicalRootBase(node, rootMap) {
  if (!node || typeof node !== "object") return null;
  const mapped = typeof node.id === "string" ? normalizeLogicalRoot(rootMap?.[node.id]) : null;
  if (mapped) return mapped;
  const explicit = normalizeLogicalRoot(node.root);
  if (explicit) return explicit;
  if (typeof node.folderType === "string") {
    return FOLDER_TYPE_ROOTS[node.folderType] || null;
  }
  return typeof node.id === "string" ? LEGACY_ROOT_IDS[node.id] || null : null;
}

/**
 * Assigns profile-local permanent bookmark folders to stable logical names.
 * A single folder keeps the legacy logical name. When Chrome exposes both
 * account and local folders of the same type, the syncing flag keeps them
 * distinct so Clone can never flatten one tree into the other.
 */
export function bookmarkRootAssignments(tree, { rootMap } = {}) {
  const roots = unwrapBookmarkRoots(tree);
  const grouped = new Map();
  for (let index = 0; index < roots.length; index += 1) {
    const node = roots[index];
    const base = logicalRootBase(node, rootMap);
    if (!base) continue;
    const entries = grouped.get(base) || [];
    entries.push({
      index,
      id: typeof node?.id === "string" ? node.id : null,
      node,
      base,
    });
    grouped.set(base, entries);
  }

  const assignments = [];
  for (const [base, entries] of grouped) {
    if (entries.length === 1 || base.includes(":")) {
      if (entries.length > 1) throw new BookmarkRootError("bookmark_roots_ambiguous");
      assignments.push({ ...entries[0], logical: base });
      continue;
    }

    const logicalNames = new Set();
    for (const entry of entries) {
      if (typeof entry.node.syncing !== "boolean") {
        throw new BookmarkRootError("bookmark_roots_ambiguous");
      }
      const logical = `${base}:${entry.node.syncing ? "syncing" : "local"}`;
      if (logicalNames.has(logical)) {
        throw new BookmarkRootError("bookmark_roots_ambiguous");
      }
      logicalNames.add(logical);
      assignments.push({ ...entry, logical });
    }
  }
  return assignments.sort((left, right) => left.index - right.index);
}

export function inferWritableBookmarkRoots(tree, options) {
  const result = {};
  for (const assignment of bookmarkRootAssignments(tree, options)) {
    if (typeof assignment.id === "string") result[assignment.logical] = assignment.id;
  }
  return result;
}
