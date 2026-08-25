<script setup lang="ts">
import { computed, ref, onBeforeUnmount, watch } from 'vue'
import { bots as botsApi } from '@/api/endpoints'
import { useTimeFilter } from '@/composables/useTimeFilter'

interface ActivityPoint { start: number | string; end: number | string }

const props = defineProps<{
  botId: string
  dayKey: string
  dayStart: number
  dayEnd: number
}>()

const { setRange, clearRange, _startMs, _endMs } = useTimeFilter()

const list = ref<ActivityPoint[]>([])
const trackEl = ref<HTMLDivElement | null>(null)

async function load(): Promise<void> {
  list.value = (await botsApi.field<ActivityPoint[]>(props.botId, 'activity')) ?? []
}
watch(() => props.botId, load, { immediate: true })

const DAY_MS = 86400000

interface Block { leftPct: number; widthPct: number; startMs: number; endMs: number }

const blocks = computed<Block[]>(() => {
  const result: Block[] = []
  for (const p of list.value) {
    const s = typeof p.start === 'string' ? Date.parse(p.start) : p.start
    const e = typeof p.end === 'string' ? Date.parse(p.end) : p.end
    if (!s || !e || e <= s) continue
    const a = Math.max(s, props.dayStart)
    const b = Math.min(e, props.dayEnd)
    if (b <= a) continue
    result.push({
      leftPct: (a - props.dayStart) / DAY_MS * 100,
      widthPct: Math.max(0.3, (b - a) / DAY_MS * 100),
      startMs: a,
      endMs: b,
    })
  }
  return result.sort((a, b) => a.startMs - b.startMs)
})

const handleStartPct = ref(0)
const handleEndPct = ref(100)
const dragging = ref<'start' | 'end' | 'range' | null>(null)
const clickPhase = ref<'idle' | 'placed-start'>('idle')
let dragStartX = 0
let dragStartPct = 0
let dragEndPct = 0

function syncFromGlobal(): void {
  if (_startMs.value !== null && _endMs.value !== null) {
    const s = Math.max(_startMs.value, props.dayStart)
    const e = Math.min(_endMs.value, props.dayEnd)
    if (e > s) {
      handleStartPct.value = (s - props.dayStart) / DAY_MS * 100
      handleEndPct.value = (e - props.dayStart) / DAY_MS * 100
      return
    }
  }
  handleStartPct.value = 0
  handleEndPct.value = 100
}

watch(() => props.dayKey, syncFromGlobal, { immediate: true })

function pctToMs(pct: number): number {
  return props.dayStart + (pct / 100) * DAY_MS
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtPctTime(pct: number): string {
  if (pct >= 100) return '24:00:00'
  return fmtTime(pctToMs(pct))
}

const rangeLabel = computed(() => {
  return `${fmtPctTime(handleStartPct.value)} → ${fmtPctTime(handleEndPct.value)}`
})

function emitRange(): void {
  setRange(pctToMs(handleStartPct.value), pctToMs(handleEndPct.value))
}

function getTrackPct(clientX: number): number {
  if (!trackEl.value) return 0
  const rect = trackEl.value.getBoundingClientRect()
  return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))
}

function onTrackClick(e: MouseEvent): void {
  if (dragging.value) return
  const pct = getTrackPct(e.clientX)
  if (clickPhase.value === 'idle') {
    handleStartPct.value = pct
    handleEndPct.value = pct
    clickPhase.value = 'placed-start'
  } else {
    const end = pct
    if (end < handleStartPct.value) {
      handleEndPct.value = handleStartPct.value
      handleStartPct.value = end
    } else {
      handleEndPct.value = end
    }
    clickPhase.value = 'idle'
    emitRange()
  }
}

