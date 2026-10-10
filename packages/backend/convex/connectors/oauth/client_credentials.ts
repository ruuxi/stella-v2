import { ConnectorError } from "../errors";
import {
  CONNECTOR_ENV,
  providerClientIdEnvName,
  providerClientSecretsJsonEnvName,
  providerClientSecretVersionEnvName,
} from "../env";
import { normalizeSnowflakeAccountOrigin } from "../snowflake";

/**
 * Resolve a provider's OAuth client id + active client secret from deployment
 * env only. Client secrets use a versioned JSON ring so a rotation between a
 * connect-start and its callback does not break an in-flight attempt:
 *
 *   STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRETS_JSON   {"1":"...","2":"..."}
 *   STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRET_VERSION 2
 *
 * Secret values are never returned to callers other than the token-exchange and
 * refresh actions, and are never logged.
 */

export type ProviderClientCredentials = {
  clientId: string;
  clientSecret: string;
  clientSecretVersion: number;
};

const readEnv = (name: string): string | null => {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseSecretRing = (raw: string): Map<number, string> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConnectorError("provider_not_configured");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectorError("provider_not_configured");
  }
  const ring = new Map<number, string>();
  for (const [version, secret] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const parsedVersion = Number(version);
    if (
      Number.isFinite(parsedVersion) &&
      parsedVersion > 0 &&
      typeof secret === "string" &&
      secret.length > 0
    ) {
      ring.set(Math.floor(parsedVersion), secret);
    }
  }
  if (ring.size === 0) throw new ConnectorError("provider_not_configured");
  return ring;
};

type SnowflakeTenantRegistration = {
  clientId: string;
  activeVersion: number;
  secrets: Record<string, string>;
};

export const parseSnowflakeTenantRegistrations = (
  raw: string | undefined,
): ReadonlyMap<string, SnowflakeTenantRegistration> => {
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConnectorError("provider_not_configured");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectorError("provider_not_configured");
  }
  const registrations = new Map<string, SnowflakeTenantRegistration>();
  for (const [host, value] of Object.entries(parsed)) {
    const origin = normalizeSnowflakeAccountOrigin(`https://${host}`);
    const normalizedHost = new URL(origin).hostname;
    if (host !== normalizedHost || registrations.has(normalizedHost)) {
      throw new ConnectorError("provider_not_configured");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ConnectorError("provider_not_configured");
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.clientId !== "string" ||
      !row.clientId.trim() ||
      typeof row.activeVersion !== "number" ||
      !Number.isSafeInteger(row.activeVersion) ||
      row.activeVersion < 1 ||
      !row.secrets ||
      typeof row.secrets !== "object" ||
      Array.isArray(row.secrets)
    ) {
      throw new ConnectorError("provider_not_configured");
    }
    const secrets = Object.fromEntries(
      Object.entries(row.secrets as Record<string, unknown>).map(
        ([version, secret]) => {
          const numericVersion = Number(version);
          if (
            !/^[1-9]\d*$/u.test(version) ||
            !Number.isSafeInteger(numericVersion) ||
            typeof secret !== "string" ||
            !secret
          ) {
            throw new ConnectorError("provider_not_configured");
          }
          return [version, secret];
        },
      ),
    );
    if (!secrets[String(row.activeVersion)]) {
      throw new ConnectorError("provider_not_configured");
    }
    registrations.set(normalizedHost, {
      clientId: row.clientId.trim(),
      activeVersion: row.activeVersion,
      secrets,
    });
  }
  return registrations;
};

const resolveSnowflakeTenantCredentials = (
  accountOrigin: unknown,
  preferredVersion?: number,
): ProviderClientCredentials => {
  const origin = normalizeSnowflakeAccountOrigin(accountOrigin);
  const registration = parseSnowflakeTenantRegistrations(
    process.env[CONNECTOR_ENV.SNOWFLAKE_TENANTS_JSON],
  ).get(new URL(origin).hostname);
  if (!registration) throw new ConnectorError("provider_not_configured");
  const version = preferredVersion ?? registration.activeVersion;
  const clientSecret = registration.secrets[String(version)];
  if (!clientSecret) throw new ConnectorError("provider_not_configured");
  return {
    clientId: registration.clientId,
    clientSecret,
    clientSecretVersion: version,
  };
};

/**
 * Resolve credentials for a provider. If `preferredVersion` is supplied (an
 * in-flight attempt recorded the version it started with) that version is used
 * so a mid-flight rotation does not invalidate the exchange.
 */
export const resolveProviderClientCredentials = (
  providerKey: string,
  preferredVersion?: number,
  accountOrigin?: string,
): ProviderClientCredentials => {
  if (providerKey.trim().toLowerCase() === "snowflake") {
    return resolveSnowflakeTenantCredentials(accountOrigin, preferredVersion);
  }
  const clientId = readEnv(providerClientIdEnvName(providerKey));
  const secretsJson = readEnv(providerClientSecretsJsonEnvName(providerKey));
  if (!clientId || !secretsJson)
    throw new ConnectorError("provider_not_configured");

  const ring = parseSecretRing(secretsJson);
  const activeVersionRaw = readEnv(
    providerClientSecretVersionEnvName(providerKey),
  );
  const activeVersion = activeVersionRaw ? Number(activeVersionRaw) : NaN;
  const version =
    preferredVersion && ring.has(preferredVersion)
      ? preferredVersion
      : Number.isFinite(activeVersion) && ring.has(Math.floor(activeVersion))
        ? Math.floor(activeVersion)
        : [...ring.keys()].sort((a, b) => b - a)[0];

  const clientSecret = ring.get(version);
  if (!clientSecret) throw new ConnectorError("provider_not_configured");
  return { clientId, clientSecret, clientSecretVersion: version };
};
