export interface TimelineItem {
  id: string
  kind: string
  timestamp: string
  url?: string
  title?: string
  text?: string
  screenshot_id?: string
  extra?: Record<string, unknown>
}

export function itemTime(item: TimelineItem): number {
  const t = new Date(item.timestamp).getTime()
  return Number.isFinite(t) ? t : 0
}

export function latestAtOrBefore(items: TimelineItem[], at: number, kind: string): TimelineItem | null {
  let best: TimelineItem | null = null
  let bestT = Number.NEGATIVE_INFINITY
  for (const item of items) {
    if (item.kind !== kind) continue
    const t = itemTime(item)
    if (t <= at && t >= bestT) {
      best = item
      bestT = t
    }
  }
  return best
}

export function eventsOfKindUntil(items: TimelineItem[], at: number, kind: string, limit = 8): TimelineItem[] {
  return items
    .filter((item) => item.kind === kind && itemTime(item) <= at)
    .slice()
    .sort((a, b) => itemTime(a) - itemTime(b))
    .slice(-limit)
}

export function nearestOfKind(items: TimelineItem[], at: number, kind: string): TimelineItem | null {
  let best: TimelineItem | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const item of items) {
    if (item.kind !== kind) continue
    const dist = Math.abs(itemTime(item) - at)
    if (dist < bestDist) {
      best = item
      bestDist = dist
    }
  }
  return best
}

export function eventsAround(items: TimelineItem[], at: number, windowMs: number): TimelineItem[] {
  return items
    .filter((item) => Math.abs(itemTime(item) - at) <= windowMs)
    .slice()
    .sort((a, b) => itemTime(a) - itemTime(b))
}

export function spanOf(items: TimelineItem[]): { start: number; end: number } | null {
  if (items.length === 0) return null
  let start = itemTime(items[0])
  let end = start
  for (const item of items) {
    const t = itemTime(item)
    if (t < start) start = t
    if (t > end) end = t
  }
  return { start, end }
}
