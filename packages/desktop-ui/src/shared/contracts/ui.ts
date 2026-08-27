export type UiMode = 'chat' | 'voice'

export type UiState = {
  mode: UiMode
  conversationId: string | null
  isVoiceRtcActive: boolean
}
