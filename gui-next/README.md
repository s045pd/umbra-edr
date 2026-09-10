# umbra-gui

Modern rewrite of the Umbra admin panel.

## Stack

- **Vite 6** — fast dev server, ESM-native build
- **Vue 3.5** — Composition API + `<script setup>` + TypeScript
- **Pinia** — state management
- **Tailwind CSS v4** — design tokens + utility-first styling
- **VueUse / wavesurfer.js / ECharts** — supporting libs

## Layout

```
src/
├── api/             # fetch wrapper + endpoint declarations
├── stores/          # auth, bots
├── pages/           # Login / Dashboard / BotDetail / Alerts / Settings / Audit
├── layouts/         # AppShell
├── components/
│   ├── ui/          # Btn, Field, Drawer, StatusDot
│   ├── bot/         # BotRow
│   └── data/        # Tabs, History, Cookies, Bookmarks, Downloads,
│                    # Screenshots, Keyboard, Clipboard, PageStorage, Audio, Cinema,
                     # Activity, Remote, Config
├── composables/     # useTime, useClipboard
├── types/           # api.ts (single source of truth for response shapes)
├── router/
└── assets/          # design tokens + global styles
```

Total: 2.7k LOC across 32 files (replaces 4k LOC monolith in `gui/`).

## Design

Single-accent dark theme (Linear/Datadog inspired). High data density,
tabular-numeric monospace for IDs and timestamps, subtle borders,
single accent color for emphasis. Light theme available via `html.light`.

All colors live in `src/assets/styles.css` as `@theme` tokens — no hex
literals scattered through templates.

## Commands

```bash
npm install
npm run dev          # dev server on :5173, proxies /api → localhost:8118
                     # Override target via VITE_API_TARGET=http://your-host:8118
npm run typecheck    # vue-tsc
npm run build        # writes to ./dist (Compose mounts this as GUI_DIST_PATH)
```

## Routes

| Route | Component |
|---|---|
| `/login` | Login |
| `/` | Dashboard (bot list + filters + bulk actions) |
| `/bots/:id` | BotDetail (Cinema + telemetry tabs) |
| `/alerts` | Domain-visit detections |
| `/settings` | Password, TOTP, operators, policy pack, CA, extension packaging |
| `/audit` | Mutating API log (admin) |

## Bot detail tabs

1. **Cinema** — time-aligned nav / screenshot / keystroke / audio playhead
2. **Tabs** — open browser tabs with favicon + active marker
3. **History** — chronological with visit counts + filter
4. **Cookies** — searchable, copy as JSON or Netscape format
5. **Bookmarks** — link-out
6. **Downloads** — filename + state + size
7. **Screenshots** — grouped by day, lightbox preview
8. **Keyboard** — search with highlight, time range
9. **Clipboard** — copy/cut events
10. **Storage** — origin localStorage / sessionStorage
11. **Audio** — start/stop recording, wavesurfer playback per session
12. **Remote control** — push the bot to a URL
13. **Config** — edit name, proxy creds, telemetry switches

## Compared to old `gui/`

| | Old `gui/` (Vue 2) | New `gui-next/` (Vue 3) |
|---|---|---|
| LOC | 4086 | 2749 |
| Files | 19 | 32 (smaller, focused) |
| Largest file | Main.vue 923 | BotDetail.vue 230 |
| Build tool | Vue CLI 4 (slow) | Vite 5 (fast) |
| Types | none (JS) | TypeScript strict |
| State | mixed `data()` + props | Pinia store |
| Modal renders | Bootstrap-Vue (broken backdrop, raw JSON overflow) | dedicated route + page |
| Theme | Bootstrap defaults | design tokens, dark/light toggle |
| Bundle gz | ~250 KB | 104 KB main + lazy chunks |
