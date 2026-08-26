import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useAuthSessionState } from '@/global/auth/hooks/use-auth-session-state'
import {
  ChatStoreContextProvider,
  LocalChatStoreProvider,
  useChatStore,
  type ChatStoreContextValue,
} from './chat-store-context'
import { resolveChatStorageModeFromImportEnv } from './resolve-chat-storage-mode'

export { LocalChatStoreProvider, useChatStore }

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { hasConnectedAccount } = useAuthSessionState()

  // Invisible activation wiring (no UI toggle): ordinary conversations are
  // cloud-canonical when cloud conversations are explicitly enabled AND the
  // desktop's Convex issuer is aligned with the cloud journal worker; otherwise
  // they stay in the explicit local mode. Misconfiguration throws here rather
  // than silently creating a local-canonical conversation.
  const { storageMode, cloudFeaturesEnabled } = useMemo(
    () => resolveChatStorageModeFromImportEnv(import.meta.env),
    [],
  )
  const isLocalStorage = storageMode === 'local'

  const value = useMemo<ChatStoreContextValue>(
    () => ({
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      isAuthenticated: hasConnectedAccount,
    }),
    [
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      hasConnectedAccount,
    ],
  )

  return (
    <ChatStoreContextProvider value={value}>
      {children}
    </ChatStoreContextProvider>
  )
}
