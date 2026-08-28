export type GatewayErrorCode =
  | "bad_request"
  | "not_found"
  | "method_not_allowed"
  | "unsupported_action"
  | "profile_conflict"
  | "stale_interaction"
  | "human_control_active"
  | "browser_unavailable"
  | "navigation_denied"
  | "verification_failed"
  | "interaction_expired"
  | "snapshot_unavailable"
  | "internal_error";

const PUBLIC_MESSAGES: Record<GatewayErrorCode, string> = {
  bad_request: "The browser request is invalid.",
  not_found: "The browser resource was not found.",
  method_not_allowed: "The browser request method is not allowed.",
  unsupported_action: "The browser action is not supported.",
  profile_conflict: "The browser profile changed. Please retry.",
  stale_interaction: "The browser interaction changed. Please refresh it.",
  human_control_active: "Browser automation is paused for human control.",
  browser_unavailable: "The cloud browser is temporarily unavailable.",
  navigation_denied: "That browser destination is not allowed.",
  verification_failed: "The sign-in could not be verified.",
  interaction_expired: "The browser interaction expired.",
  snapshot_unavailable: "The saved browser profile is unavailable.",
  internal_error: "The browser request could not be completed.",
};

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;

  constructor(code: GatewayErrorCode, status: number) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
  }
}

export const publicErrorResponse = (error: unknown): Response => {
  const gatewayError =
    error instanceof GatewayError
      ? error
      : new GatewayError("internal_error", 500);
  return Response.json(
    {
      schemaVersion: 1,
      error: {
        code: gatewayError.code,
        message: PUBLIC_MESSAGES[gatewayError.code],
      },
    },
    {
      status: gatewayError.status,
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    },
  );
};

export const safeErrorCode = (error: unknown): GatewayErrorCode =>
  error instanceof GatewayError ? error.code : "internal_error";
