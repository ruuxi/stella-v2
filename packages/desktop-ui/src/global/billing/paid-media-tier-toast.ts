import { showToast } from '@/ui/toast'
import { classifyStellaProviderError } from '@/features/chat/streaming/stella-provider-error-classifier'
import {
  buildCapabilityRestrictionToast,
  readBillingAudience,
  resolveDeniedCapability,
  type Capability,
} from './capabilities'

const extractErrorMessage = (error: unknown): string => {
  if (!error) return ''
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && 'message' in (error as Record<string, unknown>)) {
    const value = (error as { message?: unknown }).message
    return typeof value === 'string' ? value : ''
  }
  return ''
}

export const parseMediaApiErrorMessage = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (!trimmed.startsWith('{')) return trimmed
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown
      message?: unknown
    }
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim()
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim()
    }
  } catch {

  }
  return trimmed
}

const readableMediaErrorMessage = (error: unknown): string => {
  const message = extractErrorMessage(error)
  return message ? parseMediaApiErrorMessage(message) : ''
}

export const maybeShowPaidMediaTierToast = (
  error: unknown,
  fallbackCapability: Capability = 'image_generation',
): boolean => {
  const message = readableMediaErrorMessage(error)
  if (!message) return false
  const classification = classifyStellaProviderError(message)
  if (classification.kind !== 'capability-required') return false
  const capability = classification.capability ?? fallbackCapability
  const restriction = resolveDeniedCapability(readBillingAudience(), capability)
  if (!restriction) return false
  showToast(buildCapabilityRestrictionToast(restriction))
  return true
}

export const notifyMediaGenerationError = (error: unknown): void => {
  if (maybeShowPaidMediaTierToast(error)) return
  const message = readableMediaErrorMessage(error)
  if (!message) return
  showToast({
    title: message,
    variant: 'error',
    duration: 8000,
  })
}
