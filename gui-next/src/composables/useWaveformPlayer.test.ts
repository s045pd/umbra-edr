import { describe, expect, it } from 'vitest'
import { assemblePlayableWebM, concatBuffers, extractPeaks, isWebM, shouldStopSessionFetch } from './useWaveformPlayer'

describe('waveform helpers', () => {
  it('detects EBML WebM and rejects clusters', () => {
    expect(isWebM(new ArrayBuffer(0))).toBe(false)
    expect(isWebM(new Uint8Array([0x42, 0xd3, 0x81, 0x26]).buffer)).toBe(false)
    expect(isWebM(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]).buffer)).toBe(true)
  })

  it('concatenates timeslice bytes in order', () => {
    const joined = new Uint8Array(
      concatBuffers([new Uint8Array([1, 2]).buffer, new Uint8Array([3, 4, 5]).buffer]),
    )
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5])
  })

  it('extracts peak amplitude per bar', () => {
    const fake = {
      getChannelData: () => new Float32Array([0, 0.5, -1, 0.25, 0, 0, 0.1, -0.2]),
    } as unknown as AudioBuffer
    const peaks = extractPeaks(fake, 4)
    expect(peaks).toHaveLength(4)
    expect(peaks[1]).toBe(1)
  })

  it('assembles header plus clusters, drops orphan clusters, and stops at the next EBML', () => {
    const ebml = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]).buffer
    const cluster = (n: number) => new Uint8Array([0x42, 0xd3, 0x81, 0x26, n]).buffer
    expect(() => assemblePlayableWebM([cluster(1), cluster(2)])).toThrow(/header/)
    const out = assemblePlayableWebM([cluster(9), ebml(), cluster(1), cluster(2), ebml(), cluster(3)])
    expect(out.used).toBe(3)
    expect(out.truncated).toBe(true)
    expect(Array.from(new Uint8Array(out.data))).toEqual([
      0x1a, 0x45, 0xdf, 0xa3, 0x01,
      0x42, 0xd3, 0x81, 0x26, 1,
      0x42, 0xd3, 0x81, 0x26, 2,
    ])
  })

  it('caps assembled bytes so a 40-minute take does not decode in full', () => {
    const header = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00]).buffer
    const cluster = new Uint8Array(16).buffer
    const out = assemblePlayableWebM([header, cluster, cluster, cluster], 8 + 16)
    expect(out.used).toBe(2)
    expect(out.truncated).toBe(true)
    expect(out.data.byteLength).toBe(24)
  })

  it('does not stop fetching after a leading orphan cluster plus header', () => {
    const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]).buffer
    const cluster = new Uint8Array([0x42, 0xd3, 0x81, 0x26, 1]).buffer
    const out = assemblePlayableWebM([cluster, ebml])
    expect(out.used).toBe(1)
    expect(out.truncated).toBe(false)
    expect(shouldStopSessionFetch(out)).toBe(false)
    expect(shouldStopSessionFetch(assemblePlayableWebM([cluster, ebml, cluster, ebml]))).toBe(true)
  })
})