function onHandleDown(which: 'start' | 'end', e: MouseEvent): void {
  e.stopPropagation()
  e.preventDefault()
  dragging.value = which
  dragStartX = e.clientX
  dragStartPct = which === 'start' ? handleStartPct.value : handleEndPct.value
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onRangeDown(e: MouseEvent): void {
  e.stopPropagation()
  e.preventDefault()
  dragging.value = 'range'
  dragStartX = e.clientX
  dragStartPct = handleStartPct.value
  dragEndPct = handleEndPct.value
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

function onMouseMove(e: MouseEvent): void {
  if (!dragging.value || !trackEl.value) return
  const rect = trackEl.value.getBoundingClientRect()
  const deltaPct = ((e.clientX - dragStartX) / rect.width) * 100

  if (dragging.value === 'start') {
    handleStartPct.value = Math.max(0, Math.min(handleEndPct.value - 0.5, dragStartPct + deltaPct))
  } else if (dragging.value === 'end') {
    handleEndPct.value = Math.min(100, Math.max(handleStartPct.value + 0.5, dragStartPct + deltaPct))
  } else if (dragging.value === 'range') {
    const span = dragEndPct - dragStartPct
    let newStart = dragStartPct + deltaPct
    let newEnd = dragEndPct + deltaPct
    if (newStart < 0) { newStart = 0; newEnd = span }
    if (newEnd > 100) { newEnd = 100; newStart = 100 - span }
    handleStartPct.value = newStart
    handleEndPct.value = newEnd
  }
}

function onMouseUp(): void {
  if (dragging.value) {
    emitRange()
    dragging.value = null
  }
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
}

function resetRange(): void {
  handleStartPct.value = 0
  handleEndPct.value = 100
  clickPhase.value = 'idle'
  clearRange()
}

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})

const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24]
</script>

<template>
  <div class="surface px-4 py-2.5 select-none">
    <div class="flex items-center gap-3 mb-2">
      <span class="text-[11px] font-semibold">{{ dayKey }}</span>
      <span class="text-[10px] mono text-accent">{{ rangeLabel }}</span>
      <span
        v-if="clickPhase === 'placed-start'"
        class="text-[10px] text-warning animate-pulse"
      >Click timeline to set end</span>
      <button
        class="ml-auto text-[10px] text-fg-faint hover:text-fg-base"
        @click="resetRange"
      >Reset</button>
    </div>

    <div
      ref="trackEl"
      class="relative h-8 rounded bg-bg-overlay border border-border-subtle cursor-crosshair overflow-hidden"
      @click="onTrackClick"
    >
      <!-- activity blocks -->
      <div
        v-for="(b, i) in blocks"
        :key="i"
        class="absolute top-[6px] bottom-[6px] rounded-sm pointer-events-none"
        :style="{
          left: b.leftPct + '%',
          width: b.widthPct + '%',
          background: '#26a641',
          opacity: 0.5,
        }"
      />

      <!-- selected range highlight -->
      <div
        class="absolute top-0 bottom-0 pointer-events-none"
        :style="{
          left: handleStartPct + '%',
          width: (handleEndPct - handleStartPct) + '%',
          background: 'rgba(56,189,248,0.12)',
          borderLeft: '1px solid rgba(56,189,248,0.4)',
          borderRight: '1px solid rgba(56,189,248,0.4)',
        }"
      />

      <!-- draggable range area -->
      <div
        class="absolute top-0 bottom-0 cursor-grab active:cursor-grabbing z-10"
        :style="{
          left: (handleStartPct + 0.5) + '%',
          width: Math.max(0, handleEndPct - handleStartPct - 1) + '%',
        }"
        @mousedown="onRangeDown"
      />

      <!-- start handle -->
      <div
        class="absolute top-0 bottom-0 w-[6px] cursor-col-resize z-20 group"
        :style="{ left: `calc(${handleStartPct}% - 3px)` }"
        @mousedown="onHandleDown('start', $event)"
      >
        <div class="w-[2px] h-full mx-auto bg-accent group-hover:bg-accent/80 rounded-full" />
      </div>

      <!-- end handle -->
      <div
        class="absolute top-0 bottom-0 w-[6px] cursor-col-resize z-20 group"
        :style="{ left: `calc(${handleEndPct}% - 3px)` }"
        @mousedown="onHandleDown('end', $event)"
      >
        <div class="w-[2px] h-full mx-auto bg-accent group-hover:bg-accent/80 rounded-full" />
      </div>
    </div>

    <!-- hour ticks -->
    <div class="relative h-3 mt-0.5">
      <span
        v-for="h in hours"
        :key="h"
        class="absolute text-[8px] text-fg-faint mono -translate-x-1/2"
        :style="{ left: (h / 24) * 100 + '%' }"
      >{{ String(h).padStart(2, '0') }}</span>
    </div>
  </div>
</template>
