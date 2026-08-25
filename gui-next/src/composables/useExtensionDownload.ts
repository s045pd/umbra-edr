import { computed, ref, watch } from 'vue'
import { api } from '@/api/client'
import {
  DEFAULT_WEBSOCKET_URL,
  isValidWebSocketUrl,
  loadWebSocketUrl,
  saveWebSocketUrl,
} from './websocketAddress'

export interface EmbedTarget {
  id: string
  name: string
}

const wsUrl = ref('')
const embed = ref('none')
const obfuscate = ref(true)
const targets = ref<EmbedTarget[]>([])
const loading = ref(false)
const initialized = ref(false)

const defaultWsUrl = computed(() => DEFAULT_WEBSOCKET_URL)

async function refreshTargets() {
  try {
    const res = await api.get<EmbedTarget[]>('/api/v1/extension/targets')
    targets.value = res ?? []
  } catch {
    targets.value = []
  }
}

async function init() {
  if (initialized.value) return
  initialized.value = true
  await refreshTargets()
}

function buildDownloadUrl(): string {
  const params = new URLSearchParams()
  params.set('ws_url', wsUrl.value || defaultWsUrl.value)
  if (embed.value && embed.value !== 'none') {
    params.set('embed', embed.value)
  }
  if (obfuscate.value) {
    params.set('obfuscate', '1')
  }
  return `/api/v1/extension/download?${params.toString()}`
}

const downloadUrl = computed(() => buildDownloadUrl())
const cookieSyncUrl = computed(() => '/api/v1/extension/download?embed=cookie-sync')

// ── Sensor confirm-before-download dialog state ──────────────
// Cookie Sync is a plain package and downloads directly. Only the Sensor
// package needs a WebSocket address embedded at packaging time.
type DownloadKind = 'main' | 'cookie-sync'
type DownloadPhase = 'idle' | 'packaging' | 'done' | 'error'

const confirmOpen = ref(false)
const draftWsUrl = ref('')
const downloading = ref(false)
const downloadPhase = ref<DownloadPhase>('idle')
const downloadError = ref('')
let abortCtrl: AbortController | null = null
const cookieSyncDownloading = ref(false)
const cookieSyncError = ref('')

const wsUrlError = computed(() => {
  const v = draftWsUrl.value.trim()
  if (!v) return 'WS address is required'
  if (!isValidWebSocketUrl(v)) return 'Enter a valid ws:// or wss:// address'
  return ''
})

const targetName = computed(() => {
  if (embed.value === 'none') return 'Standalone (no embed)'
  return (targets.value ?? []).find((t) => t.id === embed.value)?.name || embed.value
})

function loadSensorWebSocketUrl(): string {
  const savedWsUrl = loadWebSocketUrl()
  wsUrl.value = savedWsUrl
  return savedWsUrl
}

function openConfirm(): void {
  const savedWsUrl = loadSensorWebSocketUrl()
  draftWsUrl.value = savedWsUrl
  downloadPhase.value = 'idle'
  downloadError.value = ''
  downloading.value = false
  confirmOpen.value = true
}

async function fetchPackage(kind: DownloadKind, url: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, signal ? { signal } : undefined)

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Server returned ${res.status}`)
  }

  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition') ?? ''
  const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/)
  const filename = filenameMatch?.[1]
    ?? (kind === 'cookie-sync' ? 'cookie-sync.zip' : 'extension.zip')

  // Trigger browser save-as via blob URL.
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(blobUrl)
}

async function confirmDownload(): Promise<void> {
  if (wsUrlError.value || downloading.value) return

  const confirmed = draftWsUrl.value.trim()
  wsUrl.value = confirmed
  saveWebSocketUrl(confirmed)

  downloading.value = true
  downloadPhase.value = 'packaging'
  downloadError.value = ''
  const controller = new AbortController()
  abortCtrl = controller

  try {
    await fetchPackage('main', buildDownloadUrl(), controller.signal)

    downloadPhase.value = 'done'
    // Brief success flash then auto-close the Sensor dialog.
    setTimeout(() => { confirmOpen.value = false }, 1200)
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      downloadPhase.value = 'idle'
    } else {
      downloadPhase.value = 'error'
      downloadError.value = err instanceof Error ? err.message : 'Download failed'
    }
  } finally {
    downloading.value = false
    if (abortCtrl === controller) abortCtrl = null
  }
}

async function downloadCookieSync(): Promise<void> {
  // Cookie Sync never consumes Sensor configuration. If a Sensor dialog is
  // stale/open, close (and if necessary abort) it before the direct request.
  if (confirmOpen.value || abortCtrl) cancelDownload()
  if (cookieSyncDownloading.value) return

  cookieSyncDownloading.value = true
  cookieSyncError.value = ''
  try {
    await fetchPackage('cookie-sync', cookieSyncUrl.value)
  } catch (err: unknown) {
    cookieSyncError.value = err instanceof Error ? err.message : 'Download failed'
  } finally {
    cookieSyncDownloading.value = false
  }
}

function clearCookieSyncError(): void {
  cookieSyncError.value = ''
}

function cancelDownload(): void {
  if (abortCtrl) {
    abortCtrl.abort()
    abortCtrl = null
  }
  confirmOpen.value = false
}

// Reset state when dialog is dismissed.
watch(confirmOpen, (open) => {
  if (!open) {
    draftWsUrl.value = ''
    downloadPhase.value = 'idle'
    downloadError.value = ''
    downloading.value = false
  }
})

export function useExtensionDownload() {
  init()
  return {
    wsUrl,
    embed,
    obfuscate,
    targets,
    loading,
    defaultWsUrl,
    refreshTargets,
    downloadUrl,
    cookieSyncUrl,
    buildDownloadUrl,
    loadSensorWebSocketUrl,
    downloadCookieSync,
    cookieSyncDownloading,
    cookieSyncError,
    clearCookieSyncError,
    // Sensor confirm dialog
    confirmOpen,
    draftWsUrl,
    wsUrlError,
    targetName,
    openConfirm,
    confirmDownload,
    cancelDownload,
    downloading,
    downloadPhase,
    downloadError,
  }
}
