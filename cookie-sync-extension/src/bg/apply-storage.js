export function normalizeStorageOrigins(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const origin = item.origin;
    return typeof origin === "string" && /^https?:\/\//i.test(origin);
  });
}

export async function applyStorageOrigins(origins, applyFn) {
  const list = normalizeStorageOrigins(origins);
  for (const origin of list) {
    await applyFn(origin);
  }
  return list.length;
}
