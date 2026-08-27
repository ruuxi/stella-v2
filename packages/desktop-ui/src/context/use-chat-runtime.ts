import { useContext } from 'react'
import {
  ChatRuntimeContext,
  type ChatRuntime,
} from '@/context/chat-runtime-context'

export function useChatRuntime(): ChatRuntime {
  const ctx = useContext(ChatRuntimeContext)
  if (!ctx) {
    throw new Error('useChatRuntime must be used within ChatRuntimeProvider')
  }
  return ctx
}
