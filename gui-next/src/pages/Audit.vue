<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { audit } from '@/api/endpoints'
import type { AuditEntry } from '@/types/api'
import { formatDate } from '@/composables/useTime'

const rows = ref<AuditEntry[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    rows.value = (await audit.list(200)) ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'failed to load audit log'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="px-6 pt-5 pb-12 max-w-[1100px] mx-auto space-y-4">
    <div>
      <h1 class="text-[20px] font-semibold tracking-tight">Operator audit</h1>
      <p class="text-[12px] text-fg-faint mt-0.5">
        Mutating API calls by signed-in operators. Admin only.
      </p>
    </div>
    <p v-if="error" class="text-danger text-[12px]">{{ error }}</p>
    <p v-else-if="loading" class="text-fg-faint text-[12px]">Loading…</p>
    <div v-else class="surface overflow-hidden">
      <table class="w-full text-[12px]">
        <thead class="bg-bg-overlay text-fg-muted text-[10px] uppercase tracking-wider">
          <tr>
            <th class="text-left px-3 py-2 font-medium">When</th>
            <th class="text-left px-3 py-2 font-medium">Who</th>
            <th class="text-left px-3 py-2 font-medium">Action</th>
            <th class="text-left px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-border-subtle">
          <tr v-for="row in rows" :key="row.id">
            <td class="px-3 py-2 mono text-fg-faint whitespace-nowrap">{{ formatDate(row.created_at) }}</td>
            <td class="px-3 py-2">{{ row.username || row.user_id }}</td>
            <td class="px-3 py-2 mono">{{ row.method }} {{ row.path }}</td>
            <td class="px-3 py-2">{{ row.status }}</td>
          </tr>
          <tr v-if="rows.length === 0">
            <td colspan="4" class="px-3 py-8 text-center text-fg-faint">No mutating actions recorded yet.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
