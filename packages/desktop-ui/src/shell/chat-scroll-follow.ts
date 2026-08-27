import { assistantScrollFollowKey } from '@/features/chat/streaming/streaming-types'

export { assistantScrollFollowKey }

type ScrollFollowSubscriber = () => void

const growthSubscribers = new Set<ScrollFollowSubscriber>()

export const notifyChatContentGrowth = (): void => {
  for (const subscriber of growthSubscribers) {
    subscriber()
  }
}

export const notifyAssistantScrollFollowLayoutChange = notifyChatContentGrowth

export const subscribeChatContentGrowth = (
  subscriber: ScrollFollowSubscriber,
): (() => void) => {
  growthSubscribers.add(subscriber)
  return () => {
    growthSubscribers.delete(subscriber)
  }
}
