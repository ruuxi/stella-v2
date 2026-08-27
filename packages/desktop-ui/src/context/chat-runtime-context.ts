import { createContext } from 'react'
import type { useFullShellChat } from '@/shell/use-full-shell-chat'

export type ChatRuntime = ReturnType<typeof useFullShellChat>["runtime"]

export const ChatRuntimeContext = createContext<ChatRuntime | null>(null)
