import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useIdleHomeVisibility } from '@/features/chat/hooks/use-idle-home-visibility'
import { uiState } from '@/platform/ui-state'
import { STELLA_SHOW_HOME_EVENT } from '@/shared/lib/stella-orb-chat'

const SESSION_LEFT_CHAT_KEY = 'stella_left_chat_once'
const CHAT_HOME_SURFACE_STORAGE_KEY = 'stella.chatHomeSurface'

type ChatHomeSurface = 'home' | 'chat'

function readPersistedChatHomeSurface(): ChatHomeSurface | null {
  if (typeof window === 'undefined') return null
  const raw = uiState.getItem(CHAT_HOME_SURFACE_STORAGE_KEY)
  return raw === 'home' || raw === 'chat' ? raw : null
}

function writePersistedChatHomeSurface(surface: ChatHomeSurface): void {
  if (typeof window === 'undefined') return
  uiState.setItem(CHAT_HOME_SURFACE_STORAGE_KEY, surface)
}

type UseChatHomeSurfaceOptions = {
  isOnChatRoute: boolean
  hasMessages: boolean
  isInitialLoading: boolean
  isStreaming: boolean
  activeConversationId: string | null
}

type UseChatHomeSurfaceResult = {

  showHomeContent: boolean

  enterChatSurfaceForInteraction: () => void

  resetIdleTimer: () => void

  dismissHome: () => void

  showHome: () => void
}

export function useChatHomeSurface({
  isOnChatRoute,
  hasMessages,
  isInitialLoading,
  isStreaming,
  activeConversationId,
}: UseChatHomeSurfaceOptions): UseChatHomeSurfaceResult {
  const [leftChatOnce, setLeftChatOnce] = useState(() => {
    if (typeof sessionStorage === 'undefined') return false
    return sessionStorage.getItem(SESSION_LEFT_CHAT_KEY) === '1'
  })
  const [
    hasInteractedWithChatThisSession,
    setHasInteractedWithChatThisSession,
  ] = useState(false)
  const [isHomeDismissed, setIsHomeDismissed] = useState(
    () => readPersistedChatHomeSurface() === 'chat',
  )
  const prevOnChatRouteRef = useRef(isOnChatRoute)
  const prevConversationIdRef = useRef(activeConversationId)

  const { showHomeContent: idleBasedHome, resetIdleTimer, forceShowHome } =
    useIdleHomeVisibility({ hasMessages, isStreaming })

  const firstStintOnChat = !leftChatOnce && isOnChatRoute

  const baseShowHomeContent = isInitialLoading
    ? false
    : firstStintOnChat
      ? !hasMessages || !hasInteractedWithChatThisSession || idleBasedHome
      : idleBasedHome
  const showHomeContent = isHomeDismissed ? false : baseShowHomeContent

  useLayoutEffect(() => {
    if (prevConversationIdRef.current === activeConversationId) return
    const hadConversation = Boolean(prevConversationIdRef.current)
    prevConversationIdRef.current = activeConversationId
    if (hadConversation) {
      setHasInteractedWithChatThisSession(true)
      setIsHomeDismissed(false)
      resetIdleTimer()
    }
  }, [activeConversationId, resetIdleTimer])

  useEffect(() => {
    if (!isOnChatRoute) return
    writePersistedChatHomeSurface(showHomeContent ? 'home' : 'chat')
  }, [isOnChatRoute, showHomeContent])

  useEffect(() => {
    if (prevOnChatRouteRef.current && !isOnChatRoute) {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(SESSION_LEFT_CHAT_KEY, '1')
      }
      queueMicrotask(() => {
        setLeftChatOnce(true)
      })
    }
    prevOnChatRouteRef.current = isOnChatRoute
  }, [isOnChatRoute])

  const enterChatSurfaceForInteraction = useCallback(() => {
    setHasInteractedWithChatThisSession(true)
    setIsHomeDismissed(true)
    writePersistedChatHomeSurface('chat')
  }, [])

  const dismissHome = useCallback(() => {
    setIsHomeDismissed(true)
    writePersistedChatHomeSurface('chat')
  }, [])

  const showHome = useCallback(() => {
    setIsHomeDismissed(false)
    writePersistedChatHomeSurface('home')
    forceShowHome()
  }, [forceShowHome])

  useEffect(() => {
    const handler = () => {
      setIsHomeDismissed(false)
      writePersistedChatHomeSurface('home')
      forceShowHome()
    }
    window.addEventListener(STELLA_SHOW_HOME_EVENT, handler)
    return () => window.removeEventListener(STELLA_SHOW_HOME_EVENT, handler)
  }, [forceShowHome])

  return {
    showHomeContent,
    enterChatSurfaceForInteraction,
    resetIdleTimer,
    dismissHome,
    showHome,
  }
}
