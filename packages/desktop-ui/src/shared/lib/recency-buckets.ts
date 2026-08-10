/**
 * Calendar recency buckets for reverse-chronological lists.
 *
 * Boundaries are calendar edges, not rolling windows: something from 00:30
 * this morning reads as "Today", and 23:00 last night as "Yesterday", which
 * is what the labels promise. Weeks start Monday, so on a Monday the
 * "This week" bucket is empty (Sunday belongs to the previous week and falls
 * through to "This month") — `bucketByRecency` drops empty buckets.
 */

export type RecencyBucketId =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'thisMonth'
  | 'older'

export type RecencyBucket<T> = {
  id: RecencyBucketId
  items: T[]
}

const DAY_MS = 24 * 60 * 60 * 1000

const startOfDay = (ms: number): number => {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const startOfWeek = (ms: number): number => {
  const date = new Date(startOfDay(ms))
  // getDay(): 0 = Sunday. Shift so Monday is the first day of the week.
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return date.getTime()
}

const startOfMonth = (ms: number): number => {
  const date = new Date(startOfDay(ms))
  date.setDate(1)
  return date.getTime()
}

/** Fixed display order; ids double as the `shell.recency.*` i18n keys. */
export const RECENCY_BUCKET_ORDER: readonly RecencyBucketId[] = [
  'today',
  'yesterday',
  'thisWeek',
  'thisMonth',
  'older',
]

export const recencyBucketId = (
  timestampMs: number,
  nowMs: number,
): RecencyBucketId => {
  const todayStart = startOfDay(nowMs)
  // Future timestamps (clock skew, an optimistic stamp) read as the freshest
  // bucket rather than falling off the end of the list.
  if (timestampMs >= todayStart) return 'today'
  if (timestampMs >= todayStart - DAY_MS) return 'yesterday'
  if (timestampMs >= startOfWeek(nowMs)) return 'thisWeek'
  if (timestampMs >= startOfMonth(nowMs)) return 'thisMonth'
  return 'older'
}

/**
 * Split already newest-first items into calendar buckets, preserving the
 * incoming order within each bucket and dropping empty ones.
 */
export const bucketByRecency = <T>(
  items: readonly T[],
  getTimestampMs: (item: T) => number,
  nowMs: number,
): RecencyBucket<T>[] => {
  const byId = new Map<RecencyBucketId, T[]>()
  for (const item of items) {
    const id = recencyBucketId(getTimestampMs(item), nowMs)
    const existing = byId.get(id)
    if (existing) existing.push(item)
    else byId.set(id, [item])
  }
  return RECENCY_BUCKET_ORDER.flatMap((id) => {
    const bucketItems = byId.get(id)
    return bucketItems ? [{ id, items: bucketItems }] : []
  })
}
