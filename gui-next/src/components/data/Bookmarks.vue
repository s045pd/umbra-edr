<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { bots as botsApi } from '@/api/endpoints'
import Field from '@/components/ui/Field.vue'
import Btn from '@/components/ui/Btn.vue'
import BookmarkTree from './BookmarkTree.vue'

export interface BookmarkNode {
  title?: string
  url?: string
  dateAdded?: number
  children?: BookmarkNode[]
}

const props = defineProps<{ botId: string }>()
const raw = ref<BookmarkNode[]>([])
const filter = ref('')
const loading = ref(false)
const collapsed = ref(new Set<string>())

function collectDeepKeys(nodes: BookmarkNode[], parentKey: string, depth: number, out: Set<string>): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (!node.children) continue
    const key = `${parentKey}/${i}-${node.title ?? ''}`
    if (depth >= 2) out.add(key)
    collectDeepKeys(node.children, key, depth + 1, out)
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    raw.value = ((await botsApi.field<BookmarkNode[]>(props.botId, 'bookmarks')) ?? []) as BookmarkNode[]
    const deep = new Set<string>()
    collectDeepKeys(raw.value, '', 0, deep)
    collapsed.value = deep
  } finally {
    loading.value = false
  }
}
watch(() => props.botId, load, { immediate: true })

function countLeaves(nodes: BookmarkNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.url) n++
    if (node.children) n += countLeaves(node.children)
  }
  return n
}

const totalBookmarks = computed(() => countLeaves(raw.value))

function matchesFilter(node: BookmarkNode, q: string): boolean {
  if (node.url) {
    return (
      (node.title?.toLowerCase().includes(q) ?? false) ||
      node.url.toLowerCase().includes(q)
    )
  }
  if (node.children) {
    return node.children.some((c) => matchesFilter(c, q))
  }
  return node.title?.toLowerCase().includes(q) ?? false
}

function filterTree(nodes: BookmarkNode[], q: string): BookmarkNode[] {
  if (!q) return nodes
  const out: BookmarkNode[] = []
  for (const node of nodes) {
    if (node.url) {
      if (matchesFilter(node, q)) out.push(node)
    } else if (node.children) {
      const filtered = filterTree(node.children, q)
      if (filtered.length > 0) {
        out.push({ ...node, children: filtered })
      }
    } else if (node.title?.toLowerCase().includes(q)) {
      out.push(node)
    }
  }
  return out
}

const filteredTree = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return filterTree(raw.value, q)
})

function toggle(key: string): void {
  const s = new Set(collapsed.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  collapsed.value = s
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2">
      <Field v-model="filter" placeholder="Filter bookmarks" size="sm" :block="false" />
      <span class="text-[11px] text-fg-faint mono ml-auto">
        {{ totalBookmarks }} bookmarks
      </span>
      <Btn size="sm" variant="ghost" :loading="loading" @click="load">Reload</Btn>
    </div>

    <div
      v-if="!loading && filteredTree.length === 0"
      class="text-center py-10 text-fg-faint text-[12px]"
    >
      No bookmarks reported.
    </div>

    <div v-else class="surface overflow-hidden">
      <BookmarkTree
        :nodes="filteredTree"
        :collapsed="collapsed"
        :depth="0"
        parent-key=""
        @toggle="toggle"
      />
    </div>
  </div>
</template>
