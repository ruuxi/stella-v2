export const XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS = 5 * 60;

export const buildXaiRealtimeClientSecretRequest = (
  expiresAfterSeconds = XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
): { expires_after: { seconds: number } } => ({
  expires_after: {
    seconds: Math.max(
      60,
      Math.floor(
        Number.isFinite(expiresAfterSeconds)
          ? expiresAfterSeconds
          : XAI_REALTIME_CLIENT_SECRET_TTL_SECONDS,
      ),
    ),
  },
});
