import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEBSOCKET_URL,
  WEBSOCKET_URL_STORAGE_KEY,
  isValidWebSocketUrl,
  loadWebSocketUrl,
  saveWebSocketUrl,
  websocketUrlHint,
} from './websocketAddress'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storageWith(value: string | null): StorageLike {
  return {
    getItem: () => value,
    setItem: () => undefined,
  }
}

describe('WebSocket address defaults and loading', () => {
  it('uses the fixed local WebSocket default when storage is unavailable', () => {
    expect(DEFAULT_WEBSOCKET_URL).toBe('ws://127.0.0.1:4343')
    expect(WEBSOCKET_URL_STORAGE_KEY).toBe('umbra.extensionDownload.websocketUrl.v1')
    expect(loadWebSocketUrl(undefined)).toBe(DEFAULT_WEBSOCKET_URL)
  })

  it.each([
    'ws://127.0.0.1:4343',
    'wss://socket.example.test/rpc?tenant=1',
  ])('restores a valid saved address exactly: %s', (value) => {
    expect(loadWebSocketUrl(storageWith(value))).toBe(value)
  })

  it.each([
    '',
    '   ',
    '127.0.0.1:4343',
    ' ws://127.0.0.1:4343',
    'ws://127.0.0.1:4343 ',
    'ws://socket.example.test/a b',
    'http://socket.example.test',
    'ws://',
    'ws://user@socket.example.test',
    'ws://user:secret@socket.example.test',
    'ws://socket.example.test/rpc#fragment',
    'ws://socket.example.test:not-a-port',
    'ws://socket.example.test:65536',
  ])('falls back when the saved value is unusable: %j', (value) => {
    expect(loadWebSocketUrl(storageWith(value))).toBe(DEFAULT_WEBSOCKET_URL)
  })

  it('falls back without throwing when storage reads fail', () => {
    const throwingStorage: StorageLike = {
      getItem: () => { throw new Error('read denied') },
      setItem: () => undefined,
    }

    expect(() => loadWebSocketUrl(throwingStorage)).not.toThrow()
    expect(loadWebSocketUrl(throwingStorage)).toBe(DEFAULT_WEBSOCKET_URL)
  })
})

describe('WebSocket address validation', () => {
  it.each([
    'ws://127.0.0.1:4343',
    'ws://localhost',
    'wss://socket.example.test/rpc?tenant=1',
  ])('accepts a valid ws or wss URL: %s', (value) => {
    expect(isValidWebSocketUrl(value)).toBe(true)
  })

  it.each([
    '',
    '127.0.0.1:4343',
    ' ws://127.0.0.1:4343',
    'ws://127.0.0.1:4343 ',
    'ws://socket.example.test/a b',
    'http://socket.example.test',
    'https://socket.example.test',
    'ws://',
    'ws://user@socket.example.test',
    'wss://user:secret@socket.example.test',
    'ws://socket.example.test/path#fragment',
    'ws://socket.example.test:not-a-port',
    'ws://socket.example.test:65536',
  ])('rejects an invalid WebSocket URL: %j', (value) => {
    expect(isValidWebSocketUrl(value)).toBe(false)
  })
})

describe('WebSocket address hints', () => {
  it('warns when wss is used on the plaintext bot port', () => {
    expect(websocketUrlHint('wss://sensor.example.test:4343/')).toMatch(/ws:\/\/sensor\.example\.test:4343/)
    expect(websocketUrlHint('wss://sensor.example.test:4343')).toMatch(/plaintext/)
  })

  it('does not warn for plaintext ws on 4343 or TLS on another port', () => {
    expect(websocketUrlHint('ws://sensor.example.test:4343')).toBe('')
    expect(websocketUrlHint('wss://socket.example.test/rpc')).toBe('')
    expect(websocketUrlHint('not-a-url')).toBe('')
  })
})

describe('WebSocket address persistence', () => {
  it('writes a valid address unchanged using only the versioned key', () => {
    const writes: Array<[string, string]> = []
    const storage: StorageLike = {
      getItem: () => null,
      setItem: (key, value) => { writes.push([key, value]) },
    }
    const value = 'wss://socket.example.test/rpc?tenant=1'

    expect(saveWebSocketUrl(value, storage)).toBe(true)
    expect(writes).toEqual([[WEBSOCKET_URL_STORAGE_KEY, value]])
  })

  it('does not normalize or save invalid untrimmed input', () => {
    const writes: Array<[string, string]> = []
    const storage: StorageLike = {
      getItem: () => null,
      setItem: (key, value) => { writes.push([key, value]) },
    }

    expect(saveWebSocketUrl(' ws://127.0.0.1:4343 ', storage)).toBe(false)
    expect(writes).toEqual([])
  })

  it('returns false without throwing when storage writes fail', () => {
    const throwingStorage: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded') },
    }

    expect(() => saveWebSocketUrl('ws://127.0.0.1:4343', throwingStorage)).not.toThrow()
    expect(saveWebSocketUrl('ws://127.0.0.1:4343', throwingStorage)).toBe(false)
  })
})
