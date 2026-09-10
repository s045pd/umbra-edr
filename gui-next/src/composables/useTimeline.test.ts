import { describe, expect, it } from 'vitest'
import { eventsAround, eventsOfKindUntil, latestAtOrBefore, nearestOfKind, spanOf, type TimelineItem } from './useTimeline'

function item(kind: string, ts: string, id = kind + ts): TimelineItem {
  return { id, kind, timestamp: ts }
}

describe('timeline playhead', () => {
  const items: TimelineItem[] = [
    item('nav', '2026-09-08T10:00:00.000Z'),
    item('screenshot', '2026-09-08T10:00:02.000Z'),
    item('keyboard', '2026-09-08T10:00:03.000Z'),
    item('screenshot', '2026-09-08T10:00:10.000Z'),
    item('clipboard', '2026-09-08T10:00:11.000Z'),
  ]

  it('picks the nearest screenshot to the playhead', () => {
    const at = Date.parse('2026-09-08T10:00:04.000Z')
    const shot = nearestOfKind(items, at, 'screenshot')
    expect(shot?.timestamp).toBe('2026-09-08T10:00:02.000Z')
  })

  it('returns events inside the cinema window', () => {
    const at = Date.parse('2026-09-08T10:00:03.000Z')
    const around = eventsAround(items, at, 1500)
    expect(around.map((i) => i.kind)).toEqual(['screenshot', 'keyboard'])
  })

  it('computes the span of the reel', () => {
    const span = spanOf(items)
    expect(span?.start).toBe(Date.parse('2026-09-08T10:00:00.000Z'))
    expect(span?.end).toBe(Date.parse('2026-09-08T10:00:11.000Z'))
  })

  it('uses the last screenshot at or before the playhead, not a future frame', () => {
    const at = Date.parse('2026-09-08T10:00:09.000Z')
    const shot = latestAtOrBefore(items, at, 'screenshot')
    expect(shot?.timestamp).toBe('2026-09-08T10:00:02.000Z')
  })

  it('collects keyboard events up to the playhead', () => {
    const at = Date.parse('2026-09-08T10:00:10.000Z')
    const keys = eventsOfKindUntil(items, at, 'keyboard', 4)
    expect(keys.map((i) => i.timestamp)).toEqual(['2026-09-08T10:00:03.000Z'])
  })
})
