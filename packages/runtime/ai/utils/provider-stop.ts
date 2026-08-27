const SAFETY_STOP_REASONS = new Set([
  "refusal",
  "sensitive",
  "safety",
  "image_safety",
  "prohibited_content",
  "image_prohibited_content",
  "blocklist",
  "spii",
  "recitation",
  "image_recitation",
  "content_filter",
  "content_filtered",
  "guardrail_intervened",
]);

export function isSafetyStopReason(rawStopReason: string): boolean {
  return SAFETY_STOP_REASONS.has(rawStopReason.trim().toLowerCase());
}

export function providerAbortedStopMessage(rawStopReason: string): string {
  if (isSafetyStopReason(rawStopReason)) {
    return (
      `Provider aborted the response (stop reason: "${rawStopReason}"). ` +
      "This is a provider-side refusal/safety/content-filter stop triggered by something in the request content."
    );
  }
  return `Provider ended the stream abnormally (stop reason: "${rawStopReason}") without a completed response.`;
}

const TRANSIENT_STREAM_ANOMALY_PATTERNS: RegExp[] = [
  /\bprovider stream ended with stopreason "/i,
  /\bprovider ended the stream abnormally \(stop reason:/i,
  /\bprovider paused the turn \(stop reason: "pause_turn"\)/i,
  /\bstream ended before message_stop\b/i,
];

export function isTransientProviderStreamAnomalyMessage(
  message: string | undefined,
): boolean {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  return TRANSIENT_STREAM_ANOMALY_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
}

export function anomalousStreamStopError(output: {
  stopReason: string;
  errorMessage?: string;
}): Error {
  const detail = output.errorMessage?.trim();
  if (detail) {
    return new Error(detail);
  }
  return new Error(
    `Provider stream ended with stopReason "${output.stopReason}" but the provider supplied no error detail.`,
  );
}
