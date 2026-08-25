// Helpers for the Remote-control URL bar.
//
// Operators paste anything: a half-typed domain, a Windows path, a Unix
// path, a `file://` URL. We turn that into something the browser can
// actually navigate to, while staying out of the way when the input is
// already well-formed.

export type Platform = 'windows' | 'mac' | 'linux' | 'unknown'

const WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const UNC_RE = /^\\\\/
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const DOMAIN_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+(:\d+)?(\/.*)?$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/
const LOCALHOST_RE = /^localhost(:\d+)?(\/.*)?$/i

// Files Chrome will hand off to the OS / show a download dialog for
// instead of rendering inline. We don't try to be exhaustive — we just
// stop the obvious traps a user clicks into when browsing /Downloads or
// /Applications. Office formats are included because Chrome downloads
// them by default; multimedia and PDFs are NOT included because Chrome
// previews them inline.
const UNVIEWABLE_EXTS = new Set([
  // archives
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'zst', 'lz', 'lzma', 'cab',
  // installers / images
  'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'ipa', 'iso', 'img', 'vhd', 'vmdk',
  // mac bundles (treated as opaque)
  'app',
  // executables / libs
  'bin', 'dll', 'so', 'dylib', 'o', 'a', 'lib', 'class', 'jar', 'war',
  // office (browser will download by default)
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // databases
  'db', 'sqlite', 'sqlite3', 'mdb', 'accdb',
  // shells / scripts that download
  'sh', 'bat', 'cmd', 'ps1',
  // misc opaque
  'crx', 'xpi', 'wasm',
])

export function detectPlatform(ua: string | undefined | null): Platform {
  if (!ua) return 'unknown'
  if (/Windows/i.test(ua)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return 'unknown'
}

// Best-guess `file://` prefix for the bot's OS. Used as a placeholder
// hint — never silently inserted into the input.
export function fileSystemHint(platform: Platform): string {
  switch (platform) {
    case 'windows': return 'file:///C:/'
    case 'mac':     return 'file:///Users/'
    case 'linux':   return 'file:///home/'
    default:        return 'file:///'
  }
}

// Normalize whatever the operator typed into a real URL.
//
// Order matters: `C:\...` would otherwise look like the scheme `c:`,
// and `localhost:3000` would otherwise look like the scheme `localhost:`.
// We catch those special shapes before falling through to a generic
// scheme check.
//
//   1. Windows drive path (C:\...) → file:///C:/...
//   2. UNC path (\\server\share) → file://server/share
//   3. Unix absolute (/Users/..) → file:///Users/..
//   4. localhost[:port] → http://...
//   5. IPv4[:port] → http://...
//   6. already has a scheme (http, https, file, about, chrome, …) → as-is
//   7. domain.tld[/path] → https://...
//   8. fallback → return as-is (user knows what they typed)
export function normalizeURL(input: string, _platform: Platform): string {
  const v = (input ?? '').trim()
  if (!v) return v

  if (WIN_DRIVE_RE.test(v)) return 'file:///' + v.replace(/\\/g, '/')
  if (UNC_RE.test(v))       return 'file:' + v.replace(/\\/g, '/')
  if (v.startsWith('/'))    return 'file://' + v
  if (LOCALHOST_RE.test(v)) return 'http://' + v
  if (IPV4_RE.test(v))      return 'http://' + v
  if (SCHEME_RE.test(v))    return v
  if (DOMAIN_RE.test(v))    return 'https://' + v
  return v
}

// Pull the file extension off a URL, stripping query/hash. Returns ''
// when there is no extension (e.g. directory listings).
export function urlExtension(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname
    const seg = path.substring(path.lastIndexOf('/') + 1)
    const dot = seg.lastIndexOf('.')
    if (dot <= 0) return ''
    return seg.substring(dot + 1).toLowerCase()
  } catch {
    return ''
  }
}

export function isUnviewable(url: string): boolean {
  return UNVIEWABLE_EXTS.has(urlExtension(url))
}

// Step up one segment in a URL. `file:///a/b/c/`  → `file:///a/b/`.
// Returns null when there's nowhere to go (already at root, or unparsable).
export function parentURL(current: string): string | null {
  try {
    const u = new URL(current)
    if (u.protocol === 'file:') {
      let p = u.pathname.replace(/\/+$/, '')
      const idx = p.lastIndexOf('/')
      if (idx < 0) return null
      const next = p.substring(0, idx + 1) || '/'
      if (next === u.pathname) return null
      return u.protocol + '//' + (u.host || '') + next
    }
    if (u.pathname && u.pathname !== '/') {
      let p = u.pathname.replace(/\/+$/, '')
      const idx = p.lastIndexOf('/')
      const next = idx <= 0 ? '/' : p.substring(0, idx + 1)
      return u.origin + next
    }
    return null
  } catch {
    return null
  }
}

export interface DirEntry {
  name: string
  url: string
  size: string
  mtime: string
  isDir: boolean
  unviewable: boolean
}

