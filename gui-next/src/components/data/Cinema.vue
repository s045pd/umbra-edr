<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bots, investigate, media } from '@/api/endpoints'
import type { AudioSession } from '@/types/api'
import Btn from '@/components/ui/Btn.vue'
import { formatDate } from '@/composables/useTime'
import { useTimeFilter } from '@/composables/useTimeFilter'
import {
  eventsAround,
  eventsOfKindUntil,
  latestAtOrBefore,
  spanOf,
  type TimelineItem,
} from '@/composables/useTimeline'
import {
  assemblePlayableWebM,
  createWaveformEngine,
  isPlayableAudio,
  shouldStopSessionFetch,
} from '@/composables/useWaveformPlayer'

interface Download {
  filename?: string
  url?: string
  state?: string
  bytesReceived?: number
  totalBytes?: number
  startTime?: string
  endTime?: string
}

const props = defineProps<{ botId: string }>()
const { startMs, endMs, isActive } = useTimeFilter()

const items = ref<TimelineItem[]>([])
const sessions = ref<AudioSession[]>([])
const downloads = ref<Download[]>([])
const loading = ref(false)
const playhead = ref(0)
const playing = ref(false)
const audioLoading = ref(false)
const playError = ref<string | null>(null)
const activeSessionId = ref<string | null>(null)
const duration = ref(0)
const currentTime = ref(0)
const truncated = ref(false)
const peaks = ref<number[]>([])
const waveCanvas = ref<HTMLCanvasElement | null>(null)

let timer: ReturnType<typeof setInterval> | null = null
let playGen = 0
let engine: ReturnType<typeof createWaveformEngine> | null = null
let raf = 0

const activeSession = computed(
  () => sessions.value.find((s) => s.session_id === activeSessionId.value) ?? null,
)

async function loadTimeline(range?: { startTime: string; endTime: string }): Promise<void> {
  const window = range ?? (isActive.value && startMs.value && endMs.value
    ? { startTime: new Date(startMs.value).toISOString(), endTime: new Date(endMs.value).toISOString() }
    : undefined)
  items.value = (await investigate.timeline(props.botId, 500, window)) ?? []
}

async function load(): Promise<void> {
  loading.value = true
  playError.value = null
  try {
    const [, takes, dl] = await Promise.all([
      loadTimeline(),
      media.audioSessions(props.botId),
      bots.field<Download[]>(props.botId, 'downloads').catch(() => [] as Download[]),
    ])
    sessions.value = takes ?? []
    downloads.value = dl ?? []
    const span = spanOf(items.value)
    const first = sessions.value[0]
    if (first) {
      const keep = activeSessionId.value
        && sessions.value.some((s) => s.session_id === activeSessionId.value)
      if (!keep) await selectSession(first.session_id)
    } else {
      playhead.value = span ? span.end : playhead.value
    }
  } finally {
    loading.value = false
  }
}

watch(() => [props.botId, startMs.value, endMs.value], () => { void load() }, { immediate: true })

const span = computed(() => {
  if (activeSession.value) {
    const start = new Date(activeSession.value.start_time).getTime()
    const end = Math.max(start + duration.value * 1000, new Date(activeSession.value.end_time).getTime())
    return { start, end }
  }
  return spanOf(items.value)
})

const shot = computed(() => latestAtOrBefore(items.value, playhead.value, 'screenshot'))
const keys = computed(() => eventsOfKindUntil(items.value, playhead.value, 'keyboard', 6))
const clips = computed(() => eventsOfKindUntil(items.value, playhead.value, 'clipboard', 4))
const nearby = computed(() => eventsAround(items.value, playhead.value, 12000))
const shotSrc = computed(() => shot.value?.screenshot_id ? media.screenshotImageURL(shot.value.screenshot_id) : '')

function downloadTime(d: Download): number {
  if (!d.startTime) return 0
  const n = Number(d.startTime)
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
  const t = new Date(d.startTime).getTime()
  return Number.isFinite(t) ? t : 0
}

const liveDownloads = computed(() => {
  const at = playhead.value
  return downloads.value.filter((d) => {
    const start = downloadTime(d)
    if (!start) return false
    const end = d.endTime ? new Date(d.endTime).getTime() : start + 60_000
    return start <= at + 5000 && end >= at - 30_000
  }).slice(0, 6)
})

