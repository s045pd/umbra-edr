<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  audioEl: HTMLAudioElement | null
  active: boolean
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let source: MediaElementAudioSourceNode | null = null
let raf = 0
let hookedEl: HTMLAudioElement | null = null

function accent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || 'oklch(83% 0.165 84)'
}

function draw(): void {
  const c = canvas.value
  if (!c || !analyser) return
  const g = c.getContext('2d')
  if (!g) return
  const w = (c.width = Math.max(1, c.clientWidth * devicePixelRatio))
  const h = (c.height = Math.max(1, c.clientHeight * devicePixelRatio))
  const bins = analyser.frequencyBinCount
  const data = new Uint8Array(bins)
  analyser.getByteFrequencyData(data)
  g.clearRect(0, 0, w, h)
  const gap = Math.max(1, Math.floor(w / bins / 8))
  const barW = Math.max(1, w / bins - gap)
  g.fillStyle = accent()
  for (let i = 0; i < bins; i++) {
    const bh = (data[i] / 255) * h
    g.fillRect(i * (barW + gap), h - bh, barW, bh)
  }
  raf = requestAnimationFrame(draw)
}

async function connect(): Promise<void> {
  const el = props.audioEl
  if (!el || !props.active) return
  if (!audioCtx) audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') await audioCtx.resume()
  if (hookedEl !== el) {
    source = audioCtx.createMediaElementSource(el)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    analyser.connect(audioCtx.destination)
    hookedEl = el
  }
  cancelAnimationFrame(raf)
  draw()
}

watch(
  () => [props.audioEl, props.active] as const,
  () => {
    if (props.active) void connect()
    else cancelAnimationFrame(raf)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})
</script>

<template>
  <canvas ref="canvas" class="w-full h-16 block bg-bg-base" />
</template>
