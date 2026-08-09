export type MediaJobErrorLike =
  | {
      message?: string;
      code?: string;
    }
  | undefined;

/**
 * Catalog key for the user-facing copy describing why an image job failed.
 * Callers resolve it with `t()` (or `i18nFallback.t` outside React).
 */
export const imageGenerationFailureKey = (error: MediaJobErrorLike): string => {
  const code =
    typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
  switch (code) {
    case "request_timeout":
    case "timeout":
      return "app.media.imageFailure.tookTooLong";
    case "startup_timeout":
      return "app.media.imageFailure.tookTooLongToStart";
    case "runner_scheduling_failure":
    case "runner_connection_timeout":
    case "runner_disconnected":
    case "runner_connection_refused":
    case "runner_connection_error":
      return "app.media.imageFailure.serviceBusy";
    case "runner_incomplete_response":
    case "payload_error":
      return "app.media.imageFailure.resultUnreadable";
    case "runner_server_error":
    case "internal_error":
      return "app.media.imageFailure.temporaryError";
    case "bad_request":
      return "app.media.imageFailure.invalidRequest";
    case "client_cancelled":
      return "app.media.imageFailure.canceled";
    case "client_disconnected":
      return "app.media.imageFailure.interrupted";
  }

  const message =
    typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (/\b(policy|safety|moderation|blocked|nsfw)\b/i.test(message)) {
    return "app.media.imageFailure.blocked";
  }
  if (/\b(rate|429|concurrency|busy|capacity)\b/i.test(message)) {
    return "app.media.imageFailure.serviceBusy";
  }
  if (/\b(auth|api key|unauthorized|forbidden|401|403)\b/i.test(message)) {
    return "app.media.imageFailure.notConfigured";
  }
  if (/\b(required|invalid|validation|422|bad request)\b/i.test(message)) {
    return "app.media.imageFailure.invalidRequest";
  }
  if (/\b(timeout|timed out|deadline)\b/i.test(message)) {
    return "app.media.imageFailure.tookTooLong";
  }

  return "app.media.imageFailure.generic";
};
