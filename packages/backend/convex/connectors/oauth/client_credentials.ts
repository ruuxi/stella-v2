import { ConnectorError } from "../errors";
import {
  providerClientIdEnvName,
  providerClientSecretsJsonEnvName,
  providerClientSecretVersionEnvName,
} from "../env";

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
  for (const [version, secret] of Object.entries(parsed as Record<string, unknown>)) {
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

/**
 * Resolve credentials for a provider. If `preferredVersion` is supplied (an
 * in-flight attempt recorded the version it started with) that version is used
 * so a mid-flight rotation does not invalidate the exchange.
 */
export const resolveProviderClientCredentials = (
  providerKey: string,
  preferredVersion?: number,
): ProviderClientCredentials => {
  const clientId = readEnv(providerClientIdEnvName(providerKey));
  const secretsJson = readEnv(providerClientSecretsJsonEnvName(providerKey));
  if (!clientId || !secretsJson) throw new ConnectorError("provider_not_configured");

  const ring = parseSecretRing(secretsJson);
  const activeVersionRaw = readEnv(providerClientSecretVersionEnvName(providerKey));
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
