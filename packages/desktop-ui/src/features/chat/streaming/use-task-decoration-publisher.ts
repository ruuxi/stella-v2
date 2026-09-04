import { useEffect, useRef } from 'react'
import {
  getTaskActivityDecorationsSnapshot,
  subscribeTaskActivityDecorations,
} from '@/features/chat/streaming/task-decoration-store'

/**
 * Mirror the task-decoration store's per-thread statusText to the electron
 * main process so the desktop→mobile sync bridge can show the SAME mid-run
 * ticks the desktop tray shows. Progress events are never persisted, so this
 * snapshot push is the only way a phone learns what a running agent is doing
 * between its spawn and terminal rows. Subscribes only to activity changes;
 * reasoning chunks do not scan/serialize status snapshots or cross IPC.
 *
 * In the mobile WebView the shim exposes no `publishTaskDecoration` (it is
 * not a bridge capability), so this hook is a no-op there — only the desktop
 * window feeds the bridge.
 */
export function useTaskDecorationPublisher(): void {
  const lastPublishedRef = useRef<string>('')
  useEffect(() => {
    const publish = () => {
      const api = window.electronAPI?.localChat
      if (!api?.publishTaskDecoration) return
      const statusTextByAgentId: Record<string, string> = {}
      for (const [agentId, decoration] of Object.entries(
        getTaskActivityDecorationsSnapshot(),
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
        // Republish on the next change; the snapshot is replaced wholesale so
        // a dropped publish never leaves stale entries behind.
        lastPublishedRef.current = ''
      })
    }
    publish()
    return subscribeTaskActivityDecorations(publish)
  }, [])
}
