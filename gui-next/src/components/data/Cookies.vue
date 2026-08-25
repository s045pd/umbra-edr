<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { bots as botsApi } from '@/api/endpoints'
import type { CookieEntry } from '@/types/api'
import Field from '@/components/ui/Field.vue'
import Btn from '@/components/ui/Btn.vue'
import { useClipboard } from '@/composables/useClipboard'

const props = defineProps<{ botId: string }>()
const list = ref<CookieEntry[]>([])
const filter = ref('')
const statusFilter = ref<'all' | 'valid' | 'expired'>('all')
const loading = ref(false)
const page = ref(0)
const pageSize = 50
const { copy, copied } = useClipboard()

async function load(): Promise<void> {
  loading.value = true
  try {
    list.value = (await botsApi.field<CookieEntry[]>(props.botId, 'cookies')) ?? []
  } finally {
    loading.value = false
  }
}

watch(() => props.botId, load, { immediate: true })

function isExpired(c: CookieEntry): boolean {
  if (!c.expirationDate) return false
  return c.expirationDate * 1000 < Date.now()
}

const stats = computed(() => {
  let valid = 0
  let expired = 0
  for (const c of list.value) {
    if (isExpired(c)) expired++
    else valid++
  }
  return { valid, expired }
})

const filtered = computed(() => {
  let items = list.value

  if (statusFilter.value === 'valid') {
    items = items.filter((c) => !isExpired(c))
  } else if (statusFilter.value === 'expired') {
    items = items.filter((c) => isExpired(c))
  }

  const q = filter.value.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (c) =>
      c.name?.toLowerCase().includes(q) ||
      c.domain?.toLowerCase().includes(q) ||
      c.value?.toLowerCase().includes(q),
  )
})

function expiryLabel(c: CookieEntry): string {
  if (!c.expirationDate) return 'session'
  const d = new Date(c.expirationDate * 1000)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

function exportJson(): void {
  copy(JSON.stringify(list.value, null, 2), 'export')
}
function exportNetscape(): void {
  const lines = list.value.map((c) => {
    const flag = c.domain?.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0
    return [
      c.domain ?? '',
      flag,
      c.path ?? '/',
      secure,
      exp,
      c.name ?? '',
      c.value ?? '',
    ].join('\t')
  })
  copy('# Netscape HTTP Cookie File\n' + lines.join('\n'), 'netscape')
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <Field
        v-model="filter"
        placeholder="Filter by name, domain, value"
        size="sm"
        :block="false"
      />

      <div class="flex items-center border border-border-subtle rounded overflow-hidden text-[10px] shrink-0">
        <button
          class="px-2 py-1 transition-colors"
          :class="statusFilter === 'all' ? 'bg-accent text-white' : 'text-fg-faint hover:text-fg-base'"
          @click="statusFilter = 'all'"
        >All ({{ list.length }})</button>
        <button
          class="px-2 py-1 transition-colors border-l border-border-subtle"
          :class="statusFilter === 'valid' ? 'bg-success/80 text-white' : 'text-fg-faint hover:text-fg-base'"
          @click="statusFilter = 'valid'"
        >Valid ({{ stats.valid }})</button>
        <button
          class="px-2 py-1 transition-colors border-l border-border-subtle"
          :class="statusFilter === 'expired' ? 'bg-danger/80 text-white' : 'text-fg-faint hover:text-fg-base'"
          @click="statusFilter = 'expired'"
        >Expired ({{ stats.expired }})</button>
      </div>

      <span class="text-[11px] text-fg-faint mono ml-auto">
        {{ filtered.length }} / {{ list.length }}
      </span>
      <Btn size="sm" variant="ghost" @click="exportJson">
        {{ copied === 'export' ? '✓ copied' : 'Copy JSON' }}
      </Btn>
      <Btn size="sm" variant="ghost" @click="exportNetscape">
        {{ copied === 'netscape' ? '✓ copied' : 'Copy Netscape' }}
      </Btn>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>

    <div class="surface overflow-hidden">
      <table class="w-full text-left">
        <thead>
          <tr
            class="text-[10px] uppercase tracking-wider text-fg-faint border-b border-border-subtle bg-bg-overlay"
          >
            <th class="px-3 py-2 w-[6px]"></th>
            <th class="px-3 py-2">Name</th>
            <th class="px-3 py-2">Domain</th>
            <th class="px-3 py-2">Value</th>
            <th class="px-3 py-2 w-[140px]">Expires</th>
            <th class="px-3 py-2 w-[110px]">Flags</th>
            <th class="px-3 py-2 w-[60px]"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(c, i) in paged"
            :key="page * pageSize + i"
            class="border-b border-border-subtle last:border-b-0 transition-colors"
            :class="isExpired(c) ? 'bg-danger/5 hover:bg-danger/10' : 'hover:bg-bg-hover/60'"
          >
            <td class="pl-3 py-1.5 w-[6px]">
              <span
                class="inline-block size-2 rounded-full"
                :class="isExpired(c) ? 'bg-danger' : 'bg-success'"
                :title="isExpired(c) ? 'Expired' : 'Valid'"
              />
            </td>
            <td class="px-3 py-1.5 mono text-[12px] truncate max-w-[180px]" :title="c.name">
              <span :class="isExpired(c) ? 'line-through text-fg-faint' : ''">{{ c.name }}</span>
            </td>
            <td class="px-3 py-1.5 text-[12px] truncate max-w-[200px]" :title="c.domain">
              {{ c.domain }}
            </td>
            <td class="px-3 py-1.5 mono text-[11px] text-fg-muted truncate max-w-[300px]" :title="c.value">
              {{ c.value }}
            </td>
            <td class="px-3 py-1.5 mono text-[10px]" :class="isExpired(c) ? 'text-danger' : 'text-fg-faint'">
              {{ expiryLabel(c) }}
            </td>
            <td class="px-3 py-1.5">
              <span class="flex flex-wrap gap-1">
                <span v-if="c.secure" class="chip">secure</span>
                <span v-if="c.httpOnly" class="chip">httpOnly</span>
                <span v-if="c.sameSite" class="chip">{{ c.sameSite }}</span>
              </span>
            </td>
            <td class="px-3 py-1.5">
              <button
                class="text-fg-faint hover:text-accent text-[11px]"
                @click="copy(c.value ?? '', 'v-' + (page * pageSize + i))"
              >
                {{ copied === 'v-' + (page * pageSize + i) ? '✓' : 'copy' }}
              </button>
            </td>
          </tr>
          <tr v-if="!loading && filtered.length === 0">
            <td colspan="7" class="text-center py-10 text-fg-faint text-[12px]">
              No cookies match.
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