function kindClass(kind: string): string {
  switch (kind) {
    case 'screenshot': return 'text-accent'
    case 'keyboard': return 'text-warn'
    case 'clipboard': return 'text-success'
    case 'alert': return 'text-danger'
    case 'nav': return 'text-fg-base'
    default: return 'text-fg-muted'
  }
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function stopRaf(): void {
  if (raf) { cancelAnimationFrame(raf); raf = 0 }
}

function drawWave(): void {
  const canvas = waveCanvas.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w <= 0 || h <= 0) return
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const bars = peaks.value
  if (!bars.length) return
  const gap = 1
  const barW = Math.max(1, w / bars.length - gap)
  const progress = duration.value > 0 ? currentTime.value / duration.value : 0
  const wave = token('--color-accent', 'oklch(83% 0.165 84)')
  const prog = token('--color-accent-strong', 'oklch(89% 0.155 88)')
  for (let i = 0; i < bars.length; i++) {
    const bh = Math.max(2, (bars[i] ?? 0) * (h - 6))
    ctx.fillStyle = i / bars.length <= progress ? prog : wave
    ctx.fillRect(i * (barW + gap), (h - bh) / 2, barW, bh)
  }
}

function tick(): void {
  if (!engine) return
  currentTime.value = engine.getCurrentTime()
  if (activeSession.value) {
    playhead.value = new Date(activeSession.value.start_time).getTime() + currentTime.value * 1000
  }
  if (duration.value > 0 && currentTime.value >= duration.value - 0.05) {
    playing.value = false
    currentTime.value = duration.value
    stopRaf()
  }
  drawWave()
  if (playing.value) raf = requestAnimationFrame(tick)
}

function stopClock(): void {
  playing.value = false
  if (timer) { clearInterval(timer); timer = null }
  if (engine) engine.pause()
  stopRaf()
}

function stop(): void {
  playGen += 1
  stopClock()
}

