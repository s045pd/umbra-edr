<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { investigate } from '@/api/endpoints'
import type { AlertEntry } from '@/types/api'
import Btn from '@/components/ui/Btn.vue'
import { formatDate } from '@/composables/useTime'

const router = useRouter()
const list = ref<AlertEntry[]>([])
const loading = ref(false)
const onlyUnacked = ref(true)

async function load(): Promise<void> {
  loading.value = true
  try {
    list.value = (await investigate.alerts(undefined, onlyUnacked.value, 200)) ?? []
  } finally {
    loading.value = false
  }
}

async function ack(id: string): Promise<void> {
  await investigate.ackAlert(id)
  await load()
}

onMounted(load)
</script>

<template>
  <div class="px-6 pt-5 pb-12 max-w-[1100px] mx-auto space-y-4">
    <div class="flex items-end justify-between">
      <div>
        <h1 class="text-[20px] font-semibold tracking-tight">Alerts</h1>
        <p class="text-[12px] text-fg-faint mt-0.5">
          Domain-visit detections from enrolled sensors.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-[11px] text-fg-muted inline-flex items-center gap-1.5">
          <input v-model="onlyUnacked" type="checkbox" @change="load" />
          Unacknowledged only
        </label>
        <Btn size="sm" variant="ghost" :loading="loading" @click="load">Refresh</Btn>
      </div>
    </div>

    <div class="surface divide-y divide-border-subtle">
      <div v-for="a in list" :key="a.id" class="px-4 py-3 flex items-start gap-3">
        <span
          class="mt-1 size-2 rounded-full shrink-0"
          :class="a.acknowledged ? 'bg-fg-faint/50' : 'bg-danger'"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="text-[12px] font-medium">{{ a.title }}</span>
            <span class="text-[10px] uppercase text-danger">{{ a.severity }}</span>
            <span class="mono text-[10px] text-fg-faint ml-auto">{{ formatDate(a.timestamp) }}</span>
          </div>
          <a :href="a.url" class="text-[12px] text-accent truncate block" target="_blank" rel="noopener">{{ a.url }}</a>
          <p v-if="a.detail" class="text-[11px] text-fg-muted mt-0.5">{{ a.detail }}</p>
        </div>
        <div class="flex flex-col gap-1 shrink-0">
          <Btn size="sm" variant="ghost" @click="router.push({ name: 'bot-detail', params: { id: a.bot_id } })">
            Open bot
          </Btn>
          <Btn v-if="!a.acknowledged" size="sm" variant="primary" @click="ack(a.id)">Ack</Btn>
        </div>
      </div>
      <div v-if="!loading && list.length === 0" class="text-center py-16 text-fg-faint text-[12px]">
        No alerts. Enable domain notifications on a bot Config tab to start detecting.
      </div>
    </div>
  </div>
</template>
