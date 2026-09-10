<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bots, media } from '@/api/endpoints'
import type { AudioSession, BotSummary } from '@/types/api'
import { useTimeFilter } from '@/composables/useTimeFilter'
import Btn from '@/components/ui/Btn.vue'
import { formatDate } from '@/composables/useTime'
import {
  assemblePlayableWebM,
  createWaveformEngine,
  encodeWav16k,
  isPlayableAudio,
  shouldStopSessionFetch,
  type WaveformEngine,
} from '@/composables/useWaveformPlayer'

const props = defineProps<{ bot: BotSummary }>()
const emit = defineEmits<{ saved: [] }>()
const { inRange: timeInRange } = useTimeFilter()

const sessions = ref<AudioSession[]>([])
const loading = ref(false)
const playing = ref<string | null>(null)
const audioLoading = ref(false)
const playError = ref<string | null>(null)
const toggleError = ref<string | null>(null)
const toggling = ref(false)
const transcribing = ref<string | null>(null)
const autoplay = ref(localStorage.getItem('umbra-audio-autoplay') === '1')
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const truncated = ref(false)
const waveCanvas = ref<HTMLCanvasElement | null>(null)
const peaks = ref<number[]>([])

let pollTimer: ReturnType<typeof setInterval> | null = null
let lastAutoplayId = ''
let playGen = 0
let engine: WaveformEngine | null = null
let raf = 0

const recordingOn = computed(() => Boolean(props.bot.switch_config?.PERSISTENT_RECORDING))
const activeSession = computed(() => sessions.value.find((s) => s.session_id === playing.value) ?? null)

const inRangeSessions = computed(() =>
  sessions.value.filter((s) => timeInRange(new Date(s.start_time).getTime())),
)
const showingOutsideRange = computed(
  () => inRangeSessions.value.length === 0 && sessions.value.length > 0,
)
const timeFilteredSessions = computed(() =>
  showingOutsideRange.value ? sessions.value : inRangeSessions.value,
)

const audioPage = ref(0)
const audioPageSize = 20
const audioTotalPages = computed(() => Math.max(1, Math.ceil(timeFilteredSessions.value.length / audioPageSize)))
const pagedSessions = computed(() => {
  const start = audioPage.value * audioPageSize
  return timeFilteredSessions.value.slice(start, start + audioPageSize)
})
watch(() => timeFilteredSessions.value.length, () => { audioPage.value = 0 })

function audioRangeLabel(): string {
  const start = audioPage.value * audioPageSize + 1
  const end = Math.min((audioPage.value + 1) * audioPageSize, timeFilteredSessions.value.length)
  return `${start}-${end}`
}

function durationLabel(s: AudioSession): string {
  const a = new Date(s.start_time).getTime()
  const b = new Date(s.end_time).getTime()
  const sec = Math.max(0, Math.round((b - a) / 1000) + 10)
  const m = Math.floor(sec / 60)
  const r = sec % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

async function load(): Promise<void> {
  loading.value = true
  try {
    sessions.value = (await media.audioSessions(props.bot.id)) ?? []
  } finally {
    loading.value = false
  }
}

async function setRecording(on: boolean): Promise<void> {
  toggling.value = true
  toggleError.value = null
  try {
    await bots.update(props.bot.id, {
      switch_config: { ...(props.bot.switch_config ?? {}), PERSISTENT_RECORDING: on },
    })
    emit('saved')
  } catch (e) {
    toggleError.value = e instanceof Error ? e.message : 'failed to update recording switch'
  } finally {
    toggling.value = false
  }
}

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function stopRaf(): void {
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}

function drawWave(): void {
  const canvas = waveCanvas.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w <= 0 || h <= 0) return
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const bars = peaks.value
  if (bars.length === 0) return
  const gap = 1
  const barW = Math.max(1, w / bars.length - gap)
  const progress = duration.value > 0 ? currentTime.value / duration.value : 0
  const wave = token('--color-accent', 'oklch(83% 0.165 84)')
  const prog = token('--color-accent-strong', 'oklch(89% 0.155 88)')
  for (let i = 0; i < bars.length; i++) {
    const bh = Math.max(2, (bars[i] ?? 0) * (h - 8))
    ctx.fillStyle = i / bars.length <= progress ? prog : wave
    ctx.fillRect(i * (barW + gap), (h - bh) / 2, barW, bh)
  }
}

