<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bots, media } from '@/api/endpoints'
import type { AudioSession, BotSummary } from '@/types/api'
import { useTimeFilter } from '@/composables/useTimeFilter'
import Btn from '@/components/ui/Btn.vue'
import { formatDate } from '@/composables/useTime'
import AudioSpectrum from '@/components/data/AudioSpectrum.vue'

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
const audioEl = ref<HTMLAudioElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastAutoplayId = ''

const recordingOn = computed(() => Boolean(props.bot.switch_config?.PERSISTENT_RECORDING))

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

function stopPlayback(): void {
  if (audioEl.value) {
    audioEl.value.pause()
    audioEl.value.removeAttribute('src')
    audioEl.value.load()
  }
  playing.value = null
  audioLoading.value = false
  playError.value = null
}

async function play(s: AudioSession, fromAutoplay = false): Promise<void> {
  if (!fromAutoplay && playing.value === s.session_id) {
    stopPlayback()
    return
  }
  stopPlayback()
  playing.value = s.session_id
  audioLoading.value = true
  if (!audioEl.value) {
    audioLoading.value = false
    return
  }
  audioEl.value.src = `${media.audioSessionURL(s.session_id)}?v=${s.chunk_count}`
  try {
    await audioEl.value.play()
    audioLoading.value = false
  } catch (e) {
    audioLoading.value = false
    playError.value = e instanceof Error ? e.message : 'playback failed'
    playing.value = null
  }
}

function onAudioEnded(): void {
  playing.value = null
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
  <div class="space-y-3">
    <div class="surface px-3 py-3 flex items-center gap-3">
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
              ? 'On — Sensor records when the browser already has microphone access, and re-checks on a timer. No prompt is shown.'
              : 'Off — Sensor stops recording on the next check.' }}
          </div>
        </div>
      </label>
      <label class="ml-auto flex items-center gap-2 text-[11px] text-fg-muted cursor-pointer shrink-0">
        <input type="checkbox" :checked="autoplay" @change="toggleAutoplay" />
        Autoplay latest
      </label>
      <span class="text-[11px] text-fg-faint mono">{{ timeFilteredSessions.length }} sessions</span>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>
    <p v-if="toggleError" class="text-danger text-[11px] mono break-words">{{ toggleError }}</p>

    <div class="surface overflow-hidden">
      <audio
        ref="audioEl"
        class="hidden"
        preload="auto"
        @ended="onAudioEnded"
        @error="playError = 'This clip could not be decoded.'"
      />
      <AudioSpectrum :audio-el="audioEl" :active="Boolean(playing)" />
      <div class="px-3 py-2 flex items-center gap-2 border-t border-border-subtle">
        <span class="text-[11px] mono text-fg-faint truncate">
          {{ playing ? `Playing ${playing}` : 'Select a session' }}
        </span>
        <span v-if="audioLoading" class="text-[11px] text-fg-faint">Loading…</span>
        <a
          v-if="playing"
          :href="media.audioSessionURL(playing)"
          download
          class="ml-auto text-[11px] text-fg-muted hover:text-accent"
        >download</a>
      </div>
      <p v-if="playError" class="px-3 pb-2 text-danger text-[11px] mono break-words">{{ playError }}</p>
    </div>

    <div class="surface divide-y divide-border-subtle">
      <div
        v-for="s in pagedSessions"
        :key="s.session_id"
        class="px-3 py-2 hover:bg-bg-hover/60"
      >
        <div class="flex items-center gap-3">
          <button
            class="size-8 grid place-items-center rounded bg-accent-soft text-accent border border-accent/30 hover:bg-accent/20"
            :aria-label="playing === s.session_id ? 'Pause' : 'Play'"
            @click="play(s)"
          >
            <span v-if="playing === s.session_id">▮▮</span>
            <span v-else>▶</span>
          </button>
          <div class="flex-1 min-w-0">
            <div class="text-[12px] truncate">{{ formatDate(s.start_time) }}</div>
            <div class="text-[10px] text-fg-faint mono">
              {{ durationLabel(s) }} · {{ s.chunk_count }} chunks
            </div>
          </div>
          <Btn
            size="sm"
            variant="ghost"
            :loading="transcribing === s.session_id"
            @click="transcribe(s)"
          >Transcribe</Btn>
          <a
            :href="media.audioSessionURL(s.session_id)"
            download
            class="text-[11px] text-fg-muted hover:text-accent"
          >download</a>
        </div>
        <p v-if="s.transcript" class="mt-1.5 pl-11 text-[12px] text-fg-muted leading-snug">
          {{ s.transcript }}
        </p>
      </div>
      <div v-if="!loading && timeFilteredSessions.length === 0" class="text-center py-10 text-fg-faint text-[12px]">
        No audio sessions yet. Turn on endpoint recording after the browser already has microphone access.
      </div>
    </div>

    <div v-if="audioTotalPages > 1" class="flex items-center justify-center gap-2 py-1">
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="audioPage === 0"
        @click="audioPage = 0"
      >&laquo;</button>
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="audioPage === 0"
        @click="audioPage--"
      >&lsaquo;</button>
      <span class="text-[11px] mono text-fg-faint px-2">
        {{ audioRangeLabel() }} of {{ timeFilteredSessions.length }}
      </span>
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="audioPage >= audioTotalPages - 1"
        @click="audioPage++"
      >&rsaquo;</button>
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="audioPage >= audioTotalPages - 1"
        @click="audioPage = audioTotalPages - 1"
      >&raquo;</button>
    </div>
  </div>
</template>
