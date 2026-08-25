<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { bots as botsApi } from '@/api/endpoints'
import { useTimeFilter } from '@/composables/useTimeFilter'
import Field from '@/components/ui/Field.vue'
import Btn from '@/components/ui/Btn.vue'

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
const { inRange: timeInRange } = useTimeFilter()
const list = ref<Download[]>([])
const filter = ref('')
const loading = ref(false)
const sortBy = ref<'time' | 'size'>('time')
const sortAsc = ref(false)
const page = ref(0)
const pageSize = 50

async function load(): Promise<void> {
  loading.value = true
  try {
    list.value = ((await botsApi.field<Download[]>(props.botId, 'downloads')) ?? []) as Download[]
  } finally {
    loading.value = false
  }
}
watch(() => props.botId, load, { immediate: true })

function getTime(d: Download): number {
  if (d.startTime) return new Date(d.startTime).getTime() || 0
  return 0
}

function getSize(d: Download): number {
  return d.totalBytes ?? d.bytesReceived ?? 0
}

const sorted = computed(() => {
  const items = list.value.filter((d) => timeInRange(getTime(d)))
  const dir = sortAsc.value ? 1 : -1
  if (sortBy.value === 'time') {
    items.sort((a, b) => (getTime(a) - getTime(b)) * dir)
  } else {
    items.sort((a, b) => (getSize(a) - getSize(b)) * dir)
  }
  return items
})

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return sorted.value
  return sorted.value.filter(
    (d) =>
      d.filename?.toLowerCase().includes(q) ||
      d.url?.toLowerCase().includes(q),
  )
})

function toggleSort(col: 'time' | 'size'): void {
  if (sortBy.value === col) {
    sortAsc.value = !sortAsc.value
  } else {
    sortBy.value = col
    sortAsc.value = col === 'size'
  }
}

function sortIcon(col: 'time' | 'size'): string {
  if (sortBy.value !== col) return '⇅'
  return sortAsc.value ? '↑' : '↓'
}

function sizeLabel(b: number | undefined): string {
  if (!b) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = b
  while (v > 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

function timeLabel(s: string | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const paged = computed(() => {
  const start = page.value * pageSize
  return filtered.value.slice(start, start + pageSize)
})
watch(filtered, () => { page.value = 0 })

function rangeLabel(): string {
  const start = page.value * pageSize + 1
  const end = Math.min((page.value + 1) * pageSize, filtered.value.length)
  return `${start}-${end}`
}

function stateClass(state: string | undefined): string {
  if (!state) return 'text-fg-faint'
  if (state === 'complete') return 'text-success'
  if (state === 'interrupted' || state === 'cancelled') return 'text-danger'
  return 'text-warn'
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <Field
        v-model="filter"
        placeholder="Filter by filename, url"
        size="sm"
        :block="false"
      />
      <span class="text-[11px] text-fg-faint mono ml-auto">
        {{ filtered.length }} / {{ list.length }}
      </span>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>

    <div class="surface overflow-hidden">
      <table class="w-full text-left">
        <thead>
          <tr class="text-[10px] uppercase tracking-wider text-fg-faint border-b border-border-subtle bg-bg-overlay">
            <th class="px-3 py-2 w-[170px]">
              <button
                class="flex items-center gap-1 hover:text-fg-base transition-colors"
                @click="toggleSort('time')"
              >
                Time
                <span class="text-[9px]">{{ sortIcon('time') }}</span>
              </button>
            </th>
            <th class="px-3 py-2">Filename</th>
            <th class="px-3 py-2 w-[80px]">State</th>
            <th class="px-3 py-2 w-[90px]">
              <button
                class="flex items-center gap-1 hover:text-fg-base transition-colors"
                @click="toggleSort('size')"
              >
                Size
                <span class="text-[9px]">{{ sortIcon('size') }}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(d, i) in paged"
            :key="page * pageSize + i"
            class="border-b border-border-subtle last:border-b-0 hover:bg-bg-hover/60"
          >
            <td class="px-3 py-1.5 mono text-[11px] text-fg-faint whitespace-nowrap">
              {{ timeLabel(d.startTime) }}
            </td>
            <td class="px-3 py-1.5">
              <div class="truncate max-w-[400px]">
                <a
                  v-if="d.url"
                  :href="d.url"
                  target="_blank"
                  rel="noopener"
                  class="text-[12px] hover:text-accent"
                  :title="d.url"
                >{{ d.filename || d.url }}</a>
                <span v-else class="text-[12px]">{{ d.filename || '—' }}</span>
              </div>
              <div v-if="d.url" class="text-[10px] text-fg-faint mono truncate max-w-[400px]" :title="d.url">
                {{ d.url }}
              </div>
            </td>
            <td class="px-3 py-1.5">
              <span class="chip" :class="stateClass(d.state)">
                {{ d.state || 'unknown' }}
              </span>
            </td>
            <td class="px-3 py-1.5 mono text-[11px] text-fg-faint whitespace-nowrap">
              {{ sizeLabel(d.totalBytes ?? d.bytesReceived) }}
            </td>
          </tr>
          <tr v-if="!loading && filtered.length === 0">
            <td colspan="4" class="text-center py-10 text-fg-faint text-[12px]">
              No downloads recorded.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 py-1">
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="page === 0"
        @click="page = 0"
      >&laquo;</button>
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="page === 0"
        @click="page--"
      >&lsaquo;</button>
      <span class="text-[11px] mono text-fg-faint px-2">
        {{ rangeLabel() }} of {{ filtered.length }}
      </span>
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="page >= totalPages - 1"
        @click="page++"
      >&rsaquo;</button>
      <button
        class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
        :disabled="page >= totalPages - 1"
        @click="page = totalPages - 1"
      >&raquo;</button>
    </div>
  </div>
</template>
