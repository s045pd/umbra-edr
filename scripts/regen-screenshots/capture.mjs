#!/usr/bin/env node
/**
 * capture.mjs — Playwright screenshot capture for Umbra EDR
 *
 * Usage:
 *   node capture.mjs [--base-url <url>] [--out-dir <path>]
 *
 * Defaults:
 *   --base-url  http://localhost:8218
 *   --out-dir   ../../images/screenshots
 *
 * Environment overrides:
 *   UMBRA_BASE_URL  e.g. http://localhost:8218
 *   UMBRA_OUT_DIR   absolute or relative output path
 */

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function arg(flag, envKey, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (process.env[envKey]) return process.env[envKey];
  return fallback;
}

const BASE_URL = arg('--base-url', 'UMBRA_BASE_URL', 'http://localhost:8218');
const OUT_DIR  = arg('--out-dir',  'UMBRA_OUT_DIR',  path.resolve(__dirname, '../../images/screenshots'));

const VIEWPORT = { width: 1280, height: 800 };
const TIMEOUT  = 30_000;

// ---------------------------------------------------------------------------
// Helper: wait until a URL returns HTTP 200 (poll, up to maxMs)
// ---------------------------------------------------------------------------
async function waitForUrl(url, maxMs = 60_000, intervalMs = 1_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url} to become reachable`);
}

// ---------------------------------------------------------------------------
// Screenshot definitions
// ---------------------------------------------------------------------------
const shots = [
  {
    name: 'login',
    // /login/ (trailing slash) resolves to gui/dist/login/index.html via the
    // SPA-route fallback that run.sh creates after build. The full-stack mode
    // serves this client-side via vue-router's createWebHistory().
    path: '/login/',
    waitFor: async (page) => {
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT });
      try {
        await page.waitForSelector('input[type="password"]', {
          state: 'visible',
          timeout: TIMEOUT,
        });
      } catch {
        console.warn('[capture] password field selector timed out — taking screenshot anyway');
      }
      // Give the router and web fonts a beat to settle.
      await page.waitForTimeout(1500);
    },
    file: 'login.png',
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`[capture] base URL : ${BASE_URL}`);
  console.log(`[capture] output   : ${OUT_DIR}`);

  // Ensure output directory exists.
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Wait for server to be ready.
  console.log('[capture] waiting for server…');
  await waitForUrl(BASE_URL, 90_000);
  console.log('[capture] server is up');

  const browser = await chromium.launch({ headless: true });

  try {
    for (const shot of shots) {
      console.log(`[capture] → ${shot.name} (${shot.path})`);

      const page = await browser.newPage();
      await page.setViewportSize(VIEWPORT);

      await page.goto(`${BASE_URL}${shot.path}`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT,
      });

      await shot.waitFor(page);

      // If the router redirected us to /login (auth guard), re-check path.
      const finalUrl = page.url();
      console.log(`[capture]   landed at ${finalUrl}`);

      const outFile = path.join(OUT_DIR, shot.file);
      await page.screenshot({ path: outFile, fullPage: false });

      const stat = fs.statSync(outFile);
      console.log(`[capture]   saved ${outFile} (${(stat.size / 1024).toFixed(1)} KB)`);

      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log('[capture] done');
}

main().catch((err) => {
  console.error('[capture] FATAL:', err.message);
  process.exit(1);
});
