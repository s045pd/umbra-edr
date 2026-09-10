#!/usr/bin/env node
/**
 * Playwright screenshots for the Umbra README.
 *
 * NEVER pointed at a live operator console. Every /api/v1 request is
 * fulfilled with synthetic example.test fixtures, and immediately before
 * each inner-page shot the DOM is rewritten in the page (browser-side)
 * so leftover hostnames, emails, cookies, and remote images cannot land
 * in the PNG.
 */
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function arg(flag, envKey, fallback) {
  const idx = process.argv.indexOf(flag)
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  if (process.env[envKey]) return process.env[envKey]
  return fallback
}

const BASE_URL = arg('--base-url', 'UMBRA_BASE_URL', 'http://localhost:9218')
const OUT_DIR = arg('--out-dir', 'UMBRA_OUT_DIR', path.resolve(__dirname, '../../images/screenshots'))
const VIEWPORT = { width: 1440, height: 900 }
const TIMEOUT = 30_000
const BOT_ID = '11111111-1111-4111-8111-111111111111'

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(tag, data) {
  const t = Buffer.from(tag)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function placeholderPng(w = 640, h = 360) {
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      if (y < 36) {
        rgb[i] = 18; rgb[i + 1] = 24; rgb[i + 2] = 38
      } else if (y < 39) {
        rgb[i] = 232; rgb[i + 1] = 168; rgb[i + 2] = 56
      } else {
        rgb[i] = 11; rgb[i + 1] = 16; rgb[i + 2] = 28
      }
    }
  }
  const raw = []
  for (let y = 0; y < h; y++) {
    raw.push(0)
    raw.push(...rgb.subarray(y * w * 3, (y + 1) * w * 3))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.from(raw))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const PLACEHOLDER = placeholderPng()

const now = '2026-09-10T08:14:00.000Z'
const earlier = '2026-09-10T07:51:00.000Z'
const old = '2026-09-09T22:10:00.000Z'

const bots = [
  {
    id: BOT_ID,
    name: 'lab-workstation-04',
    browser_id: 'demo-browser-01-aaaaaaaaaaaa',
    is_online: true,
    last_online: now,
    last_active_at: now,
    createdAt: old,
    proxy_username: 'px-lab04',
    proxy_password: 'demo-pass-01',
    state: 'idle',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
    current_tab: { id: 1, url: 'https://intranet.example.test/mail', title: 'Inbox — Contoso Mail' },
    current_tab_image: true,
    current_tab_image_at: now,
    tabs: 3,
    history: 18,
    switch_config: {
      SYNC: true, SYNC_HUGE: true, REALTIME_IMG: true, NOTIFICATION: true,
      PERSISTENT_KEYBOARD: true, DNR_BLOCK: true, CANARY: false, DEBUGGER: false,
      PERSISTENT_RECORDING: false,
    },
    data_config: { NOTIFICATION_DOMAINS: ['payroll.example.test'] },
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'finance-kiosk-01',
    browser_id: 'demo-browser-02-bbbbbbbbbbbb',
    is_online: true,
    last_online: now,
    last_active_at: now,
    createdAt: old,
    proxy_username: 'px-fin01',
    proxy_password: 'demo-pass-02',
    state: 'idle',
    user_agent: 'Mozilla/5.0',
    current_tab: { id: 1, url: 'https://intranet.example.test/finance/close', title: 'Period close' },
    current_tab_image: true,
    current_tab_image_at: now,
    tabs: 5,
    history: 42,
    switch_config: { SYNC: true, NOTIFICATION: true, REALTIME_IMG: true },
    data_config: {},
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'research-vm-west',
    browser_id: 'demo-browser-03-cccccccccccc',
    is_online: false,
    last_online: earlier,
    last_active_at: earlier,
    createdAt: old,
    proxy_username: 'px-rvm01',
    proxy_password: 'demo-pass-03',
    state: '',
    user_agent: 'Mozilla/5.0',
    current_tab: { id: 1, url: 'https://wiki.example.test/papers', title: 'Internal papers' },
    current_tab_image: false,
    tabs: 2,
    history: 9,
    switch_config: { SYNC: true },
    data_config: {},
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'ci-runner-chrome',
    browser_id: 'demo-browser-04-dddddddddddd',
    is_online: false,
    last_online: old,
    last_active_at: old,
    createdAt: old,
    proxy_username: 'px-ci01',
    proxy_password: 'demo-pass-04',
    state: '',
    user_agent: 'Mozilla/5.0',
    current_tab: { id: 1, url: 'https://ci.example.test/job/browser-smoke', title: 'browser-smoke #1842' },
    current_tab_image: false,
    tabs: 1,
    history: 3,
    switch_config: {},
    data_config: {},
  },
]

