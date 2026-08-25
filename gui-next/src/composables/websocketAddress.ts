export const DEFAULT_WEBSOCKET_URL = 'ws://127.0.0.1:4343'
export const WEBSOCKET_URL_STORAGE_KEY = 'umbra.extensionDownload.websocketUrl.v1'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function resolveStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage

  try {
    if (typeof window === 'undefined') return undefined
    return window.localStorage
  } catch {
    return undefined
  }
}

export function isValidWebSocketUrl(value: string): boolean {
  if (!value || /\s/.test(value)) return false

  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'ws:' || parsed.protocol === 'wss:')
      && parsed.hostname.length > 0
      && parsed.username === ''
      && parsed.password === ''
      && parsed.hash === ''
  } catch {
    return false
  }
}

export function loadWebSocketUrl(storage?: StorageLike): string {
  const target = resolveStorage(storage)
  if (!target) return DEFAULT_WEBSOCKET_URL

  try {
    const saved = target.getItem(WEBSOCKET_URL_STORAGE_KEY)
    return saved !== null && isValidWebSocketUrl(saved)
      ? saved
      : DEFAULT_WEBSOCKET_URL
  } catch {
    return DEFAULT_WEBSOCKET_URL
  }
}

export function saveWebSocketUrl(value: string, storage?: StorageLike): boolean {
  if (!isValidWebSocketUrl(value)) return false

  const target = resolveStorage(storage)
  if (!target) return false

  try {
    target.setItem(WEBSOCKET_URL_STORAGE_KEY, value)
    return true
  } catch {
    return false
  }
}