function tick(): void {
  if (!engine) return
  currentTime.value = engine.getCurrentTime()
  const dur = engine.getDuration()
  if (dur > 0 && currentTime.value >= dur - 0.05) {
    isPlaying.value = false
    currentTime.value = dur
    stopRaf()
  }
  drawWave()
  if (isPlaying.value) raf = requestAnimationFrame(tick)
}

function resetVisual(): void {
  stopRaf()
  engine?.stop()
  isPlaying.value = false
  currentTime.value = 0
  duration.value = 0
  truncated.value = false
  peaks.value = []
}

function stopPlayback(): void {
  playGen += 1
  resetVisual()
  playing.value = null
  audioLoading.value = false
  playError.value = null
}

async function fetchChunkBytes(id: string): Promise<ArrayBuffer | null> {
  const res = await fetch(media.audioChunkURL(id), { credentials: 'same-origin' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => { window.clearTimeout(t); resolve(v) },
      (e) => { window.clearTimeout(t); reject(e) },
    )
  })
}

function onWaveClick(e: MouseEvent): void {
  const canvas = waveCanvas.value
  if (!canvas || !engine || duration.value <= 0) return
  const r = canvas.getBoundingClientRect()
  engine.seek((e.clientX - r.left) / r.width)
  currentTime.value = engine.getCurrentTime()
  drawWave()
}

async function play(s: AudioSession, fromAutoplay = false): Promise<void> {
  if (!fromAutoplay && playing.value === s.session_id && engine && duration.value > 0) {
    if (isPlaying.value) {
      engine.pause()
      isPlaying.value = false
      stopRaf()
      drawWave()
      return
    }
    await engine.play()
    isPlaying.value = true
    tick()
    return
  }
  const gen = ++playGen
  resetVisual()
  playError.value = null
  playing.value = s.session_id
  audioLoading.value = true
  try {
    const metas = (await media.audioSessionChunks(s.session_id)) ?? []
    if (gen !== playGen) return
    const bufs: ArrayBuffer[] = []
    let reachedCap = false
    for (const meta of metas) {
      if (gen !== playGen) return
      const buf = await fetchChunkBytes(meta.id)
      if (buf && buf.byteLength > 0) bufs.push(buf)
      try {
        const preview = assemblePlayableWebM(bufs)
        if (shouldStopSessionFetch(preview)) {
          reachedCap = true
          break
        }
      } catch {
        // header not in the bytes we have yet
      }
    }
    const assembled = assemblePlayableWebM(bufs)
    if (gen !== playGen) return
    if (!engine) engine = createWaveformEngine()
    let loaded: { duration: number; peaks: number[] }
    let headerOnly = false
    try {
      loaded = await withTimeout(engine.load([assembled.data]), 20000, 'waveform decode timed out')
    } catch {
      const header = bufs.find(isPlayableAudio)
      if (!header) throw new Error('waveform decode timed out')
      loaded = await withTimeout(engine.load([header]), 12000, 'waveform decode timed out')
      headerOnly = true
    }
    if (gen !== playGen) return
    duration.value = loaded.duration
    peaks.value = loaded.peaks
    truncated.value = assembled.truncated || reachedCap || headerOnly
    audioLoading.value = false
    drawWave()
    await engine.play()
    if (gen !== playGen) {
      engine.stop()
      return
    }
    isPlaying.value = true
    tick()
  } catch (e) {
    if (gen !== playGen) return
    audioLoading.value = false
    playError.value = e instanceof Error ? e.message : 'playback failed'
    playing.value = null
    resetVisual()
  }
}

function toggleAutoplay(): void {
  autoplay.value = !autoplay.value
  localStorage.setItem('umbra-audio-autoplay', autoplay.value ? '1' : '0')
  if (autoplay.value && timeFilteredSessions.value[0]) {
    void play(timeFilteredSessions.value[0], true)
  }
}

