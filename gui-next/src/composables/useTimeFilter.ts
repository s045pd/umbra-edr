import { ref, computed, readonly } from 'vue'

const startMs = ref<number | null>(null)
const endMs = ref<number | null>(null)

const isActive = computed(() => startMs.value !== null && endMs.value !== null)

const label = computed(() => {
  if (!isActive.value || startMs.value === null || endMs.value === null) return ''
  const fmt = (ms: number) => {
    const d = new Date(ms)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    return `${date} ${time}`
  }
  return `${fmt(startMs.value)} → ${fmt(endMs.value)}`
})

function setRange(start: number, end: number): void {
  startMs.value = Math.min(start, end)
  endMs.value = Math.max(start, end)
}

function clearRange(): void {
  startMs.value = null
  endMs.value = null
}

function inRange(timestampMs: number): boolean {
  if (!isActive.value || startMs.value === null || endMs.value === null) return true
  return timestampMs >= startMs.value && timestampMs <= endMs.value
}

export function useTimeFilter() {
  return {
    startMs: readonly(startMs),
    endMs: readonly(endMs),
    isActive,
    label,
    setRange,
    clearRange,
    inRange,
    _startMs: startMs,
    _endMs: endMs,
  }
}
