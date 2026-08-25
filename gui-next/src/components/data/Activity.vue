<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { bots as botsApi } from '@/api/endpoints'
import Btn from '@/components/ui/Btn.vue'

interface ActivityPoint { start: number | string; end: number | string }

const props = defineProps<{ botId: string }>()
const list = ref<ActivityPoint[]>([])
const loading = ref(false)
const selectedDay = ref<string | null>(null)

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
const WEEKS = 53

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
  const totalDays = (WEEKS - 1) * 7 + todayDow + 1
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
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
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
      if (m !== lastMonth) {
        labels.push({ label: months[m], col: wi })
        lastMonth = m
      }
    }
  }
  return labels
})

const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', '']

const LEVEL_COLORS = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353']

function cellBg(cell: Cell | null): string {
  if (!cell || cell.future) return 'transparent'
  return LEVEL_COLORS[cell.level]
}

function cellTooltip(cell: Cell): string {
  const d = cell.date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
  if (cell.ms <= 0) return `No activity — ${d}`
  return `${fmtDur(cell.ms)} — ${d}`
}

function fmtDur(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(ms / 1000)}s`
}

function onCellClick(cell: Cell | null): void {
  if (!cell || cell.future) return
  selectedDay.value = selectedDay.value === cell.key ? null : cell.key
}

const selectedDayLabel = computed(() => {
  if (!selectedDay.value) return ''
  const d = new Date(selectedDay.value + 'T00:00:00')
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
})

interface DaySession { start: Date; end: Date; duration: string }

const selectedDaySessions = computed<DaySession[]>(() => {
  if (!selectedDay.value) return []
  const dayStart = new Date(selectedDay.value + 'T00:00:00').getTime()
  const dayEnd = dayStart + DAY_MS
  const sessions: DaySession[] = []
  for (const p of list.value) {
    const s = typeof p.start === 'string' ? Date.parse(p.start) : p.start
    const e = typeof p.end === 'string' ? Date.parse(p.end) : p.end
    if (!s || !e || e <= s) continue
    const a = Math.max(s, dayStart)
    const b = Math.min(e, dayEnd)
    if (b <= a) continue
    sessions.push({ start: new Date(a), end: new Date(b), duration: fmtDur(b - a) })
  }
  return sessions.sort((a, b) => a.start.getTime() - b.start.getTime())
})

const selectedDayTotal = computed(() => {
  if (!selectedDay.value) return ''
  return fmtDur(dailyMap.value.get(selectedDay.value) ?? 0)
})

function timePct(d: Date): number {
  return (d.getHours() * 60 + d.getMinutes()) / 1440 * 100
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const totalStats = computed(() => {
  let activeDays = 0
  let totalMs = 0
  for (const [, ms] of dailyMap.value) {
    if (ms > 0) { activeDays++; totalMs += ms }
  }
  return { activeDays, totalHours: Math.floor(totalMs / 3600000) }
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <span class="text-[11px] text-fg-faint mono">
        {{ list.length }} sessions · {{ totalStats.activeDays }} active days · {{ totalStats.totalHours }}h total
      </span>
      <Btn size="sm" variant="ghost" :loading="loading" class="ml-auto" @click="load">Reload</Btn>
    </div>

    <!-- GitHub-style contribution heatmap -->
    <div class="surface px-4 py-4 overflow-x-auto">
      <div class="inline-flex flex-col" style="min-width: max-content">
        <!-- Month labels -->
        <div class="relative h-4 ml-[32px]" :style="{ width: grid.length * 16 + 'px' }">
          <span
            v-for="m in monthLabels"
            :key="m.col"
            class="text-[10px] text-fg-faint mono absolute whitespace-nowrap"
            :style="{ left: m.col * 16 + 'px' }"
          >{{ m.label }}</span>
        </div>

        <div class="flex">
          <!-- Day-of-week labels -->
          <div class="flex flex-col gap-[3px] shrink-0">
            <div
              v-for="(label, i) in dayLabels"
              :key="i"
              class="h-[13px] w-[28px] text-[10px] text-fg-faint mono text-right pr-1 leading-[13px]"
            >{{ label }}</div>
          </div>

          <!-- Week columns -->
          <div class="flex gap-[3px]">
            <div v-for="(week, wi) in grid" :key="wi" class="flex flex-col gap-[3px]">
              <div
                v-for="(cell, di) in week"
                :key="di"
                class="size-[13px] rounded-[2px]"
                :class="{
                  'cursor-pointer hover:ring-1 hover:ring-white/40': cell && !cell.future,
                  'ring-2 ring-accent ring-offset-1 ring-offset-bg-base': cell?.key === selectedDay,
                }"
                :style="{ background: cellBg(cell) }"
                :title="cell && !cell.future ? cellTooltip(cell) : ''"
                @click="onCellClick(cell)"
              />
            </div>
          </div>
        </div>

        <!-- Legend -->
        <div class="flex items-center justify-end gap-1.5 mt-3 text-[10px] text-fg-faint mono">
          <span>Less</span>
          <span
            v-for="l in 5"
            :key="l"
            class="size-[11px] rounded-[2px]"
            :style="{ background: LEVEL_COLORS[l - 1] }"
          />
          <span>More</span>
        </div>
      </div>
    </div>

    <!-- Selected day detail panel -->
    <div v-if="selectedDay" class="surface overflow-hidden">
      <div class="px-4 py-2.5 border-b border-border-subtle bg-bg-overlay flex items-center gap-3">
        <h3 class="text-[12px] font-semibold">{{ selectedDayLabel }}</h3>
        <span class="chip mono">{{ selectedDayTotal }}</span>
        <span class="text-[10px] text-fg-faint mono">{{ selectedDaySessions.length }} sessions</span>
        <button class="ml-auto text-fg-faint hover:text-fg-base text-[14px] leading-none" @click="selectedDay = null">&times;</button>
      </div>

      <!-- 24h timeline -->
      <div class="px-4 py-3">
        <div class="relative h-5 rounded bg-bg-overlay border border-border-subtle overflow-hidden">
          <div
            v-for="(s, i) in selectedDaySessions"
            :key="i"
            class="absolute top-0 bottom-0 rounded-sm"
            :style="{
              left: timePct(s.start) + '%',
              width: Math.max(0.4, timePct(s.end) - timePct(s.start)) + '%',
              background: LEVEL_COLORS[3],
            }"
            :title="`${fmtTime(s.start)} → ${fmtTime(s.end)} (${s.duration})`"
          />
        </div>
        <div class="flex justify-between mt-1 text-[9px] text-fg-faint mono">
          <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
        </div>
      </div>

      <!-- Session list -->
      <div class="divide-y divide-border-subtle max-h-[240px] overflow-y-auto">
        <div
          v-for="(s, i) in selectedDaySessions"
          :key="i"
          class="px-4 py-1.5 flex items-center gap-3 text-[11px] hover:bg-bg-hover/60"
        >
          <span class="size-2 rounded-full shrink-0" :style="{ background: LEVEL_COLORS[3] }" />
          <span class="mono text-fg-faint">{{ fmtTime(s.start) }}</span>
          <span class="text-fg-faint">→</span>
          <span class="mono text-fg-faint">{{ fmtTime(s.end) }}</span>
          <span class="chip mono ml-auto">{{ s.duration }}</span>
        </div>
        <div v-if="selectedDaySessions.length === 0" class="px-4 py-6 text-center text-fg-faint text-[11px]">
          No activity sessions on this day.
        </div>
      </div>
    </div>

    <div v-if="!loading && list.length === 0" class="text-center py-6 text-fg-faint text-[12px]">
      No activity recorded for this bot yet.
    </div>
  </div>
</template>
