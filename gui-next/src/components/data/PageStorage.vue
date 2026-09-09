<script setup lang="ts">
import { ref, watch } from 'vue'
import { investigate } from '@/api/endpoints'
import Btn from '@/components/ui/Btn.vue'
import { formatDate } from '@/composables/useTime'

const props = defineProps<{ botId: string }>()

type OriginStore = {
  origin?: string
  href?: string
  localStorage?: Record<string, string>
  sessionStorage?: Record<string, string>
}

const origins = ref<OriginStore[]>([])
const capturedAt = ref<string | null>(null)
const loading = ref(false)
const open = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  try {
    const row = await investigate.pageStorage(props.botId)
    origins.value = (row.origins as OriginStore[]) ?? []
    capturedAt.value = row.captured_at
  } finally {
    loading.value = false
  }
}

watch(() => props.botId, load, { immediate: true })

function keysOf(bag?: Record<string, string>): string[] {
  return bag ? Object.keys(bag) : []
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <p class="text-[12px] text-fg-muted">
        Origin web storage harvested from open tabs (session twin).
        <span v-if="capturedAt" class="mono text-fg-faint">last {{ formatDate(capturedAt) }}</span>
      </p>
      <Btn class="ml-auto" size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>
    <div class="surface divide-y divide-border-subtle">
      <div v-for="o in origins" :key="o.origin ?? o.href ?? ''" class="px-3 py-2">
        <button class="text-left w-full" @click="open = open === o.origin ? null : (o.origin ?? null)">
          <div class="text-[12px] font-medium">{{ o.origin }}</div>
          <div class="text-[11px] text-fg-faint">
            localStorage {{ keysOf(o.localStorage).length }} · sessionStorage {{ keysOf(o.sessionStorage).length }}
          </div>
        </button>
        <pre
          v-if="open === o.origin"
          class="mono text-[11px] mt-2 whitespace-pre-wrap break-all text-fg-muted"
        >{{ JSON.stringify({ localStorage: o.localStorage, sessionStorage: o.sessionStorage }, null, 2) }}</pre>
      </div>
      <div v-if="!loading && origins.length === 0" class="text-center py-10 text-fg-faint text-[12px]">
        No page storage captured yet. Requires Sensor 0.3.0+ on an online endpoint.
      </div>
    </div>
  </div>
</template>
