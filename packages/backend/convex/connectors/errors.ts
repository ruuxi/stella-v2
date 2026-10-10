/**
 * Provider-neutral error taxonomy for the first-party connector core.
 *
 * Every failure surfaced to callers, logs, or audit rows is mapped to one of
 * these stable codes. Raw provider error strings/bodies are never propagated:
 * they can contain request arguments, tokens, or user content.
 */

export const CONNECTOR_ERROR_CODES = [
  "unauthorized",
  // Configuration / routing
  "provider_not_configured",
  "provider_unverified",
  "provider_disabled",
  "execution_disabled",
  "connector_disabled",
  "route_not_first_party",
  "unsupported_client_version",
  // Connect flow
  "invalid_state",
  "state_expired",
  "state_replayed",
  "pkce_required",
  "redirect_mismatch",
  "unregistered_scope",
  "account_mismatch",
  "issuer_mismatch",
  "identity_unavailable",
  "code_exchange_failed",
  "consent_denied",
  // Credentials / refresh
  "account_not_found",
  "reauth_required",
  "missing_scope",
  "refresh_busy",
  "refresh_failed",
  "invalid_grant",
  "invalid_credential",
  "credential_generation_conflict",
  // Customer-hosted connect profiles (per-owner origin + token)
  "invalid_origin",
  "origin_not_allowed",
  // Fail-closed when no enforced first-party egress transport is available.
  "egress_transport_unavailable",
  // Execution
  "action_not_found",
  "invalid_input",
  "invalid_schema",
  "schema_unavailable",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_timeout",
  "response_too_large",
  "normalization_error",
  // Generic
  "not_connected",
  "rate_limited",
  "internal_error",
  "ambiguous_write",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  constructor(code: ConnectorErrorCode, retryable = false) {
    super(code);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Map a connector error code to a safe HTTP status. */
export const connectorErrorHttpStatus = (code: ConnectorErrorCode): number => {
  switch (code) {
    case "unauthorized":
      return 401;
    case "invalid_state":
    case "pkce_required":
    case "redirect_mismatch":
    case "unregistered_scope":
    case "invalid_origin":
    case "invalid_input":
    case "invalid_schema":
    case "invalid_credential":
      return 400;
    case "reauth_required":
    case "missing_scope":
    case "not_connected":
    case "account_mismatch":
    case "credential_generation_conflict":
      return 409;
    case "account_not_found":
    case "action_not_found":
    case "route_not_first_party":
      return 404;
    case "consent_denied":
    case "provider_disabled":
    case "provider_unverified":
    case "execution_disabled":
    case "connector_disabled":
    case "origin_not_allowed":
    case "unsupported_client_version":
      return 403;
    case "state_expired":
    case "state_replayed":
      return 410;
    case "rate_limited":
    case "provider_rate_limited":
    case "refresh_busy":
      return 429;
    case "provider_unavailable":
    case "provider_timeout":
    case "schema_unavailable":
    case "provider_not_configured":
    case "egress_transport_unavailable":
      return 503;
    default:
      return 500;
  }
};

/**
 * Classify an unknown provider HTTP status into a coarse, loggable class and a
 * connector error code. Never inspects the body.
 */
export const classifyProviderStatus = (
  status: number,
): { statusClass: string; code: ConnectorErrorCode; retryable: boolean } => {
  if (status === 401 || status === 403) {
    return { statusClass: "auth", code: "reauth_required", retryable: false };
  }
  if (status === 429) {
    return {
      statusClass: "rate_limited",
      code: "provider_rate_limited",
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      statusClass: "server_error",
      code: "provider_unavailable",
      retryable: true,
    };
  }
  if (status >= 400) {
    return { statusClass: "client_error", code: "invalid_input", retryable: false };
  }
  return { statusClass: "ok", code: "internal_error", retryable: false };
};

/**
 * Normalize an OAuth token-endpoint `error` field into a refresh outcome.
 * `invalid_grant` means the refresh token is dead -> reauth required.
 */
export const classifyTokenEndpointError = (
  errorField: unknown,
): { code: ConnectorErrorCode; retryable: boolean } => {
  const value =
    typeof errorField === "string" ? errorField.trim().toLowerCase() : "";
  if (value === "invalid_grant") {
    return { code: "invalid_grant", retryable: false };
  }
  if (value === "temporarily_unavailable" || value === "slow_down") {
    return { code: "provider_unavailable", retryable: true };
  }
  return { code: "refresh_failed", retryable: false };
};
