/**
 * Imperative chat content-growth signal.
 *
 * Chat rows used to grow continuously as text streamed in, so scroll-follow
 * needed a keyed channel telling it which row to track. Replies arrive whole
 * now, so a row's height is settled the moment it mounts and there is nothing
 * to track: what remains is late growth from content that resolves after its
 * row lands — an inline image finishing its load, an agent completion card
 * mounting, the working indicator taking its slot. Those all say the same
 * thing ("the tail got taller"), so they share one channel and each scroll
 * surface decides for itself whether to act.
 */
import { assistantScrollFollowKey } from '@/features/chat/streaming/streaming-types'

export { assistantScrollFollowKey }

type ScrollFollowSubscriber = () => void

const growthSubscribers = new Set<ScrollFollowSubscriber>()

export const notifyChatContentGrowth = (): void => {
  for (const subscriber of growthSubscribers) {
    subscriber()
  }
}

/**
 * Kept as a name for the row-local case (an image inside a row finished
 * loading) even though it is the same signal — the call sites read better for
 * it, and the distinction may matter again.
 */
export const notifyAssistantScrollFollowLayoutChange = notifyChatContentGrowth

export const subscribeChatContentGrowth = (
  subscriber: ScrollFollowSubscriber,
): (() => void) => {
  growthSubscribers.add(subscriber)
  return () => {
    growthSubscribers.delete(subscriber)
  }
}
