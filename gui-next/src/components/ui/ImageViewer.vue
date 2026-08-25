<script setup lang="ts">
import { ref, computed, onBeforeUnmount, watch } from 'vue'
import { timeAgo } from '@/composables/useTime'

interface Props {
  src: string
  snapshotSrc?: string
  imageAt?: string
  alt?: string
  live?: boolean
  interval?: number
  quality?: string
}
const props = withDefaults(defineProps<Props>(), {
  alt: '', snapshotSrc: '', imageAt: '', live: false, interval: 2000, quality: 'high',
})
const emit = defineEmits<{
  'toggle-live': []
  'change-interval': [ms: number]
  'change-quality': [q: string]
}>()

const open = ref(false)
const zoom = ref(1)
const dragging = ref(false)
const dragStart = ref({ x: 0, y: 0 })
const offset = ref({ x: 0, y: 0 })
const offsetStart = ref({ x: 0, y: 0 })
const thumbKey = ref(0)
const viewerKey = ref(0)
let thumbTimer: ReturnType<typeof setInterval> | null = null
let viewerTimer: ReturnType<typeof setInterval> | null = null

const intervalOptions = [
  { label: '0.5s', value: 500 },
  { label: '1s', value: 1000 },
  { label: '2s', value: 2000 },
  { label: '5s', value: 5000 },
]

const snapshotFailed = ref(false)

const thumbSrc = computed(() => `${props.src}${props.src.includes('?') ? '&' : '?'}t=${thumbKey.value}`)
const viewerSrc = computed(() => {
  const useSnapshot = open.value && props.snapshotSrc && !snapshotFailed.value
  const base = useSnapshot ? props.snapshotSrc : props.src
  return `${base}${base.includes('?') ? '&' : '?'}t=${viewerKey.value}`
})

function onViewerError(): void {
  if (props.snapshotSrc && !snapshotFailed.value) {
    snapshotFailed.value = true
  }
}

const imageTime = computed(() => {
  if (!props.imageAt) return ''
  return timeAgo(props.imageAt)
})

const imageTimeExact = computed(() => {
  if (!props.imageAt) return ''
  try {
    return new Date(props.imageAt).toLocaleString()
  } catch { return '' }
})

function startThumbRefresh(): void {
  stopThumbRefresh()
  const ms = props.live ? Math.max(props.interval, 500) : 5000
  thumbTimer = setInterval(() => { thumbKey.value++ }, ms)
}

function stopThumbRefresh(): void {
  if (thumbTimer) { clearInterval(thumbTimer); thumbTimer = null }
}

function startViewerRefresh(): void {
  stopViewerRefresh()
  if (!props.live) return
  viewerTimer = setInterval(() => { viewerKey.value++ }, Math.max(props.interval, 500))
}

function stopViewerRefresh(): void {
  if (viewerTimer) { clearInterval(viewerTimer); viewerTimer = null }
}

function openViewer(): void {
  open.value = true
  zoom.value = 1
  offset.value = { x: 0, y: 0 }
  snapshotFailed.value = false
  viewerKey.value++
  startViewerRefresh()
}

function closeViewer(): void {
  open.value = false
  stopViewerRefresh()
}

function zoomIn(): void { zoom.value = Math.min(zoom.value * 1.3, 5) }
function zoomOut(): void {
  zoom.value = Math.max(zoom.value / 1.3, 0.5)
  if (zoom.value <= 1) offset.value = { x: 0, y: 0 }
}
function resetZoom(): void { zoom.value = 1; offset.value = { x: 0, y: 0 } }

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.deltaY < 0) zoomIn(); else zoomOut()
}

function onPointerDown(e: PointerEvent): void {
  if (zoom.value <= 1) return
  dragging.value = true
  dragStart.value = { x: e.clientX, y: e.clientY }
  offsetStart.value = { ...offset.value }
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  offset.value = {
    x: offsetStart.value.x + (e.clientX - dragStart.value.x),
    y: offsetStart.value.y + (e.clientY - dragStart.value.y),
  }
}

function onPointerUp(): void { dragging.value = false }

function onKey(e: KeyboardEvent): void {
  if (!open.value) return
  if (e.key === 'Escape') closeViewer()
  if (e.key === '+' || e.key === '=') zoomIn()
  if (e.key === '-') zoomOut()
  if (e.key === '0') resetZoom()
}

watch(open, (v) => {
  if (v) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})

watch(() => [props.live, props.interval], () => {
  startThumbRefresh()
  if (open.value) startViewerRefresh()
})

