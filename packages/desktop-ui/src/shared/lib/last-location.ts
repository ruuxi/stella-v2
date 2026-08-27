import { uiState } from '@/platform/ui-state'

const STORAGE_KEY = 'stella:lastLocation'

const MAX_LENGTH = 2048

export function readPersistedLastLocation(): string | null {
  const raw = uiState.getItem(STORAGE_KEY)
  if (!raw) return null
  if (raw.length > MAX_LENGTH) return null
  if (!raw.startsWith('/')) return null
  return raw
}

export function writePersistedLastLocation(location: string): void {
  if (!location || location.length > MAX_LENGTH) return
  uiState.setItem(STORAGE_KEY, location)
}
