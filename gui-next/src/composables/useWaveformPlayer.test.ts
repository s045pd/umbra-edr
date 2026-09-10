import { describe, expect, it } from 'vitest'
import { concatBuffers, extractPeaks, isWebM } from './useWaveformPlayer'

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
})
