import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssURL = new URL("../src/browser_action/popup-styles.css", import.meta.url);

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("operation modal keeps Clone actions visible and scrolls only its body", async () => {
  const css = await readFile(cssURL, "utf8");
  const modal = cssRule(css, ".operation-modal");
  const card = cssRule(css, ".operation-modal-card");
  const body = cssRule(css, ".operation-modal-body");
  const footer = cssRule(css, ".operation-modal-footer");

  assert.match(modal, /height\s*:\s*100(?:dvh|vh)/);
  assert.match(card, /display\s*:\s*flex/);
  assert.match(card, /flex-direction\s*:\s*column/);
  assert.match(card, /overflow\s*:\s*hidden/);
  assert.doesNotMatch(card, /overflow-y\s*:\s*auto/);
  assert.match(body, /min-height\s*:\s*0/);
  assert.match(body, /overflow-y\s*:\s*auto/);
  assert.match(footer, /flex-shrink\s*:\s*0/);
});
