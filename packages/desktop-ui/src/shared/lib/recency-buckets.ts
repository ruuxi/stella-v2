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

  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  return date.getTime()
}

const startOfMonth = (ms: number): number => {
  const date = new Date(startOfDay(ms))
  date.setDate(1)
  return date.getTime()
}

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

  if (timestampMs >= todayStart) return 'today'
  if (timestampMs >= todayStart - DAY_MS) return 'yesterday'
  if (timestampMs >= startOfWeek(nowMs)) return 'thisWeek'
  if (timestampMs >= startOfMonth(nowMs)) return 'thisMonth'
  return 'older'
}

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
