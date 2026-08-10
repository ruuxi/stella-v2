/**
 * Calendar recency buckets for finished Activity rows.
 *
 * The sidebar's Activity index is a flat reverse-chronological list, which
 * reads as one undifferentiated run once a conversation has any history.
 * Bucketing by calendar boundaries (not rolling 24h windows) matches how the
 * labels read: something finished at 00:30 is "Today", not "yesterday-ish".
 *
 * Weeks start Monday, so on a Monday the "This week" bucket is empty (Sunday
 * belongs to the previous week and falls through to "This month") — empty
 * buckets are dropped by `bucketActivityRowsByRecency`.
 */
import {
  getActivityRowCompletedAtMs,
  type ActivityRow,
} from '@/features/chat/lib/event-transforms'

export type ActivityRecencyBucketId =
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'thisMonth'
  | 'older'

export type ActivityRecencyBucket = {
  id: ActivityRecencyBucketId
  rows: ActivityRow[]
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
  const offsetDays = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - offsetDays)
  return date.getTime()
}

const startOfMonth = (ms: number): number => {
  const date = new Date(startOfDay(ms))
  date.setDate(1)
  return date.getTime()
}

/** Bucket order is fixed; ids double as the `shell.workspace.recency.*` keys. */
const BUCKET_ORDER: readonly ActivityRecencyBucketId[] = [
  'today',
  'yesterday',
  'thisWeek',
  'thisMonth',
  'older',
]

export const activityRecencyBucketId = (
  timestampMs: number,
  nowMs: number,
): ActivityRecencyBucketId => {
  const todayStart = startOfDay(nowMs)
  // Future timestamps (clock skew, an optimistic completion stamp) read as
  // the freshest bucket rather than falling off the end of the list.
  if (timestampMs >= todayStart) return 'today'
  if (timestampMs >= todayStart - DAY_MS) return 'yesterday'
  if (timestampMs >= startOfWeek(nowMs)) return 'thisWeek'
  if (timestampMs >= startOfMonth(nowMs)) return 'thisMonth'
  return 'older'
}

/**
 * Split rows (already sorted newest-first) into calendar buckets, preserving
 * the incoming order within each bucket and dropping empty ones.
 */
export const bucketActivityRowsByRecency = (
  rows: readonly ActivityRow[],
  nowMs: number,
): ActivityRecencyBucket[] => {
  const byId = new Map<ActivityRecencyBucketId, ActivityRow[]>()
  for (const row of rows) {
    const id = activityRecencyBucketId(getActivityRowCompletedAtMs(row), nowMs)
    const existing = byId.get(id)
    if (existing) existing.push(row)
    else byId.set(id, [row])
  }
  return BUCKET_ORDER.flatMap((id) => {
    const bucketRows = byId.get(id)
    return bucketRows ? [{ id, rows: bucketRows }] : []
  })
}