const fields = {
  tabs: [
    { id: 1, url: 'https://intranet.example.test/mail', title: 'Inbox — Contoso Mail', active: true },
    { id: 2, url: 'https://wiki.example.test/runbooks/edr', title: 'EDR runbook', active: false },
    { id: 3, url: 'https://id.example.test/account', title: 'Account', active: false },
  ],
  history: [
    { url: 'https://intranet.example.test/mail', title: 'Inbox — Contoso Mail', visitCount: 14, lastVisitTime: Date.parse(now) },
    { url: 'https://wiki.example.test/runbooks/edr', title: 'EDR runbook', visitCount: 4, lastVisitTime: Date.parse(earlier) },
  ],
  cookies: [
    { name: 'PHPSESSID', value: 'demo-session-alpha', domain: '.intranet.example.test', path: '/', secure: true, httpOnly: true },
    { name: 'locale', value: 'en-US', domain: 'intranet.example.test', path: '/' },
  ],
  bookmarks: [
    { title: 'Wiki', url: 'https://wiki.example.test/' },
    { title: 'Mail', url: 'https://intranet.example.test/mail' },
  ],
  downloads: [
    { filename: 'q3-policy.pdf', url: 'https://wiki.example.test/files/q3-policy.pdf', state: 'complete', bytesReceived: 248832, totalBytes: 248832, startTime: now },
  ],
  activity: [
    { start: Date.parse(old), end: Date.parse(now) },
    { start: Date.parse(earlier), end: Date.parse(now) },
  ],
}

const ok = (result) => ({ success: true, result })
const shotId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

let session = false

