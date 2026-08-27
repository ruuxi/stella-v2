import { useEffect, useRef } from 'react'
import {
  getTaskDecorationsSnapshot,
  subscribeTaskDecorations,
} from '@/features/chat/streaming/task-decoration-store'

export function useTaskDecorationPublisher(): void {
  const lastPublishedRef = useRef<string>('')
  useEffect(() => {
    const publish = () => {
      const api = window.electronAPI?.localChat
      if (!api?.publishTaskDecoration) return
      const statusTextByAgentId: Record<string, string> = {}
      for (const [agentId, decoration] of Object.entries(
        getTaskDecorationsSnapshot(),
      )) {
        if (
          decoration.status !== 'completed' &&
          decoration.status !== 'error' &&
          decoration.status !== 'canceled' &&
          decoration.statusText
        ) {
          statusTextByAgentId[agentId] = decoration.statusText
        }
      }
      const serialized = JSON.stringify(statusTextByAgentId)
      if (serialized === lastPublishedRef.current) return
      lastPublishedRef.current = serialized
      void api.publishTaskDecoration({ statusTextByAgentId }).catch(() => {

        lastPublishedRef.current = ''
      })
    }
    publish()
    return subscribeTaskDecorations(publish)
  }, [])
}
