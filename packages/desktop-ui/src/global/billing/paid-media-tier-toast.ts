/**
 * Reactive capability toast for the Stella-paid media surfaces (image,
 * video, audio and music through the backend's `media.generate`).
 *
 * Backend marker: the media domain's plan gate refuses with the shared
 * capability denial message, as a `FORBIDDEN` RPC error or a 402 from
 * `/api/media/v1/generate`. Both surface to the renderer as a thrown
 * Error whose message the shared classifier reads.
 *
 * The classification and the copy both come from the one client-side
 * capability gate (`./capabilities` over the shared matrix), so this
 * module carries no plan knowledge of its own — only the HTTP-envelope
 * unwrapping the media routes need.
 */
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

/** Unwrap JSON error bodies from Stella media HTTP responses. */
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
    // fall through
  }
  return trimmed
}

const readableMediaErrorMessage = (error: unknown): string => {
  const message = extractErrorMessage(error)
  return message ? parseMediaApiErrorMessage(message) : ''
}

/**
 * If `error` is a capability rejection, fire the restriction toast and
 * return true.
 *
 * `fallbackCapability` names what the caller was trying to do, for the
 * older backend rejections that say "requires a Stella subscription"
 * without naming a capability.
 */
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

/** Toast-only error surface for right-sidebar Media tab and `/api/media` callers. */
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
