<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bots as botsApi } from '@/api/endpoints'

interface ActivityPoint { start: number | string; end: number | string }

const props = defineProps<{ botId: string }>()
const emit = defineEmits<{
  (e: 'select-day', key: string, dayStart: number, dayEnd: number): void
}>()

const list = ref<ActivityPoint[]>([])
const loading = ref(false)
const selectedDay = ref<string | null>(null)
const containerEl = ref<HTMLDivElement | null>(null)
const containerWidth = ref(600)
let ro: ResizeObserver | null = null

onMounted(() => {
  if (containerEl.value) {
    ro = new ResizeObserver((entries) => {
      containerWidth.value = entries[0].contentRect.width
    })
    ro.observe(containerEl.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())

async function load(): Promise<void> {
  loading.value = true
  try {
    list.value = (await botsApi.field<ActivityPoint[]>(props.botId, 'activity')) ?? []
  } finally {
    loading.value = false
  }
}
watch(() => props.botId, load, { immediate: true })

const DAY_MS = 86400000
const CELL_PX = 12
const WEEKS = computed(() => Math.max(20, Math.floor(containerWidth.value / CELL_PX)))

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const dailyMap = computed(() => {
  const map = new Map<string, number>()
  for (const p of list.value) {
    const s = typeof p.start === 'string' ? Date.parse(p.start) : p.start
    const e = typeof p.end === 'string' ? Date.parse(p.end) : p.end
    if (!s || !e || e <= s) continue
    const cur = new Date(s)
    cur.setHours(0, 0, 0, 0)
    while (cur.getTime() < e) {
      const dayStart = cur.getTime()
      const dayEnd = dayStart + DAY_MS
      const a = Math.max(s, dayStart)
      const b = Math.min(e, dayEnd)
      if (b > a) {
        const key = dateKey(cur)
        map.set(key, (map.get(key) ?? 0) + (b - a))
      }
      cur.setDate(cur.getDate() + 1)
    }
  }
  return map
})

interface Cell {
  date: Date
  key: string
  ms: number
  level: number
  future: boolean
}

const grid = computed(() => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  const todayDow = (today.getDay() + 6) % 7
  const totalDays = (WEEKS.value - 1) * 7 + todayDow + 1
  const startDate = new Date(todayMs - (totalDays - 1) * DAY_MS)

  const weeks: (Cell | null)[][] = []
  let maxMs = 0
  const allCells: Cell[] = []
  const firstDow = (startDate.getDay() + 6) % 7
  let week: (Cell | null)[] = new Array(firstDow).fill(null) as (Cell | null)[]

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate.getTime() + i * DAY_MS)
    const key = dateKey(d)
    const ms = dailyMap.value.get(key) ?? 0
    if (ms > maxMs) maxMs = ms
    const cell: Cell = { date: d, key, ms, level: 0, future: d.getTime() > todayMs }
    allCells.push(cell)
    week.push(cell)
    if (week.length === 7) { weeks.push(week); week = [] }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null)
    weeks.push(week)
  }
  if (maxMs > 0) {
    for (const c of allCells) {
      if (c.ms <= 0) c.level = 0
      else if (c.ms <= maxMs * 0.25) c.level = 1
      else if (c.ms <= maxMs * 0.5) c.level = 2
      else if (c.ms <= maxMs * 0.75) c.level = 3
      else c.level = 4
    }
  }
  return weeks
})

const monthLabels = computed(() => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const labels: { label: string; col: number }[] = []
  let lastMonth = -1
  for (let wi = 0; wi < grid.value.length; wi++) {
    const firstCell = grid.value[wi].find((c): c is Cell => c !== null)
    if (firstCell) {
      const m = firstCell.date.getMonth()
      if (m !== lastMonth) { labels.push({ label: months[m], col: wi }); lastMonth = m }
    }
  }
  return labels
})

const LEVEL_COLORS = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353']

function cellBg(cell: Cell | null): string {
  if (!cell || cell.future) return 'transparent'
  return LEVEL_COLORS[cell.level]
}

function cellTooltip(cell: Cell): string {
  const d = cell.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  if (cell.ms <= 0) return `No activity — ${d}`
  const h = Math.floor(cell.ms / 3600000)
  const m = Math.floor((cell.ms % 3600000) / 60000)
  const dur = h > 0 ? `${h}h ${m}m` : `${m}m`
  return `${dur} — ${d}`
}

function onCellClick(cell: Cell | null): void {
  if (!cell || cell.future) return
  selectedDay.value = selectedDay.value === cell.key ? null : cell.key
  if (selectedDay.value) {
    const dayStart = new Date(cell.key + 'T00:00:00').getTime()
    emit('select-day', cell.key, dayStart, dayStart + DAY_MS)
  }
}

const totalStats = computed(() => {
  let activeDays = 0, totalMs = 0
  for (const [, ms] of dailyMap.value) {
    if (ms > 0) { activeDays++; totalMs += ms }
  }
  return { activeDays, totalHours: Math.floor(totalMs / 3600000) }
})

defineExpose({ list, dailyMap, selectedDay })
</script>

<template>
  <div ref="containerEl" class="flex flex-col w-full">
    <div class="flex items-center justify-between leading-none">
      <span class="text-[9px] text-fg-faint mono">{{ totalStats.activeDays }}d · {{ totalStats.totalHours }}h</span>
      <div class="flex items-center gap-1 text-[8px] text-fg-faint mono">
        <span>Less</span>
        <span v-for="l in 5" :key="l" class="size-[7px] rounded-[1px]" :style="{ background: LEVEL_COLORS[l - 1] }" />
        <span>More</span>
      </div>
    </div>
    <div class="relative h-2.5" :style="{ width: grid.length * 12 + 'px' }">
      <span
        v-for="m in monthLabels"
        :key="m.col"
        class="text-[8px] text-fg-faint mono absolute whitespace-nowrap"
        :style="{ left: m.col * 12 + 'px' }"
      >{{ m.label }}</span>
    </div>
    <div class="flex gap-[2px]">
      <div v-for="(week, wi) in grid" :key="wi" class="flex flex-col gap-[2px]">
        <div
          v-for="(cell, di) in week"
          :key="di"
          class="size-[10px] rounded-[2px]"
          :class="{
            'cursor-pointer hover:ring-1 hover:ring-white/40': cell && !cell.future,
            'ring-1 ring-accent': cell?.key === selectedDay,
          }"
          :style="{ background: cellBg(cell) }"
          :title="cell && !cell.future ? cellTooltip(cell) : ''"
          @click="onCellClick(cell)"
        />
      </div>
    </div>
  </div>
</template>
