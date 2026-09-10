<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import WaveSurfer from 'wavesurfer.js'
import { bots, media } from '@/api/endpoints'
import type { AudioSession, BotSummary } from '@/types/api'
import { useTimeFilter } from '@/composables/useTimeFilter'
import Btn from '@/components/ui/Btn.vue'
import { formatDate } from '@/composables/useTime'
import { isWebM } from '@/composables/useWaveformPlayer'

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
const waveHost = ref<HTMLDivElement | null>(null)

let pollTimer: ReturnType<typeof setInterval> | null = null
let lastAutoplayId = ''
let wavesurfer: WaveSurfer | null = null

const recordingOn = computed(() => Boolean(props.bot.switch_config?.PERSISTENT_RECORDING))
const activeSession = computed(() => sessions.value.find((s) => s.session_id === playing.value) ?? null)

const timeFilteredSessions = computed(() =>
  sessions.value.filter((s) => timeInRange(new Date(s.start_time).getTime())),
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

function destroyPlayer(): void {
  if (wavesurfer) {
    wavesurfer.destroy()
    wavesurfer = null
  }
  isPlaying.value = false
  currentTime.value = 0
  duration.value = 0
}

function stopPlayback(): void {
  destroyPlayer()
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

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

async function play(s: AudioSession, fromAutoplay = false): Promise<void> {
  if (!fromAutoplay && playing.value === s.session_id) {
    if (wavesurfer) {
      await wavesurfer.playPause()
      return
    }
    stopPlayback()
    return
  }
  stopPlayback()
  playing.value = s.session_id
  audioLoading.value = true
  try {
    const metas = (await media.audioSessionChunks(s.session_id)) ?? []
    const bufs: ArrayBuffer[] = []
    for (const meta of metas) {
      const buf = await fetchChunkBytes(meta.id)
      if (buf && buf.byteLength > 0) bufs.push(buf)
    }
    const header = bufs.findIndex(isWebM)
    if (header < 0) {
      throw new Error('session audio unavailable — the WebM header for this take is missing from disk')
    }
    const blob = new Blob(
      bufs.slice(header).map((b) => new Uint8Array(b)),
      { type: 'audio/webm; codecs=opus' },
    )
    if (!waveHost.value) throw new Error('waveform host missing')
    const ws = WaveSurfer.create({
      container: waveHost.value,
      height: 128,
      barWidth: 2,
      barGap: 1,
      barRadius: 0,
      cursorWidth: 1,
      normalize: true,
      dragToSeek: true,
      backend: 'WebAudio',
      blobMimeType: 'audio/webm',
      waveColor: token('--color-accent', 'oklch(83% 0.165 84)'),
      progressColor: token('--color-accent-strong', 'oklch(89% 0.155 88)'),
      cursorColor: token('--color-fg-base', 'oklch(96% 0.005 90)'),
    })
    wavesurfer = ws
    ws.on('timeupdate', (t) => { currentTime.value = t })
    ws.on('ready', (d) => { duration.value = d })
    ws.on('play', () => { isPlaying.value = true })
    ws.on('pause', () => { isPlaying.value = false })
    ws.on('finish', () => { isPlaying.value = false })
    try {
      await ws.loadBlob(blob)
    } catch {
      await ws.loadBlob(new Blob([bufs[header]], { type: 'audio/webm; codecs=opus' }))
    }
    audioLoading.value = false
    await ws.play()
  } catch (e) {
    audioLoading.value = false
    playError.value = e instanceof Error ? e.message : 'playback failed'
    playing.value = null
    destroyPlayer()
  }
}

function toggleAutoplay(): void {
  autoplay.value = !autoplay.value
  localStorage.setItem('umbra-audio-autoplay', autoplay.value ? '1' : '0')
  if (autoplay.value && timeFilteredSessions.value[0]) {
    void play(timeFilteredSessions.value[0], true)
  }
}

async function transcribe(s: AudioSession): Promise<void> {
  transcribing.value = s.session_id
  playError.value = null
  try {
    const out = await media.transcribeSession(s.session_id)
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
})
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  stopPlayback()
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
        <div
          ref="waveHost"
          class="h-32 rounded bg-bg-base border border-border-subtle"
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
