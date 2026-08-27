/**
 * Imperative chat content-growth signals.
 *
 * Assistant text is no longer streamed, so there is no per-delta follow key
 * to track: a reply appears as one whole row. Everything that can extend the
 * live tail — a landed assistant message, the working indicator entering, an
 * agent card mounting, a late-loading image/map/thumbnail — announces itself
 * through `notifyChatContentGrowth`. Each `useChatScrollManagement` instance
 * subscribes and settles toward the new end of content when (and only when)
 * the user is parked at the tail.
 */
import { assistantScrollFollowKey } from '@/features/chat/streaming/streaming-types'

export { assistantScrollFollowKey }

type ScrollFollowSubscriber = () => void

const growthSubscribers = new Set<ScrollFollowSubscriber>()

/** Content below/inside the live tail grew. */
export const notifyChatContentGrowth = (): void => {
  for (const subscriber of growthSubscribers) {
    subscriber()
  }
}

/**
 * A rendered row's own subtree grew after layout (an inline image or map
 * iframe finished loading). Same channel as `notifyChatContentGrowth` — kept
 * as a distinct name so the call sites still read as "my content resized",
 * not "a new row landed".
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