async function wavForSession(s: AudioSession): Promise<Blob | undefined> {
  const loadedBuf = playing.value === s.session_id ? engine?.getAudioBuffer() : null
  if (loadedBuf) {
    return new Blob([encodeWav16k(loadedBuf)], { type: 'audio/wav' })
  }
  const metas = (await media.audioSessionChunks(s.session_id)) ?? []
  const bufs: ArrayBuffer[] = []
  for (const meta of metas) {
    const buf = await fetchChunkBytes(meta.id)
    if (buf && buf.byteLength > 0) bufs.push(buf)
    try {
      if (shouldStopSessionFetch(assemblePlayableWebM(bufs))) break
    } catch { /* header not yet */ }
  }
  const assembled = assemblePlayableWebM(bufs)
  if (!engine) engine = createWaveformEngine()
  const loaded = await engine.load([assembled.data])
  duration.value = loaded.duration
  peaks.value = loaded.peaks
  const pcm = engine.getAudioBuffer()
  if (!pcm) return undefined
  return new Blob([encodeWav16k(pcm)], { type: 'audio/wav' })
}

async function transcribe(s: AudioSession): Promise<void> {
  transcribing.value = s.session_id
  playError.value = null
  try {
    const wav = await wavForSession(s)
    const out = await media.transcribeSession(s.session_id, wav)
    sessions.value = sessions.value.map((row) =>
      row.session_id === s.session_id ? { ...row, transcript: out.transcript } : row,
    )
  } catch (e) {
    playError.value = e instanceof Error ? e.message : 'transcription failed'
  } finally {
    transcribing.value = null
  }
}

watch(
  () => timeFilteredSessions.value[0]?.session_id,
  (id) => {
    if (!autoplay.value || !id || id === lastAutoplayId) return
    lastAutoplayId = id
    const latest = timeFilteredSessions.value[0]
    if (latest) void play(latest, true)
  },
)

watch(() => props.bot.id, () => {
  lastAutoplayId = ''
  stopPlayback()
  void load()
})

onMounted(() => {
  void load()
  pollTimer = setInterval(() => { void load() }, 8000)
  if (waveCanvas.value && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => drawWave())
    ro.observe(waveCanvas.value)
    onBeforeUnmount(() => ro.disconnect())
  }
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  stopPlayback()
  engine?.close()
  engine = null
})
</script>