async function fetchChunkBytes(id: string): Promise<ArrayBuffer | null> {
  const res = await fetch(media.audioChunkURL(id), { credentials: 'same-origin' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

async function decodeSession(s: AudioSession, gen: number): Promise<void> {
  audioLoading.value = true
  playError.value = null
  const metas = (await media.audioSessionChunks(s.session_id)) ?? []
  if (gen !== playGen) return
  const bufs: ArrayBuffer[] = []
  for (const meta of metas) {
    if (gen !== playGen) return
    const buf = await fetchChunkBytes(meta.id)
    if (buf && buf.byteLength > 0) bufs.push(buf)
    try {
      if (shouldStopSessionFetch(assemblePlayableWebM(bufs))) break
    } catch { /* header not yet */ }
  }
  const assembled = assemblePlayableWebM(bufs)
  if (gen !== playGen) return
  if (!engine) engine = createWaveformEngine()
  let loaded
  try {
    loaded = await engine.load([assembled.data])
  } catch {
    const header = bufs.find(isPlayableAudio)
    if (!header) throw new Error('session audio unavailable')
    loaded = await engine.load([header])
  }
  if (gen !== playGen) return
  duration.value = loaded.duration
  peaks.value = loaded.peaks
  truncated.value = assembled.truncated
  audioLoading.value = false
  drawWave()
}

async function selectSession(id: string): Promise<void> {
  const s = sessions.value.find((row) => row.session_id === id)
  if (!s) return
  const gen = ++playGen
  stopClock()
  engine?.stop()
  activeSessionId.value = id
  currentTime.value = 0
  peaks.value = []
  duration.value = 0
  playhead.value = new Date(s.start_time).getTime()
  const pad = 5 * 60 * 1000
  await loadTimeline({
    startTime: new Date(playhead.value - pad).toISOString(),
    endTime: new Date(new Date(s.end_time).getTime() + pad).toISOString(),
  })
  if (gen !== playGen) return
  try {
    await decodeSession(s, gen)
  } catch (e) {
    if (gen !== playGen) return
    audioLoading.value = false
    playError.value = e instanceof Error ? e.message : 'playback failed'
  }
}

async function play(): Promise<void> {
  if (activeSession.value && engine && duration.value > 0) {
    await engine.play()
    playing.value = true
    tick()
    return
  }
  if (activeSession.value) {
    await selectSession(activeSession.value.session_id)
    if (engine && duration.value > 0) {
      await engine.play()
      playing.value = true
      tick()
    }
    return
  }
  if (!span.value) return
  if (playhead.value >= span.value.end) playhead.value = span.value.start
  playing.value = true
  timer = setInterval(() => {
    if (!span.value) { stop(); return }
    playhead.value = Math.min(span.value.end, playhead.value + 250)
    if (playhead.value >= span.value.end) stop()
  }, 250)
}

function onWaveClick(e: MouseEvent): void {
  const canvas = waveCanvas.value
  if (!canvas || !engine || duration.value <= 0) return
  const r = canvas.getBoundingClientRect()
  engine.seek((e.clientX - r.left) / r.width)
  currentTime.value = engine.getCurrentTime()
  if (activeSession.value) {
    playhead.value = new Date(activeSession.value.start_time).getTime() + currentTime.value * 1000
  }
  drawWave()
}

onMounted(() => {
  if (waveCanvas.value && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => drawWave())
    ro.observe(waveCanvas.value)
    onBeforeUnmount(() => ro.disconnect())
  }
})

onBeforeUnmount(() => {
  stop()
  engine?.close()
  engine = null
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2 flex-wrap">
      <Btn size="sm" variant="primary" :disabled="!span && sessions.length === 0" :loading="audioLoading" @click="playing ? stop() : play()">
        {{ playing ? 'Pause' : 'Play' }}
      </Btn>
      <select
        v-if="sessions.length"
        class="h-7 px-2 text-[11px] bg-bg-overlay border border-border-subtle text-fg-base max-w-[280px]"
        :value="activeSessionId ?? ''"
        @change="selectSession(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="s in sessions" :key="s.session_id" :value="s.session_id">
          {{ formatDate(s.start_time) }} · {{ s.chunk_count }} chunks
        </option>
      </select>
      <span class="mono text-[11px] text-fg-muted">
        {{ playhead ? formatDate(new Date(playhead).toISOString()) : '—' }}
      </span>
      <span v-if="duration" class="mono text-[11px] text-fg-faint">{{ formatClock(currentTime) }} / {{ formatClock(duration) }}</span>
      <span class="text-[11px] text-fg-faint mono ml-auto">{{ items.length }} events</span>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>
    <p v-if="playError" class="text-danger text-[11px]">{{ playError }}</p>
    <p v-else-if="truncated" class="text-[11px] text-fg-faint">Playing the first minutes of this take.</p>

    <canvas
      ref="waveCanvas"
      class="h-16 w-full rounded bg-bg-base border border-border-subtle cursor-pointer"
      @click="onWaveClick"
    />

    <input
      v-if="span"
      type="range"
      class="w-full accent-[var(--color-accent)]"
      :min="span.start"
      :max="span.end"
      :value="playhead"
      @input="playhead = Number(($event.target as HTMLInputElement).value)"
    />

    <div class="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4">
      <div class="surface overflow-hidden min-h-[240px] bg-bg-base">
        <img
          v-if="shotSrc"
          :src="shotSrc"
          alt="Screen at playhead"
          class="w-full h-full object-contain max-h-[480px]"
        />
        <div v-else class="h-[240px] grid place-items-center text-[12px] text-fg-faint">
          No screenshot at this moment.
        </div>
      </div>
      <div class="space-y-3 min-w-0">
        <div class="surface px-3 py-2">
          <div class="text-[10px] uppercase tracking-wide text-warn mb-1">Keyboard</div>
          <pre v-if="keys.length" class="mono text-[12px] whitespace-pre-wrap break-all max-h-24 overflow-auto">{{ keys.map((k) => k.text).filter(Boolean).join('') }}</pre>
          <div v-else class="text-[11px] text-fg-faint">No keystrokes yet.</div>
        </div>
        <div class="surface px-3 py-2">
          <div class="text-[10px] uppercase tracking-wide text-success mb-1">Clipboard</div>
          <div v-if="clips.length" class="space-y-1 max-h-24 overflow-auto">
            <div v-for="c in clips.slice().reverse()" :key="c.id" class="text-[12px] break-all">
              <span class="mono text-[10px] text-fg-faint mr-2">{{ formatDate(c.timestamp) }}</span>
              {{ c.text }}
            </div>
          </div>
          <div v-else class="text-[11px] text-fg-faint">No clipboard events yet.</div>
        </div>
        <div class="surface px-3 py-2">
          <div class="text-[10px] uppercase tracking-wide text-accent mb-1">Downloads</div>
          <div v-if="liveDownloads.length" class="space-y-1 max-h-24 overflow-auto">
            <div v-for="(d, i) in liveDownloads" :key="(d.filename || d.url || '') + i" class="text-[12px] truncate">
              <span class="text-fg-muted">{{ d.state || 'download' }}</span>
              {{ d.filename || d.url }}
            </div>
          </div>
          <div v-else class="text-[11px] text-fg-faint">No downloads at this moment.</div>
        </div>
      </div>
    </div>

    <div class="surface divide-y divide-border-subtle max-h-[220px] overflow-auto">
      <div v-for="ev in nearby" :key="ev.id" class="px-3 py-2">
        <div class="flex items-baseline gap-2">
          <span class="mono text-[10px] text-fg-faint">{{ formatDate(ev.timestamp) }}</span>
          <span class="text-[10px] uppercase tracking-wide" :class="kindClass(ev.kind)">{{ ev.kind }}</span>
          <span class="text-[11px] truncate text-fg-muted">{{ ev.title || ev.url }}</span>
        </div>
        <pre v-if="ev.text && ev.kind !== 'keyboard'" class="mono text-[12px] mt-1 whitespace-pre-wrap break-all">{{ ev.text }}</pre>
      </div>
      <div v-if="nearby.length === 0" class="text-center py-8 text-fg-faint text-[12px]">
        Play a take or scrub to reconstruct this session.
      </div>
    </div>
  </div>
</template>
