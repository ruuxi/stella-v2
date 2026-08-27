/**
 * A renderer must renew this lease while its managed realtime transport is
 * physically open. Desktop and mobile poll every two seconds and enforce the
 * returned deadline locally, so an offline client cannot retain authority for
 * the old five-minute provider session lifetime.
 */
export const VOICE_REALTIME_AUTHORITY_LEASE_MS = 10_000;
export const VOICE_REALTIME_AUTHORITY_POLL_MS = 2_000;
export const VOICE_REALTIME_AUTHORITY_QUIESCENCE_MS = 2_000;

export const voiceAuthorityQuiescentAfter = (expiresAt: number): number =>
  expiresAt + VOICE_REALTIME_AUTHORITY_QUIESCENCE_MS;
