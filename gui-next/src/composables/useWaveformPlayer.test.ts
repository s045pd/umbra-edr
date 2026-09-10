import { describe, expect, it } from 'vitest'
import { assemblePlayableWebM, concatBuffers, encodeWav16k, extractPeaks, isMP3, isWebM, paintWaveform, shouldStopSessionFetch } from './useWaveformPlayer'

describe('waveform helpers', () => {
  it('detects EBML WebM and rejects clusters', () => {
    expect(isWebM(new ArrayBuffer(0))).toBe(false)
    expect(isWebM(new Uint8Array([0x42, 0xd3, 0x81, 0x26]).buffer)).toBe(false)
    expect(isWebM(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]).buffer)).toBe(true)
  })

  it('detects MPEG frame sync and ID3', () => {
    expect(isMP3(new Uint8Array([0xff, 0xfb, 0x90, 0xc4]).buffer)).toBe(true)
    expect(isMP3(new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer)).toBe(true)
    expect(isMP3(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]).buffer)).toBe(false)
  })

  it('concatenates timeslice bytes in order', () => {
    const joined = new Uint8Array(
      concatBuffers([new Uint8Array([1, 2]).buffer, new Uint8Array([3, 4, 5]).buffer]),
    )
    expect(Array.from(joined)).toEqual([1, 2, 3, 4, 5])
  })

  it('encodes 16 kHz mono PCM WAV', () => {
    const samples = new Float32Array(48000)
    samples[0] = 1
    samples[1] = -1
    const fake = {
      sampleRate: 48000,
      duration: 1,
      getChannelData: () => samples,
    } as unknown as AudioBuffer
    const wav = new Uint8Array(encodeWav16k(fake, 1))
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE')
    expect(wav.byteLength).toBe(44 + 16000 * 2)
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
    expect(() => assemblePlayableWebM([cluster(1), cluster(2)])).toThrow(/unavailable/)
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

  it('paints played bars, rest bars, and a playhead at progress', () => {
    const fills: { style: string; x: number }[] = []
    const strokes: { style: string; x: number }[] = []
    let fillStyle = ''
    let strokeStyle = ''
    let pathX = 0
    const ctx = {
      clearRect() {},
      beginPath() {},
      get fillStyle() { return fillStyle },
      set fillStyle(v: string) { fillStyle = v },
      get strokeStyle() { return strokeStyle },
      set strokeStyle(v: string) { strokeStyle = v },
      lineWidth: 0,
      fillRect(x: number) { fills.push({ style: fillStyle, x }) },
      moveTo(x: number) { pathX = x },
      lineTo() {},
      stroke() { strokes.push({ style: strokeStyle, x: pathX }) },
    } as unknown as CanvasRenderingContext2D
    paintWaveform(ctx, {
      width: 100,
      height: 40,
      peaks: [1, 1, 1, 1],
      progress: 0.5,
      colors: { played: 'gold', rest: 'gray', playhead: 'white' },
    })
    expect(fills.map((f) => f.style)).toEqual(['gold', 'gold', 'gray', 'gray'])
    expect(strokes).toEqual([{ style: 'white', x: 50 }])
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

  it('concatenates MP3 frames instead of stopping at the next header', () => {
    const frame = (n: number) => new Uint8Array([0xff, 0xfb, 0x90, n]).buffer
    const out = assemblePlayableWebM([frame(1), frame(2), frame(3)])
    expect(out.used).toBe(3)
    expect(out.truncated).toBe(false)
    expect(Array.from(new Uint8Array(out.data))).toEqual([
      0xff, 0xfb, 0x90, 1, 0xff, 0xfb, 0x90, 2, 0xff, 0xfb, 0x90, 3,
    ])
  })
})