function mockApi(url, method) {
  const u = new URL(url)
  const p = u.pathname
  const q = u.searchParams
  if (p === '/health' || p === '/version') return { json: { success: true, name: 'umbra-server', version: '0.4.0-dev' } }
  if (p === '/api/v1/login' && method === 'POST') {
    session = true
    return { json: ok({ username: 'admin', password_should_be_changed: false, role: 'admin', totp_enabled: false }) }
  }
  if (p === '/api/v1/me') {
    if (!session) return { status: 401, json: { success: false, error: 'unauthorized' } }
    return { json: ok({ username: 'admin', password_should_be_changed: false, role: 'admin', totp_enabled: false }) }
  }
  if (p === '/api/v1/logout') return { json: ok({}) }
  if (p === '/api/v1/bots' && method === 'GET') {
    return { json: ok({ bots, pagination: { total: bots.length, page: 1, limit: 20, totalPages: 1 } }) }
  }
  if (p.includes('/bots/image/') || p.endsWith('/snapshot')) {
    return { body: PLACEHOLDER, contentType: 'image/png' }
  }
  if (p === `/api/v1/bots/${BOT_ID}` || /\/api\/v1\/bots\/[0-9a-f-]+$/.test(p)) {
    const id = p.split('/').pop()
    return { json: ok(bots.find((b) => b.id === id) ?? bots[0]) }
  }
  if (p.endsWith('/timeline')) {
    return {
      json: ok([
        { id: 'n1', kind: 'nav', timestamp: now, url: 'https://intranet.example.test/mail', title: 'Inbox — Contoso Mail' },
        { id: 'k1', kind: 'keyboard', timestamp: now, url: 'https://id.example.test/account', title: 'Account', text: 'quarterly-review-notes' },
        { id: shotId, kind: 'screenshot', timestamp: now, url: 'https://intranet.example.test/mail', title: 'Inbox — Contoso Mail', screenshot_id: shotId },
        { id: 'c1', kind: 'clipboard', timestamp: earlier, url: 'https://wiki.example.test/runbooks/edr', title: 'EDR runbook', text: 'https://wiki.example.test/runbooks/edr#triage' },
        { id: 'a1', kind: 'alert', timestamp: now, url: 'https://payroll.example.test/login', title: 'Watched domain visit', text: 'lab-workstation-04 opened payroll.example.test' },
      ]),
    }
  }
  if (p === '/api/v1/fields') {
    return { json: ok(fields[q.get('field')] ?? []) }
  }
  if (p === '/api/v1/alerts') {
    return {
      json: ok([
        { id: 'al1', bot_id: BOT_ID, kind: 'domain', severity: 'high', title: 'Watched domain visit', url: 'https://payroll.example.test/login', detail: 'lab-workstation-04 opened payroll.example.test', timestamp: now, acknowledged: false },
        { id: 'al2', bot_id: bots[1].id, kind: 'domain', severity: 'medium', title: 'Watched domain visit', url: 'https://vpn.example.test/portal', detail: 'finance-kiosk-01 opened vpn.example.test', timestamp: earlier, acknowledged: false },
      ]),
    }
  }
  if (p === '/api/v1/alerts/unacked-count') return { json: ok({ count: 2 }) }
  if (p === '/api/v1/clusters') {
    return {
      json: ok([
        { key: 'phpsessid|.intranet.example.test|demo', cookie: 'PHPSESSID', domain: '.intranet.example.test', bot_ids: [BOT_ID, bots[1].id], bot_names: ['lab-workstation-04', 'finance-kiosk-01'] },
      ]),
    }
  }
  if (p === '/api/v1/settings/global-proxy') return { json: ok(null) }
  if (p === '/api/v1/users') return { json: ok([{ id: 'u1', username: 'admin', role: 'admin', totp_enabled: false }]) }
  if (p === '/api/v1/audit') {
    return {
      json: ok([
        { id: 'au1', user_id: 'u1', username: 'admin', method: 'POST', path: '/api/v1/remote-control', action: 'remote', detail: '', ip: '192.0.2.10', status: 200, created_at: now },
      ]),
    }
  }
  if (p === '/api/v1/screenshots') {
    return { json: ok([{ ID: shotId, BotID: BOT_ID, URL: 'https://intranet.example.test/mail', Title: 'Inbox — Contoso Mail', Timestamp: now, HasImage: true }]) }
  }
  if (p.includes('/screenshots/') && p.endsWith('/image')) return { body: PLACEHOLDER, contentType: 'image/png' }
  if (p === '/api/v1/keyboard-logs') {
    return { json: ok([{ ID: 'k1', BotID: BOT_ID, URL: 'https://id.example.test/account', Title: 'Account', Keys: 'quarterly-review-notes', Field: 'textarea.notes', Timestamp: now }]) }
  }
  if (p === '/api/v1/clipboard-logs') return { json: ok([]) }
  if (p === '/api/v1/audio-sessions' || p === '/api/v1/recordings') return { json: ok([]) }
  if (p === '/api/v1/extension/targets') return { json: ok([]) }
  if (p.endsWith('/page-storage')) return { json: ok({ origins: [], captured_at: null }) }
  if (p.endsWith('/live-stream')) return { body: Buffer.from(''), contentType: 'text/event-stream' }
  return { json: ok({}) }
}

async function installMocks(page) {
  await page.route('**/*', async (route) => {
    const req = route.request()
    const url = req.url()
    const method = req.method()
    let parsed
    try { parsed = new URL(url) } catch { return route.continue() }

    if (parsed.hostname === 'www.google.com' && parsed.pathname.includes('favicons')) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: placeholderPng(16, 16) })
    }
    if (parsed.pathname.startsWith('/api/') || parsed.pathname === '/health' || parsed.pathname === '/version') {
      const res = mockApi(url, method)
      if (res.body) {
        return route.fulfill({ status: 200, contentType: res.contentType, body: res.body })
      }
      return route.fulfill({
        status: res.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(res.json),
      })
    }
    return route.continue()
  })
}