// Decide whether the captured page is a Chrome-style directory listing.
// Used so we can render it as a native file browser (clickable, themed)
// instead of stuffing it into a sandboxed iframe — the latter swallows
// link clicks because Chrome blocks file:// navigation from a null
// origin.
export function looksLikeDirIndex(url: string | undefined, html: string): boolean {
  if (!url || !html) return false
  if (!url.startsWith('file:')) return false
  // Chrome's listing always carries the addRow() helper script and a
  // populated <table>. Requiring both keeps regular file:// HTML pages
  // (which may also have tables and links) from being mis-detected.
  if (!/addRow\s*\(/i.test(html)) return false
  return /<table\b[\s\S]*<a\b[^>]*href=/i.test(html)
}

// Map a binary preview URL or content-type to a coarse media kind so
// the GUI can pick the right renderer (<img>, <embed>, <video>, …).
export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | null

export function previewKind(
  url: string,
  contentType?: string | null,
): PreviewKind {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct === 'application/pdf') return 'pdf'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'

  const ext = urlExtension(url)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) return 'audio'
  return null
}

// Pull file/directory entries out of a Chrome directory-index HTML
// document. Returns null when the HTML doesn't look like one.
export function parseDirIndex(html: string, baseUrl: string): DirEntry[] | null {
  if (!html) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[]
  if (anchors.length === 0) return null

  const entries: DirEntry[] = []
  const seen = new Set<string>()
  for (const a of anchors) {
    const rawHref = a.getAttribute('href') ?? ''
    if (!rawHref) continue

    let href: string
    try {
      href = new URL(rawHref, baseUrl).toString()
    } catch {
      continue
    }
    // Skip the parent-directory link only if it points at the same
    // place we're currently looking at. We render an explicit "Up"
    // button in our own UI.
    if (href === baseUrl) continue
    if (seen.has(href)) continue
    seen.add(href)

    const name = (a.textContent ?? '').trim() || rawHref
    const isDir = name.endsWith('/') || rawHref.endsWith('/')

    let size = ''
    let mtime = ''
    const tr = a.closest('tr')
    if (tr) {
      const cells = tr.querySelectorAll('td')
      if (cells.length >= 3) {
        size = (cells[1].textContent ?? '').trim()
        mtime = (cells[2].textContent ?? '').trim()
      }
    }

    entries.push({
      name,
      url: href,
      size,
      mtime,
      isDir,
      unviewable: !isDir && isUnviewable(href),
    })
  }

  if (entries.length === 0) return null

  // Directories first, then alphabetical — matches what operators
  // expect from a normal file manager.
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

// Inject a <base href="..."> + a click-trap script into the rendered
// HTML, so links inside the sandboxed iframe become postMessage events
// instead of hard-navigating the iframe to a path the host can't reach.
//
// `allow-scripts` (without `allow-same-origin`) is required on the
// iframe for the trap to run; the iframe stays in a null origin so it
// still can't read the parent's cookies, storage or DOM.
export function instrumentRenderedHTML(html: string, baseUrl: string): string {
  if (!html) return html
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }
  if (!doc?.documentElement) return html

  // Make sure there is a <head> we can prepend to.
  let head = doc.head
  if (!head) {
    head = doc.createElement('head')
    doc.documentElement.insertBefore(head, doc.documentElement.firstChild)
  }

  // Strip <meta http-equiv="Content-Security-Policy"> — pages we render
  // here may forbid inline scripts, which would silently disable the
  // click trap and leave the iframe looking dead.
  head.querySelectorAll('meta[http-equiv]').forEach((m) => {
    if ((m.getAttribute('http-equiv') ?? '').toLowerCase() === 'content-security-policy') {
      m.parentNode?.removeChild(m)
    }
  })

  // 1. <base> so relative hrefs resolve against the bot's location, not
  //    the operator's GUI origin.
  if (baseUrl) {
    const existing = head.querySelector('base')
    if (existing) existing.setAttribute('href', baseUrl)
    else {
      const base = doc.createElement('base')
      base.setAttribute('href', baseUrl)
      head.insertBefore(base, head.firstChild)
    }
  }

  // 2. Click trap. Walks up from the click target until it finds an <a>,
  //    then bubbles its resolved href out to the parent. Forms are
  //    blocked entirely — we don't want a stray submit to leak data to a
  //    server.
  const trap = doc.createElement('script')
  trap.textContent = `
    (function () {
      function up(n) {
        while (n && n.nodeType === 1 && n.tagName !== 'A') n = n.parentNode;
        return n && n.tagName === 'A' ? n : null;
      }
      document.addEventListener('click', function (e) {
        var a = up(e.target);
        if (!a) return;
        var href = a.href;
        if (!href) return;
        e.preventDefault();
        e.stopPropagation();
        try { parent.postMessage({ type: 'cc-remote-nav', url: href }, '*'); } catch (_) {}
      }, true);
      document.addEventListener('submit', function (e) {
        e.preventDefault();
        e.stopPropagation();
      }, true);
    })();
  `
  ;(doc.body || doc.documentElement).appendChild(trap)

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}
