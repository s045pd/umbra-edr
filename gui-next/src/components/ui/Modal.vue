<script setup lang="ts">
// Centered modal. Mirrors Drawer's affordances (Esc to close, body
// scroll lock, Teleport to body, slotted footer) but the panel sits
// in the middle of the viewport instead of sliding in from the side.
import { onBeforeUnmount, onMounted, watch } from 'vue'

interface Props {
  open: boolean
  title?: string
  width?: 'sm' | 'md' | 'lg'
  closeOnBackdrop?: boolean
}
const props = withDefaults(defineProps<Props>(), {
  width: 'sm',
  closeOnBackdrop: true,
})
const emit = defineEmits<{ close: [] }>()

const widthClass = {
  sm: 'w-[420px]',
  md: 'w-[560px]',
  lg: 'w-[720px]',
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

watch(
  () => props.open,
  (v) => {
    document.body.style.overflow = v ? 'hidden' : ''
  },
)

function onBackdropClick(): void {
  if (props.closeOnBackdrop) emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]"
        @click="onBackdropClick"
      />
    </Transition>
    <Transition
      enter-active-class="transition duration-150"
      leave-active-class="transition duration-100"
      enter-from-class="opacity-0 scale-[0.97]"
      leave-to-class="opacity-0 scale-[0.97]"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
        role="dialog"
        aria-modal="true"
      >
        <section
          class="bg-bg-raised border border-border-subtle shadow-pop rounded-lg flex flex-col max-h-[calc(100vh-2rem)] pointer-events-auto"
          :class="widthClass[props.width]"
        >
          <header
            v-if="$slots.title || props.title"
            class="flex items-center justify-between h-11 px-4 border-b border-border-subtle shrink-0"
          >
            <h2 class="text-[13px] font-semibold tracking-wide truncate">
              <slot name="title">{{ props.title }}</slot>
            </h2>
            <button
              class="size-7 inline-flex items-center justify-center text-fg-muted hover:text-fg-base hover:bg-bg-hover rounded transition-colors"
              aria-label="Close dialog"
              @click="emit('close')"
            >
              <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </header>
          <div class="px-4 py-4 overflow-auto">
            <slot />
          </div>
          <footer
            v-if="$slots.footer"
            class="border-t border-border-subtle px-4 py-3 shrink-0 flex items-center gap-2 justify-end"
          >
            <slot name="footer" />
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
