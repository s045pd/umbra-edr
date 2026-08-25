<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  total: number
  page: number
  pageSize?: number
}

const props = withDefaults(defineProps<Props>(), {
  pageSize: 50,
})

const emit = defineEmits<{ 'update:page': [page: number] }>()

const totalPages = computed(() =>
  props.total <= 0 ? 1 : Math.ceil(props.total / props.pageSize),
)

const rangeStart = computed(() => props.page * props.pageSize + 1)

const rangeEnd = computed(() =>
  Math.min((props.page + 1) * props.pageSize, props.total),
)

const isFirst = computed(() => props.page <= 0)
const isLast = computed(() => props.page >= totalPages.value - 1)

const visible = computed(() => props.total > props.pageSize)

function go(target: number): void {
  const clamped = Math.max(0, Math.min(target, totalPages.value - 1))
  if (clamped !== props.page) emit('update:page', clamped)
}
</script>

<template>
  <div v-if="visible" class="inline-flex items-center gap-2 text-[11px] mono text-fg-faint select-none">
    <span class="tabular-nums">
      {{ rangeStart }}-{{ rangeEnd }}
      <span class="text-fg-faint/60">of</span>
      {{ total.toLocaleString() }}
    </span>

    <span class="inline-flex items-center gap-0.5">
      <button
        :disabled="isFirst"
        class="h-6 w-6 inline-flex items-center justify-center rounded border border-border-subtle bg-bg-overlay text-fg-faint hover:text-fg-base transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="First page"
        @click="go(0)"
      >&laquo;</button>
      <button
        :disabled="isFirst"
        class="h-6 w-6 inline-flex items-center justify-center rounded border border-border-subtle bg-bg-overlay text-fg-faint hover:text-fg-base transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="Previous page"
        @click="go(page - 1)"
      >&lsaquo;</button>
      <button
        :disabled="isLast"
        class="h-6 w-6 inline-flex items-center justify-center rounded border border-border-subtle bg-bg-overlay text-fg-faint hover:text-fg-base transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="Next page"
        @click="go(page + 1)"
      >&rsaquo;</button>
      <button
        :disabled="isLast"
        class="h-6 w-6 inline-flex items-center justify-center rounded border border-border-subtle bg-bg-overlay text-fg-faint hover:text-fg-base transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="Last page"
        @click="go(totalPages - 1)"
      >&raquo;</button>
    </span>

    <span class="tabular-nums text-fg-faint/60">
      {{ page + 1 }}/{{ totalPages }}
    </span>
  </div>
</template>
