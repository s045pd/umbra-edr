export function isWebM(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false
  const h = new Uint8Array(buf.slice(0, 4))
  return h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3
}

export function isMP3(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 3) return false
  const h = new Uint8Array(buf.slice(0, 3))
  if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) return true
  return h[0] === 0xff && (h[1] & 0xe0) === 0xe0
}

export function isPlayableAudio(buf: ArrayBuffer): boolean {
  return isWebM(buf) || isMP3(buf)
}

export function concatBuffers(parts: ArrayBuffer[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(new Uint8Array(p), offset)
    offset += p.byteLength
  }
  return out.buffer
}

export const PLAYABLE_WEBM_MAX_BYTES = 8 * 1024 * 1024

export type AssembledWebM = {
  data: ArrayBuffer
  used: number
  truncated: boolean
}

// MediaRecorder timeslices: first blob is EBML, later blobs are Clusters.
// Complete 10s files: every blob is EBML. Concatenating two EBML files is
// not a valid WebM, so stop at the next header. Cap size so a 40-minute
// take does not decode 500MB of PCM in the tab.
export function assemblePlayableWebM(
  bufs: ArrayBuffer[],
  maxBytes = PLAYABLE_WEBM_MAX_BYTES,
): AssembledWebM {
  const header = bufs.findIndex(isPlayableAudio)
  if (header < 0) {
    throw new Error('session audio unavailable — no playable audio for this take is on disk')
  }
  const mpeg = isMP3(bufs[header])
  const parts: ArrayBuffer[] = [bufs[header]]
  let n = bufs[header].byteLength
  let used = 1
  for (let i = header + 1; i < bufs.length; i++) {
    const next = bufs[i]
    if (n + next.byteLength > maxBytes) break
    if (mpeg) {
      if (!isMP3(next)) break
    } else if (isWebM(next)) {
      break
    }
    parts.push(next)
    n += next.byteLength
    used += 1
  }
  return {
    data: concatBuffers(parts),
    used,
    truncated: header + used < bufs.length,
  }
}

export function shouldStopSessionFetch(
  assembled: AssembledWebM,
  maxBytes = PLAYABLE_WEBM_MAX_BYTES,
): boolean {
  return assembled.truncated || assembled.data.byteLength >= maxBytes
}

export function extractPeaks(buffer: AudioBuffer, bars = 240): number[] {
  const data = buffer.getChannelData(0)
  const block = Math.max(1, Math.floor(data.length / bars))
  const peaks: number[] = []
  for (let i = 0; i < bars; i++) {
    let max = 0
    const start = i * block
    for (let j = 0; j < block && start + j < data.length; j++) {
      const v = Math.abs(data[start + j] ?? 0)
      if (v > max) max = v
    }
    peaks.push(max)
  }
  return peaks
}

function concatAudioBuffers(ctx: AudioContext, buffers: AudioBuffer[]): AudioBuffer {
  const rate = buffers[0]?.sampleRate ?? ctx.sampleRate
  const channels = Math.max(1, ...buffers.map((b) => b.numberOfChannels))
  const length = buffers.reduce((n, b) => n + b.length, 0)
  const out = ctx.createBuffer(channels, length, rate)
  let offset = 0
  for (const buf of buffers) {
    for (let ch = 0; ch < channels; ch++) {
      const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1))
      out.getChannelData(ch).set(src, offset)
    }
    offset += buf.length
  }
  return out
}

export type WaveformEngine = {
  load: (bufs: ArrayBuffer[]) => Promise<{ duration: number; peaks: number[] }>
  play: () => Promise<void>
  pause: () => void
  seek: (ratio: number) => void
  stop: () => void
  close: () => void
  getCurrentTime: () => number
  getDuration: () => number
}

export function createWaveformEngine(): WaveformEngine {
  let ctx: AudioContext | null = null
  let buffer: AudioBuffer | null = null
  let source: AudioBufferSourceNode | null = null
  let startedAt = 0
  let offset = 0
  let playing = false

  function ensureCtx(): AudioContext {
    if (!ctx) ctx = new AudioContext()
    return ctx
  }

  function stopSource(): void {
    if (source) {
      try {
        source.onended = null
        source.stop()
      } catch {
        // already stopped
      }
      source.disconnect()
      source = null
    }
    playing = false
  }

  async function decode(bufs: ArrayBuffer[]): Promise<AudioBuffer> {
    const ac = ensureCtx()
    const nonempty = bufs.filter((b) => b.byteLength > 0)
    if (nonempty.length === 0) {
      throw new Error('session audio unavailable')
    }
    if (isMP3(nonempty[0])) {
      const joined = concatBuffers(nonempty.filter(isMP3))
      return await ac.decodeAudioData(joined.slice(0))
    }
    const header = nonempty.findIndex(isWebM)
    if (header === -1) {
      throw new Error('session audio unavailable')
    }
    const complete = nonempty.every(isWebM)
    if (complete) {
      const decoded: AudioBuffer[] = []
      for (const part of nonempty) {
        decoded.push(await ac.decodeAudioData(part.slice(0)))
      }
      return concatAudioBuffers(ac, decoded)
    }
    const joined = concatBuffers(nonempty.slice(header))
    try {
      return await ac.decodeAudioData(joined.slice(0))
    } catch {
      return await ac.decodeAudioData(nonempty[header].slice(0))
    }
  }

  return {
    async load(bufs: ArrayBuffer[]) {
      stopSource()
      offset = 0
      buffer = await decode(bufs)
      return { duration: buffer.duration, peaks: extractPeaks(buffer) }
    },
    async play() {
      if (!buffer) throw new Error('nothing to play')
      const ac = ensureCtx()
      if (ac.state === 'suspended') await ac.resume()
      stopSource()
      source = ac.createBufferSource()
      source.buffer = buffer
      source.connect(ac.destination)
      const startOffset = Math.min(Math.max(0, offset), Math.max(0, buffer.duration - 0.05))
      source.start(0, startOffset)
      startedAt = ac.currentTime - startOffset
      playing = true
      source.onended = () => {
        if (!playing) return
        playing = false
        offset = buffer ? buffer.duration : 0
        source = null
      }
    },
    pause() {
      if (!playing || !ctx) return
      offset = Math.min(ctx.currentTime - startedAt, buffer?.duration ?? 0)
      stopSource()
    },
    seek(ratio: number) {
      const dur = buffer?.duration ?? 0
      offset = Math.min(Math.max(0, ratio), 1) * dur
      if (playing) void this.play()
    },
    stop() {
      offset = 0
      stopSource()
    },
    close() {
      offset = 0
      stopSource()
      buffer = null
      if (ctx) {
        void ctx.close()
        ctx = null
      }
    },
    getCurrentTime() {
      if (playing && ctx) {
        return Math.min(ctx.currentTime - startedAt, buffer?.duration ?? 0)
      }
      return offset
    },
    getDuration() {
      return buffer?.duration ?? 0
    },
  }
}
