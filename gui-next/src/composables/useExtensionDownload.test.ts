import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'umbra.extensionDownload.websocketUrl.v1'
const isValidWebSocketUrlSpy = vi.hoisted(() => vi.fn())

vi.mock('./websocketAddress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./websocketAddress')>()
  return {
    ...actual,
    isValidWebSocketUrl(value: string): boolean {
      isValidWebSocketUrlSpy(value)
      return actual.isValidWebSocketUrl(value)
    },
  }
})

interface FakeBrowserOptions {
  initialSaved?: string | null
  throwOnWrite?: boolean
}

function installBrowserFakes(options: FakeBrowserOptions = {}) {
  let saved = options.initialSaved ?? null
  const reads: string[] = []
  const writes: Array<[string, string]> = []
  const downloadUrls: string[] = []
  const events: string[] = []

  const storage = {
    getItem(key: string): string | null {
      reads.push(key)
      return key === STORAGE_KEY ? saved : null
    },
    setItem(key: string, value: string): void {
      events.push('save')
      if (options.throwOnWrite) throw new Error('storage denied')
      writes.push([key, value])
      saved = value
    },
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/v1/extension/targets') {
      return new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith('/api/v1/extension/download?')) {
      events.push('fetch')
      downloadUrls.push(url)
      throw new Error('packaging unavailable')
    }
    throw new Error(`Unexpected request: ${url}`)
  })

  vi.stubGlobal('window', {
    location: {
      protocol: 'https:',
      hostname: 'panel.example.test',
    },
    localStorage: storage,
  })
  vi.stubGlobal('fetch', fetchMock)

  return { downloadUrls, events, fetchMock, reads, writes }
}

beforeEach(() => {
  vi.resetModules()
  isValidWebSocketUrlSpy.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useExtensionDownload WebSocket confirmation', () => {
  it('starts with the fixed default and typing and cancelling does not persist', async () => {
    const { writes } = installBrowserFakes()
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    download.openConfirm()
    expect(download.draftWsUrl.value).toBe('ws://127.0.0.1:4343')

    download.draftWsUrl.value = 'wss://typed.example.test/rpc'
    download.cancelDownload()

    expect(writes).toEqual([])
  })

  it('trims and persists before the Sensor fetch even when fetch fails', async () => {
    const { downloadUrls, events, writes } = installBrowserFakes()
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    download.openConfirm()
    download.embed.value = 'host-extension'
    download.draftWsUrl.value = '  wss://socket.example.test/rpc?tenant=1  '
    await download.confirmDownload()

    expect(writes).toEqual([[
      STORAGE_KEY,
      'wss://socket.example.test/rpc?tenant=1',
    ]])
    expect(events).toEqual(['save', 'fetch'])
    expect(download.downloadPhase.value).toBe('error')

    const request = new URL(downloadUrls[0], 'https://panel.example.test')
    expect(request.searchParams.get('ws_url')).toBe('wss://socket.example.test/rpc?tenant=1')
    expect(request.searchParams.get('embed')).toBe('host-extension')
    expect(request.searchParams.get('obfuscate')).toBe('1')

  })

  it('downloads Cookie Sync directly without opening the WebSocket dialog or touching WebSocket storage', async () => {
    const { downloadUrls, events, reads, writes } = installBrowserFakes({
      initialSaved: 'wss://saved.example.test/socket',
    })
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    download.wsUrl.value = 'not-a-websocket-address'
    await download.downloadCookieSync()

    expect(download.confirmOpen.value).toBe(false)
    expect(download.wsUrl.value).toBe('not-a-websocket-address')
    expect(download.draftWsUrl.value).toBe('')
    expect(reads).toEqual([])
    expect(writes).toEqual([])
    expect(isValidWebSocketUrlSpy).not.toHaveBeenCalled()
    expect(events).toEqual(['fetch'])
    expect(downloadUrls).toHaveLength(1)
    expect(downloadUrls[0]).toBe('/api/v1/extension/download?embed=cookie-sync')
    expect(download.cookieSyncError.value).toBe('packaging unavailable')
    expect(download.downloadPhase.value).toBe('idle')
  })

  it('closes a stale Sensor dialog before starting a direct Cookie Sync download', async () => {
    const { reads, writes } = installBrowserFakes()
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    download.confirmOpen.value = true
    download.draftWsUrl.value = 'not-a-websocket-address'
    await download.downloadCookieSync()

    expect(download.confirmOpen.value).toBe(false)
    expect(reads).toEqual([])
    expect(writes).toEqual([])
    expect(download.cookieSyncError.value).toBe('packaging unavailable')
  })

  it('invalid confirmation neither persists nor starts a package request', async () => {
    const { downloadUrls, writes } = installBrowserFakes()
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    download.openConfirm()
    download.draftWsUrl.value = 'ws://user:secret@socket.example.test/rpc#fragment'

    expect(download.wsUrlError.value).not.toBe('')
    await download.confirmDownload()

    expect(writes).toEqual([])
    expect(downloadUrls).toEqual([])
  })

  it('a localStorage write failure does not block the package request', async () => {
    const { downloadUrls, events } = installBrowserFakes({ throwOnWrite: true })
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    download.openConfirm()
    download.draftWsUrl.value = 'wss://socket.example.test/rpc'
    await download.confirmDownload()

    expect(events).toEqual(['save', 'fetch'])
    expect(downloadUrls).toHaveLength(1)
  })

  it('omits Sensor obfuscation and embed parameters when they are disabled', async () => {
    const { downloadUrls } = installBrowserFakes({
      initialSaved: 'wss://saved.example.test/socket',
    })
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    download.openConfirm()
    download.embed.value = 'none'
    download.obfuscate.value = false
    await download.confirmDownload()

    const request = new URL(downloadUrls[0], 'https://panel.example.test')
    expect(request.searchParams.get('ws_url')).toBe('wss://saved.example.test/socket')
    expect(request.searchParams.has('embed')).toBe(false)
    expect(request.searchParams.has('obfuscate')).toBe(false)
  })

  it('loads the saved WebSocket address lazily for a non-download Sensor operation', async () => {
    const { reads, writes } = installBrowserFakes({
      initialSaved: 'wss://saved.example.test/inject',
    })
    const { useExtensionDownload } = await import('./useExtensionDownload')
    const download = useExtensionDownload()

    expect(reads).toEqual([])
    expect(download.loadSensorWebSocketUrl()).toBe('wss://saved.example.test/inject')
    expect(download.wsUrl.value).toBe('wss://saved.example.test/inject')
    expect(reads).toEqual([STORAGE_KEY])
    expect(writes).toEqual([])
  })
})
