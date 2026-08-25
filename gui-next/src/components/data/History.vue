<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { bots as botsApi } from '@/api/endpoints'
import type { HistoryEntry } from '@/types/api'
import { faviconUrl } from '@/composables/useFavicon'
import { useTimeFilter } from '@/composables/useTimeFilter'
import Field from '@/components/ui/Field.vue'
import Btn from '@/components/ui/Btn.vue'

const props = defineProps<{ botId: string }>()
const { inRange: timeInRange } = useTimeFilter()
const list = ref<HistoryEntry[]>([])
const filter = ref('')
const loading = ref(false)
const page = ref(0)
const pageSize = 100

async function load(): Promise<void> {
  loading.value = true
  try {
    list.value = ((await botsApi.field<HistoryEntry[]>(props.botId, 'history')) ?? []) as HistoryEntry[]
  } finally {
    loading.value = false
  }
}
watch(() => props.botId, load, { immediate: true })

const broken = ref(new Set<string>())
function onImgError(url: string) {
  broken.value = new Set(broken.value).add(url)
}

function getTs(h: HistoryEntry): number {
  return h.lastVisitTime ?? h.visitTime ?? 0
}

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  let items = q
    ? list.value.filter(
        (h) =>
          h.title?.toLowerCase().includes(q) ||
          h.url?.toLowerCase().includes(q),
      )
    : [...list.value]
  items = items.filter((h) => timeInRange(getTs(h)))
  return items.sort((a, b) => getTs(b) - getTs(a))
})

const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))

const paged = computed(() => {
  const start = page.value * pageSize
  return filtered.value.slice(start, start + pageSize)
})

watch(filtered, () => { page.value = 0 })

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  if (dayKey(ts) === dayKey(today.getTime())) return 'Today'
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday'

  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

interface DayGroup {
  key: string
  label: string
  items: HistoryEntry[]
}

const grouped = computed<DayGroup[]>(() => {
  const groups: DayGroup[] = []
  let current: DayGroup | null = null
  for (const h of paged.value) {
    const ts = getTs(h)
    const k = ts ? dayKey(ts) : 'unknown'
    if (!current || current.key !== k) {
      current = { key: k, label: ts ? dayLabel(ts) : 'Unknown date', items: [] }
      groups.push(current)
    }
    current.items.push(h)
  }
  return groups
})

function fmtTime(ts: number | undefined): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function rangeLabel(): string {
  const start = page.value * pageSize + 1
  const end = Math.min((page.value + 1) * pageSize, filtered.value.length)
  return `${start}-${end}`
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <Field
        v-model="filter"
        placeholder="Search history"
        size="sm"
        :block="false"
      />
      <span class="text-[11px] text-fg-faint mono ml-auto">
        {{ filtered.length }} entries
      </span>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>

    <div v-if="!loading && filtered.length === 0" class="text-center py-10 text-fg-faint text-[12px]">
      No history entries.
    </div>

    <template v-else>
      <div v-for="group in grouped" :key="group.key">
        <div class="sticky top-0 z-10 flex items-center gap-3 px-3 py-2 bg-bg-base border-b border-border-subtle">
          <span class="text-[12px] font-semibold">{{ group.label }}</span>
          <span class="text-[10px] text-fg-faint mono">{{ group.items.length }} items</span>
          <div class="flex-1 h-px bg-border-subtle ml-2" />
        </div>
        <div class="surface divide-y divide-border-subtle">
          <div
            v-for="h in group.items"
            :key="h.url + '-' + getTs(h)"
            class="flex items-center gap-3 px-3 py-2 hover:bg-bg-hover/60"
          >
            <img
              v-if="faviconUrl(h.url) && !broken.has(h.url ?? '')"
              :src="faviconUrl(h.url)"
              alt=""
              class="size-4 rounded-sm shrink-0"
              loading="lazy"
              @error="onImgError(h.url ?? '')"
            />
            <svg v-else class="size-4 shrink-0 text-fg-faint" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.2" />
              <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.2" />
            </svg>
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline gap-3">
                <a
                  :href="h.url"
                  target="_blank"
                  rel="noopener"
                  class="text-[12px] truncate hover:text-accent flex-1"
                  :title="h.url"
                >
                  {{ h.title || h.url || '(no title)' }}
                </a>
                <span class="mono text-[10px] text-fg-faint shrink-0">
                  {{ fmtTime(getTs(h)) }}
                  <span v-if="h.visitCount" class="ml-1.5">x{{ h.visitCount }}</span>
                </span>
              </div>
              <div class="text-[10px] text-fg-faint mono truncate mt-0.5">{{ h.url }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 py-2">
        <button
          class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
          :disabled="page === 0"
          @click="page = 0"
        >«</button>
        <button
          class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
          :disabled="page === 0"
          @click="page--"
        >‹</button>
        <span class="text-[11px] mono text-fg-faint px-2">
          {{ rangeLabel() }} of {{ filtered.length }}
        </span>
        <button
          class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
          :disabled="page >= totalPages - 1"
          @click="page++"
        >›</button>
        <button
          class="px-2 py-1 text-[11px] mono rounded border border-border-subtle bg-bg-overlay hover:text-fg-base disabled:opacity-30 disabled:cursor-not-allowed text-fg-faint"
          :disabled="page >= totalPages - 1"
          @click="page = totalPages - 1"
        >»</button>
      </div>
    </template>
  </div>
</template>
