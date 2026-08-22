/**
 * Central, secret-free registry of the environment variables the first-party
 * connector core reads. Values live only in the Convex deployment
 * configuration (production: `benevolent-minnow-586`); this module inspects
 * names, never logs values, and never returns secret material.
 *
 * Namespacing convention (preferred over the older mixed `X_CLIENT_ID` /
 * desktop `STELLA_NATIVE_OAUTH_*` names):
 *
 *   STELLA_CONNECTOR_OAUTH_<PROVIDER_KEY>_CLIENT_ID
 *   STELLA_CONNECTOR_OAUTH_<PROVIDER_KEY>_CLIENT_SECRETS_JSON   {"<ver>":"<secret>"}
 *   STELLA_CONNECTOR_OAUTH_<PROVIDER_KEY>_CLIENT_SECRET_VERSION active version
 *
 * where <PROVIDER_KEY> is the manifest key upper-cased with `-` -> `_`
 * (e.g. `google-workspace` -> `GOOGLE_WORKSPACE`).
 */

export const CONNECTOR_ENV = {
  /** Sole origin used to build production callbacks (e.g. https://connect.stella.sh). */
  PUBLIC_BASE_URL: "STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL",
  /** Comma-separated emergency allowlist of enabled provider keys. Empty = fail closed. */
  ENABLED_PROVIDERS: "STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS",
  /** Global backend kill switch for first-party execution. Default false. */
  EXECUTION_ENABLED: "STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED",
  /** Bounded retention (days) for connector audit/attempt metadata. Default 90. */
  AUDIT_RETENTION_DAYS: "STELLA_CONNECTOR_AUDIT_RETENTION_DAYS",
  /**
   * Test/dev-only escape hatch that registers the built-in `mock` provider used
   * by the connector test suite. Must never be set in production.
   */
  ALLOW_MOCK_PROVIDER: "STELLA_CONNECTOR_OAUTH_ALLOW_MOCK",
} as const;

const readTrimmed = (name: string): string | null => {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** True only when the global kill switch is explicitly enabled. Fails closed. */
export const isFirstPartyExecutionEnabled = (): boolean => {
  const raw = readTrimmed(CONNECTOR_ENV.EXECUTION_ENABLED);
  return raw === "1" || raw?.toLowerCase() === "true";
};

/** Parsed emergency allowlist of enabled provider keys. Empty set = fail closed. */
export const enabledProviderKeys = (): Set<string> => {
  const raw = readTrimmed(CONNECTOR_ENV.ENABLED_PROVIDERS);
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
};

export const isProviderEnabled = (providerKey: string): boolean =>
  enabledProviderKeys().has(providerKey.trim().toLowerCase());

export const mockProviderAllowed = (): boolean => {
  const raw = readTrimmed(CONNECTOR_ENV.ALLOW_MOCK_PROVIDER);
  return raw === "1" || raw?.toLowerCase() === "true";
};

/** Public callback base origin, or null until the branded domain is configured. */
export const connectorPublicBaseUrl = (): string | null => {
  const raw = readTrimmed(CONNECTOR_ENV.PUBLIC_BASE_URL);
  if (!raw) return null;
  return raw.replace(/\/+$/u, "");
};

const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const MAX_AUDIT_RETENTION_DAYS = 400;

export const auditRetentionMs = (): number => {
  const raw = readTrimmed(CONNECTOR_ENV.AUDIT_RETENTION_DAYS);
  const parsed = raw ? Number(raw) : NaN;
  const days =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.floor(parsed), MAX_AUDIT_RETENTION_DAYS)
      : DEFAULT_AUDIT_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
};

/** Env var name (not value) that holds a provider's client id. */
export const providerClientIdEnvName = (providerKey: string): string =>
  `STELLA_CONNECTOR_OAUTH_${providerEnvSuffix(providerKey)}_CLIENT_ID`;

/** Env var name (not value) that holds a provider's versioned client-secret ring. */
export const providerClientSecretsJsonEnvName = (providerKey: string): string =>
  `STELLA_CONNECTOR_OAUTH_${providerEnvSuffix(providerKey)}_CLIENT_SECRETS_JSON`;

/** Env var name (not value) that holds a provider's active client-secret version. */
export const providerClientSecretVersionEnvName = (
  providerKey: string,
): string =>
  `STELLA_CONNECTOR_OAUTH_${providerEnvSuffix(providerKey)}_CLIENT_SECRET_VERSION`;

const providerEnvSuffix = (providerKey: string): string =>
  providerKey.trim().toUpperCase().replace(/-/gu, "_").replace(/[^A-Z0-9_]/gu, "");