<template>
  <div class="space-y-4">
    <div class="surface px-4 py-3 flex items-center gap-3">
      <label class="flex items-center gap-3 cursor-pointer min-w-0">
        <div class="relative shrink-0">
          <input
            type="checkbox"
            class="sr-only peer"
            :checked="recordingOn"
            :disabled="toggling"
            @change="(e) => setRecording((e.target as HTMLInputElement).checked)"
          />
          <div class="w-9 h-5 rounded-full bg-bg-overlay border border-border-subtle peer-checked:bg-accent peer-checked:border-accent transition-colors" />
          <div class="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
        </div>
        <div class="min-w-0">
          <div class="text-[12px] font-medium">Endpoint recording</div>
          <div class="text-[10px] text-fg-faint">
            {{ recordingOn
              ? 'On — records when the browser already has microphone access.'
              : 'Off — Sensor stops on the next check.' }}
          </div>
        </div>
      </label>
      <label class="ml-auto flex items-center gap-2 text-[11px] text-fg-muted cursor-pointer shrink-0">
        <input type="checkbox" :checked="autoplay" @change="toggleAutoplay" />
        Autoplay
      </label>
      <span class="text-[11px] text-fg-faint mono">{{ timeFilteredSessions.length }}</span>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>
    <p v-if="toggleError" class="text-danger text-[11px] mono break-words">{{ toggleError }}</p>
    <p v-if="showingOutsideRange" class="text-[11px] text-fg-muted">
      No takes in the selected day — showing {{ sessions.length }} historical recording{{ sessions.length === 1 ? '' : 's' }}.
    </p>

    <div class="surface overflow-hidden">
      <div class="px-4 pt-3 pb-1 flex items-baseline justify-between gap-3">
        <div class="min-w-0">
          <div class="text-[12px] font-medium truncate">
            {{ activeSession ? formatDate(activeSession.start_time) : 'No session selected' }}
          </div>
          <div class="text-[10px] text-fg-faint mono">
            {{ activeSession ? `${durationLabel(activeSession)} · ${activeSession.chunk_count} chunks · Opus 96k` : 'Pick a take below' }}
          </div>
        </div>
        <div class="text-[11px] mono text-fg-muted">
          {{ formatClock(currentTime) }} / {{ formatClock(duration) }}
        </div>
      </div>
      <div class="relative mx-3 mb-2">
        <canvas
          ref="waveCanvas"
          class="h-32 w-full rounded bg-bg-base border border-border-subtle cursor-pointer"
          @click="onWaveClick"
        />
        <div
          v-if="!playing && !audioLoading"
          class="absolute inset-0 grid place-items-center text-[11px] text-fg-faint pointer-events-none"
        >
          Select a session to render the waveform
        </div>
      </div>
      <div class="px-4 pb-3 flex items-center gap-2">
        <Btn
          size="sm"
          variant="primary"
          :disabled="!playing && !audioLoading"
          :loading="audioLoading"
          @click="activeSession && play(activeSession)"
        >
          {{ isPlaying ? 'Pause' : 'Play' }}
        </Btn>
        <a
          v-if="playing"
          :href="media.audioSessionURL(playing)"
          download
          class="text-[11px] text-fg-muted hover:text-accent"
        >download</a>
        <span v-if="audioLoading" class="text-[11px] text-fg-faint">Decoding waveform…</span>
        <span v-else-if="truncated" class="text-[11px] text-fg-faint">First minutes of this take</span>
      </div>
      <p v-if="playError" class="px-4 pb-3 text-danger text-[11px] leading-snug">{{ playError }}</p>
      <p v-if="activeSession?.transcript" class="px-4 pb-3 text-[12px] text-fg-muted leading-snug border-t border-border-subtle pt-3">
        {{ activeSession.transcript }}
      </p>
    </div>

    <div class="surface divide-y divide-border-subtle">
      <button
        v-for="s in pagedSessions"
        :key="s.session_id"
        type="button"
        class="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-bg-hover/60"
        :class="playing === s.session_id ? 'bg-accent/10' : ''"
        @click="play(s)"
      >
        <span
          class="size-8 grid place-items-center rounded border text-accent"
          :class="playing === s.session_id ? 'bg-accent text-bg-base border-accent' : 'bg-accent-soft border-accent/30'"
        >
          <span v-if="playing === s.session_id && isPlaying">▮▮</span>
          <span v-else>▶</span>
        </span>
        <div class="flex-1 min-w-0">
          <div class="text-[12px] truncate">{{ formatDate(s.start_time) }}</div>
          <div class="text-[10px] text-fg-faint mono">{{ durationLabel(s) }} · {{ s.chunk_count }} chunks</div>
        </div>
        <Btn
          size="sm"
          variant="ghost"
          :loading="transcribing === s.session_id"
          @click.stop="transcribe(s)"
        >Transcribe</Btn>
      </button>
      <div v-if="!loading && timeFilteredSessions.length === 0" class="text-center py-10 text-fg-faint text-[12px]">
        No audio sessions yet.
      </div>
    </div>

    <div v-if="audioTotalPages > 1" class="flex items-center justify-center gap-2 py-1">
      <button class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay text-fg-faint disabled:opacity-30" :disabled="audioPage === 0" @click="audioPage = 0">&laquo;</button>
      <button class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay text-fg-faint disabled:opacity-30" :disabled="audioPage === 0" @click="audioPage--">&lsaquo;</button>
      <span class="text-[11px] mono text-fg-faint px-2">{{ audioRangeLabel() }} of {{ timeFilteredSessions.length }}</span>
      <button class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay text-fg-faint disabled:opacity-30" :disabled="audioPage >= audioTotalPages - 1" @click="audioPage++">&rsaquo;</button>
      <button class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay text-fg-faint disabled:opacity-30" :disabled="audioPage >= audioTotalPages - 1" @click="audioPage = audioTotalPages - 1">&raquo;</button>
    </div>
  </div>
</template>
