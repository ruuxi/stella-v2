/**
 * Narrow first-party adapter interface for the CRM / recruiting / sales
 * connector set (HubSpot, Gong, Ashby, Pipedrive, Salesforce, Apollo, Attio,
 * 21RISK).
 *
 * This is deliberately NOT an execution core. Each adapter is inert metadata
 * describing a provider's official API surface. Production execution belongs
 * to the backend connector dispatcher; `connect-service` must not execute
 * these request builders or race them with Composio.
 *
 * The local production-ready allowlist remains empty, so the Composio broker
 * stays the sole executor until backend rollout and live verification complete.
 */

export type ConnectorAdapterAuth = "oauth" | "api_key";

/** Read = safe/idempotent lookups; write = create/update/mutation. */
export type ConnectorAdapterActionKind = "read" | "write";

export type ConnectorAdapterHttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

/**
 * A single outbound HTTP request against the provider's official API. `path`
 * is always relative to the adapter `baseUrl` (or the token-scoped resource
 * URL for instance-based providers like Salesforce) and must begin with `/`
 * so `callApiConnector`'s base-URL confinement applies.
 */
export type ConnectorAdapterRequest = {
  method: ConnectorAdapterHttpMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: Record<string, unknown>;
};

export type ConnectorAdapterAction = {
  /** Canonical action slug (UPPER_SNAKE, aligned with the Store/Composio id). */
  name: string;
  title: string;
  description: string;
  kind: ConnectorAdapterActionKind;
  /** Provider scopes this action requires (subset of the adapter's scopes). */
  scopes?: readonly string[];
  /** JSON schema describing the accepted arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * Pure mapper from validated arguments to a single REST request. Throws a
   * plain Error (message surfaced to the agent) when a required argument is
   * missing — mirroring the rest of connect-service's error convention.
   */
  buildRequest: (input: Record<string, unknown>) => ConnectorAdapterRequest;
};

export type ConnectorAdapter = {
  /** Connector id — unchanged from the existing catalog / Store id. */
  id: string;
  displayName: string;
  auth: ConnectorAdapterAuth;
  /**
   * Official API base. Instance-scoped providers (Salesforce) still declare a
   * base here for discovery, but execution prefers the token's resource URL.
   */
  baseUrl: string;
  /** HTTP auth scheme for the stored credential (defaults to bearer). */
  apiAuthScheme?: "bearer" | "basic" | "oauth" | "raw";
  /**
   * Non-standard header the credential is placed in (e.g. `X-Api-Key`). When
   * omitted the credential goes in `Authorization` per `apiAuthScheme`.
   */
  authHeaderName?: string;
  /** OAuth scopes (OAuth providers) the connector requests at connect time. */
  scopes?: readonly string[];
  /** Human docs pointer for maintainers. */
  docsUrl: string;
  actions: readonly ConnectorAdapterAction[];
};

/** Throws a plain Error when a required string argument is absent/blank. */
export const requireString = (
  input: Record<string, unknown>,
  key: string,
  action: string,
): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${action} requires a non-empty \`${key}\` string.`);
  }
  return value.trim();
};

/** Reads an optional plain object argument (record), else undefined. */
export const optionalRecord = (
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

/** URL-encodes a single path segment for safe interpolation into `path`. */
export const seg = (value: string): string => encodeURIComponent(value);
