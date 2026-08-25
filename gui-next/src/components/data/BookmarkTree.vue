<script setup lang="ts">
interface BookmarkNode {
  title?: string
  url?: string
  dateAdded?: number
  children?: BookmarkNode[]
}

const props = defineProps<{
  nodes: BookmarkNode[]
  collapsed: Set<string>
  depth: number
  parentKey: string
}>()

const emit = defineEmits<{ toggle: [key: string] }>()

function key(node: BookmarkNode, idx: number): string {
  return `${props.parentKey}/${idx}-${node.title ?? ''}`
}

function isCollapsed(k: string): boolean {
  return props.collapsed.has(k)
}

function onToggle(k: string): void {
  emit('toggle', k)
}

function childCount(node: BookmarkNode): number {
  if (!node.children) return 0
  let n = 0
  for (const c of node.children) {
    if (c.url) n++
    if (c.children) n += childCount(c)
  }
  return n
}
</script>

<template>
  <div>
    <template v-for="(node, i) in nodes" :key="key(node, i)">
      <!-- Folder -->
      <div v-if="node.children" class="select-none">
        <button
          class="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover/60 text-left transition-colors border-b border-border-subtle"
          :style="{ paddingLeft: (depth * 16 + 12) + 'px' }"
          @click="onToggle(key(node, i))"
        >
          <span
            class="text-[10px] text-fg-faint transition-transform w-3 inline-block"
            :class="isCollapsed(key(node, i)) ? '' : 'rotate-90'"
          >▶</span>
          <span class="text-[13px]">📁</span>
          <span class="text-[12px] font-medium truncate">{{ node.title || 'Untitled folder' }}</span>
          <span class="text-[10px] text-fg-faint mono ml-auto shrink-0">{{ childCount(node) }}</span>
        </button>
        <div v-if="!isCollapsed(key(node, i))">
          <BookmarkTree
            :nodes="node.children"
            :collapsed="collapsed"
            :depth="depth + 1"
            :parent-key="key(node, i)"
            @toggle="onToggle"
          />
        </div>
      </div>

      <!-- Leaf bookmark -->
      <div
        v-else-if="node.url"
        class="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover/60 border-b border-border-subtle last:border-b-0"
        :style="{ paddingLeft: (depth * 16 + 12) + 'px' }"
      >
        <span class="w-3" />
        <span class="text-[13px]">🔖</span>
        <div class="flex-1 min-w-0">
          <a
            :href="node.url"
            target="_blank"
            rel="noopener"
            class="text-[12px] truncate block hover:text-accent"
            :title="node.url"
          >{{ node.title || node.url }}</a>
          <div class="text-[10px] text-fg-faint mono truncate">{{ node.url }}</div>
        </div>
      </div>
    </template>
  </div>
</template>
