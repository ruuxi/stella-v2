import type { MessageMetadata } from '@/features/chat/lib/event-transforms'
import type { ChatContext } from '@/shared/types/electron'

export type AttachmentRef = {
  id?: string
  url?: string
  mimeType?: string

  previewUrl?: string

  name?: string
  size?: number

  kind?: string

  path?: string
}

export type SendMessageArgs = {
  text: string
  selectedText: string | null
  chatContext: ChatContext | null
  onClear: () => void
  metadata?: MessageMetadata
}
