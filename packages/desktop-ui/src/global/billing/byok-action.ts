export const OPEN_MODEL_PICKER_EVENT = 'stella:open-model-picker'

export const BYOK_TOAST_ACTION = {
  label: 'Use my own key',
  onClick: (): void => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(new Event(OPEN_MODEL_PICKER_EVENT))
  },
} as const