startThumbRefresh()

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  stopThumbRefresh()
  stopViewerRefresh()
})
</script>

<template>
  <!-- inline thumbnail — click to open viewer -->
  <div class="cursor-pointer group relative" @click="openViewer">
    <img :src="thumbSrc" :alt="alt" class="w-full h-full object-cover" />
    <span
      v-if="live"
      class="absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-danger/90 text-white"
    >
      <span class="size-1.5 rounded-full bg-white animate-pulse" />
      LIVE
    </span>
    <!-- timestamp badge bottom-right -->
    <span
      v-if="imageTime"
      class="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] mono"
      :title="imageTimeExact"
    >{{ imageTime }}</span>
    <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
      <span class="opacity-0 group-hover:opacity-100 text-white text-[11px] font-medium transition-opacity">
        Click to view
      </span>
    </div>
  </div>

  <!-- fullscreen viewer overlay -->
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      leave-active-class="transition-opacity duration-100"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm flex flex-col"
      >
        <!-- top toolbar -->
        <div class="shrink-0 flex items-center justify-between h-11 px-4 bg-black/40 border-b border-white/10">
          <div class="flex items-center gap-3">
            <!-- live toggle -->
            <button
              class="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-[11px] font-medium transition-colors"
              :class="live
                ? 'bg-danger/20 text-danger border border-danger/40 hover:bg-danger/30'
                : 'bg-white/10 text-white/70 border border-white/10 hover:bg-white/15 hover:text-white'"
              @click="emit('toggle-live')"
            >
              <span
                class="size-1.5 rounded-full"
                :class="live ? 'bg-danger animate-pulse' : 'bg-white/40'"
              />
              {{ live ? 'LIVE' : 'Live' }}
            </button>

            <!-- interval selector (visible when live) -->
            <div v-if="live" class="flex items-center gap-1">
              <button
                v-for="opt in intervalOptions"
                :key="opt.value"
                class="h-6 px-2 rounded text-[10px] font-medium transition-colors"
                :class="interval === opt.value
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70'"
                @click="emit('change-interval', opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>

            <!-- quality selector (visible when live) -->
            <div v-if="live" class="flex items-center gap-1 ml-2 pl-2 border-l border-white/10">
              <span class="text-[10px] text-white/40 mr-1">Quality</span>
              <button
                v-for="q in (['low', 'medium', 'high'] as const)"
                :key="q"
                class="h-6 px-2 rounded text-[10px] font-medium transition-colors capitalize"
                :class="quality === q
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70'"
                @click="emit('change-quality', q)"
              >
                {{ q }}
              </button>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <!-- zoom controls -->
            <div class="flex items-center gap-1 mr-2 pr-2 border-r border-white/10">
              <button
                class="size-7 inline-flex items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors text-[14px]"
                @click="zoomOut"
              >-</button>
              <button
                class="h-6 px-2 rounded text-[10px] text-white/50 hover:text-white hover:bg-white/10 transition-colors font-mono"
                @click="resetZoom"
              >{{ Math.round(zoom * 100) }}%</button>
              <button
                class="size-7 inline-flex items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors text-[14px]"
                @click="zoomIn"
              >+</button>
            </div>

            <button
              class="size-7 inline-flex items-center justify-center rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              @click="closeViewer"
            >
              <svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>
        </div>

        <!-- image area -->
        <div
          class="flex-1 overflow-hidden flex items-center justify-center"
          :class="zoom > 1 ? 'cursor-grab' : ''"
          @wheel.prevent="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
        >
          <img
            :src="viewerSrc"
            :alt="alt"
            class="max-w-full max-h-full select-none transition-transform duration-100"
            :class="dragging ? 'cursor-grabbing' : ''"
            :style="{ transform: `scale(${zoom}) translate(${offset.x / zoom}px, ${offset.y / zoom}px)` }"
            draggable="false"
            @error="onViewerError"
          />
        </div>

        <!-- status bar -->
        <div class="shrink-0 h-7 px-4 flex items-center justify-between bg-black/40 border-t border-white/10 text-[10px] text-white/40">
          <span v-if="live" class="flex items-center gap-1.5">
            <span class="size-1.5 rounded-full bg-danger animate-pulse" />
            Remote capture every {{ interval / 1000 }}s · {{ quality }} quality
          </span>
          <span v-else>Stored screenshot</span>
          <span class="flex items-center gap-3">
            <span v-if="imageTime" class="mono" :title="imageTimeExact">{{ imageTime }}</span>
            <span class="mono">{{ Math.round(zoom * 100) }}% · Scroll to zoom · Drag to pan</span>
          </span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