/** Browser-side rewrite so no operator hostname/email/cookie/image can remain. */
async function scrubPage(page) {
  await page.evaluate(() => {
    const allowHost = /(example\.test|localhost|127\.0\.0\.1)$/i
    const redact = (value) => {
      if (!value) return value
      let t = String(value)
      t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'operator@example.test')
      t = t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => (m.startsWith('127.') ? m : '192.0.2.10'))
      t = t.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => {
        try {
          const u = new URL(m)
          if (allowHost.test(u.hostname) || u.hostname === 'localhost') return m
        } catch { /* keep */ }
        return 'https://intranet.example.test/demo'
      })
      return t
    }
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const next = redact(node.nodeValue)
        if (next !== node.nodeValue) node.nodeValue = next
      }
      for (const child of node.childNodes) walk(child)
    }
    walk(document.body)
    document.querySelectorAll('input, textarea').forEach((el) => {
      if (el.type === 'password') {
        el.value = ''
        el.setAttribute('value', '')
      } else if (el.value) {
        el.value = redact(el.value)
      }
    })
    document.querySelectorAll('a[href]').forEach((a) => {
      try {
        const u = new URL(a.href, location.href)
        if (u.origin !== location.origin && !allowHost.test(u.hostname)) {
          a.setAttribute('href', 'https://intranet.example.test/demo')
        }
      } catch { /* ignore */ }
    })
    document.querySelectorAll('img').forEach((img) => {
      if (img.src.startsWith('data:')) return
      try {
        const u = new URL(img.src, location.href)
        if (u.origin === location.origin) return
        if (!allowHost.test(u.hostname)) img.removeAttribute('src')
      } catch { img.removeAttribute('src') }
    })
  })
}

async function waitForUrl(url, maxMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok || res.status === 404) return
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function shot(page, file, extraWait) {
  if (extraWait) await extraWait(page)
  await page.waitForTimeout(400)
  await scrubPage(page)
  await page.waitForTimeout(200)
  const out = path.join(OUT_DIR, file)
  await page.screenshot({ path: out, fullPage: false })
  const stat = fs.statSync(out)
  console.log(`[capture]   saved ${out} (${(stat.size / 1024).toFixed(1)} KB) @ ${page.url()}`)
}

async function main() {
  console.log(`[capture] base URL : ${BASE_URL}`)
  console.log(`[capture] output   : ${OUT_DIR}`)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await waitForUrl(BASE_URL)

  const chrome = process.env.PLAYWRIGHT_CHROME
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const isolatedHome = '/tmp/umbra-pw-home'
  fs.mkdirSync(isolatedHome, { recursive: true })
  const launch = {
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-crash-reporter'],
    env: { ...process.env, HOME: isolatedHome },
  }
  if (fs.existsSync(chrome)) launch.executablePath = chrome
  else launch.channel = 'chrome'
  const browser = await chromium.launch(launch)
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  await installMocks(page)

  try {
    console.log('[capture] → login')
    await page.goto(`${BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: TIMEOUT }).catch(() => {})
    await page.waitForTimeout(800)
    await shot(page, 'login.png')
    session = true

    console.log('[capture] → dashboard')
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await page.waitForSelector('text=lab-workstation-04', { timeout: TIMEOUT })
    await shot(page, 'dashboard.png')

    console.log('[capture] → endpoint cinema')
    await page.goto(`${BASE_URL}/bots/${BOT_ID}/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await page.waitForSelector('text=lab-workstation-04', { timeout: TIMEOUT })
    await page.waitForTimeout(800)
    await shot(page, 'endpoint.png')

    console.log('[capture] → alerts')
    await page.goto(`${BASE_URL}/alerts/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await page.waitForSelector('text=Watched domain visit', { timeout: TIMEOUT })
    await shot(page, 'alerts.png')

    console.log('[capture] → settings')
    await page.goto(`${BASE_URL}/settings/`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await page.waitForSelector('text=Two-factor authentication', { timeout: TIMEOUT })
    await shot(page, 'settings.png')
  } finally {
    await browser.close()
  }
  console.log('[capture] done')
}

main().catch((err) => {
  console.error('[capture] FATAL:', err)
  process.exit(1)
})
