/*
 * RFC 8785 JSON canonicalization adapted from canonicalize 4.0.0.
 * Copyright Erdtman and contributors; Apache-2.0.
 * See /THIRD_PARTY_NOTICES.md and /third_party/canonicalize/LICENSE.
 */
(function attachCanonicalizer(root, factory) {
  const canonicalize = factory();
  root.UmbraCanonicalize = canonicalize;
  if (typeof module === "object" && module && module.exports) {
    module.exports = canonicalize;
  }
})(globalThis, function makeCanonicalizer() {
  function hasLoneSurrogate(value) {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i === value.length - 1) return true;
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function canonicalize(object, seen = new Set()) {
    if (typeof object === "number" && Number.isNaN(object)) {
      throw new Error("NaN is not allowed");
    }
    if (typeof object === "number" && !Number.isFinite(object)) {
      throw new Error("Infinity is not allowed");
    }
    if (typeof object === "string" && hasLoneSurrogate(object)) {
      throw new Error("Lone surrogate is not allowed");
    }
    if (object === null || typeof object !== "object") {
      return JSON.stringify(object);
    }
    if (typeof object.toJSON === "function") {
      if (seen.has(object)) throw new Error("Circular reference detected");
      seen.add(object);
      const result = canonicalize(object.toJSON(), seen);
      seen.delete(object);
      return result;
    }
    if (seen.has(object)) throw new Error("Circular reference detected");
    seen.add(object);

    let result;
    if (Array.isArray(object)) {
      result = `[${object
        .map((item) =>
          canonicalize(item === undefined || typeof item === "symbol" ? null : item, seen),
        )
        .join(",")}]`;
    } else {
      const parts = [];
      for (const key of Object.keys(object).sort()) {
        const value = object[key];
        if (value === undefined || typeof value === "symbol") continue;
        parts.push(`${canonicalize(key)}:${canonicalize(value, seen)}`);
      }
      result = `{${parts.join(",")}}`;
    }
    seen.delete(object);
    return result;
  }

  return canonicalize;
});
