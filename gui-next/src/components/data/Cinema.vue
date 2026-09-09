<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { investigate } from '@/api/endpoints'
import { media } from '@/api/endpoints'
import Btn from '@/components/ui/Btn.vue'
import { formatDate } from '@/composables/useTime'
import { useTimeFilter } from '@/composables/useTimeFilter'
import {
  eventsAround,
  nearestOfKind,
  spanOf,
  type TimelineItem,
} from '@/composables/useTimeline'

const props = defineProps<{ botId: string }>()
const { startMs, endMs, isActive } = useTimeFilter()

const items = ref<TimelineItem[]>([])
const loading = ref(false)
const playhead = ref(0)
const playing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function load(): Promise<void> {
  loading.value = true
  try {
    const range = isActive.value && startMs.value && endMs.value
      ? { startTime: new Date(startMs.value).toISOString(), endTime: new Date(endMs.value).toISOString() }
      : undefined
    items.value = (await investigate.timeline(props.botId, 400, range)) ?? []
    const span = spanOf(items.value)
    playhead.value = span ? span.end : 0
  } finally {
    loading.value = false
  }
}

watch(() => [props.botId, startMs.value, endMs.value], load, { immediate: true })

const span = computed(() => spanOf(items.value))
const shot = computed(() => nearestOfKind(items.value, playhead.value, 'screenshot'))
const nearby = computed(() => eventsAround(items.value, playhead.value, 8000))
const shotSrc = computed(() => shot.value?.screenshot_id ? media.screenshotImageURL(shot.value.screenshot_id) : '')

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

function stop(): void {
  playing.value = false
  if (timer) { clearInterval(timer); timer = null }
}

function play(): void {
  if (!span.value) return
  if (playhead.value >= span.value.end) playhead.value = span.value.start
  playing.value = true
  timer = setInterval(() => {
    if (!span.value) { stop(); return }
    playhead.value = Math.min(span.value.end, playhead.value + 1000)
    if (playhead.value >= span.value.end) stop()
  }, 250)
}

onBeforeUnmount(stop)

const sliderMin = computed(() => span.value?.start ?? 0)
const sliderMax = computed(() => span.value?.end ?? 1)
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <Btn size="sm" variant="primary" :disabled="!span" @click="playing ? stop() : play()">
        {{ playing ? 'Pause' : 'Play' }}
      </Btn>
      <span class="mono text-[11px] text-fg-muted">
        {{ playhead ? formatDate(new Date(playhead).toISOString()) : '—' }}
      </span>
      <span class="text-[11px] text-fg-faint mono ml-auto">{{ items.length }} events</span>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>

    <input
      v-if="span"
      type="range"
      class="w-full accent-[var(--color-accent)]"
      :min="sliderMin"
      :max="sliderMax"
      :value="playhead"
      @input="playhead = Number(($event.target as HTMLInputElement).value)"
    />

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="surface overflow-hidden min-h-[220px] bg-bg-base">
        <img
          v-if="shotSrc"
          :src="shotSrc"
          alt="Nearest screenshot"
          class="w-full h-full object-contain max-h-[420px]"
        />
        <div v-else class="h-[220px] grid place-items-center text-[12px] text-fg-faint">
          No screenshot near this moment.
        </div>
      </div>
      <div class="surface divide-y divide-border-subtle max-h-[420px] overflow-auto">
        <div
          v-for="ev in nearby"
          :key="ev.id"
          class="px-3 py-2"
        >
          <div class="flex items-baseline gap-2">
            <span class="mono text-[10px] text-fg-faint">{{ formatDate(ev.timestamp) }}</span>
            <span class="text-[10px] uppercase tracking-wide" :class="kindClass(ev.kind)">{{ ev.kind }}</span>
            <span class="text-[11px] truncate text-fg-muted">{{ ev.title || ev.url }}</span>
          </div>
          <pre v-if="ev.text" class="mono text-[12px] mt-1 whitespace-pre-wrap break-all">{{ ev.text }}</pre>
        </div>
        <div v-if="nearby.length === 0" class="text-center py-10 text-fg-faint text-[12px]">
          Scrub the timeline to reconstruct this browsing session.
        </div>
      </div>
    </div>
  </div>
</template>
