import { getLocalLlmCredential } from "./llm-credentials.js";
import {
  getLocalLlmOAuthApiKey,
  hasLocalLlmOAuthCredential,
} from "./llm-oauth-credentials.js";

export type LocalLlmOAuthApiKeyAccessOptions = {
  /** Mint a new access token even if the stored one has not expired. */
  forceRefresh?: boolean;
};

export type LocalLlmCredentialAccessBroker = {
  hasApiKey(provider: string): boolean;
  hasOAuth(provider: string): boolean;
  getApiKey(provider: string): Promise<string | null>;
  getOAuthApiKey(
    provider: string,
    options?: LocalLlmOAuthApiKeyAccessOptions,
  ): Promise<string | null>;
};

let broker: LocalLlmCredentialAccessBroker | null = null;

const normalizeProvider = (provider: string) => provider.trim().toLowerCase();

export const setLocalLlmCredentialAccessBroker = (
  value: LocalLlmCredentialAccessBroker | null,
): void => {
  broker = value;
};

export const hasAccessibleLocalLlmApiKey = (
  stellaDataDirPath: string,
  provider: string,
): boolean => {
  const normalized = normalizeProvider(provider);
  return broker
    ? broker.hasApiKey(normalized)
    : Boolean(getLocalLlmCredential(stellaDataDirPath, normalized));
};

export const hasAccessibleLocalLlmOAuthCredential = (
  stellaDataDirPath: string,
  provider: string,
): boolean => {
  const normalized = normalizeProvider(provider);
  return broker
    ? broker.hasOAuth(normalized)
    : hasLocalLlmOAuthCredential(stellaDataDirPath, normalized);
};

/*
 * With a broker installed, a `get` is a host round trip (on desktop an IPC
 * hop to Electron main plus a safeStorage decrypt). The broker's
 * `hasApiKey`/`hasOAuth` answer from the host's provider list, which the host
 * re-sends whenever stored credentials change (`localLlmCredentialsUpdatedAt`
 * → `refreshLocalLlmCredentialAccess`), and the host's `get` reads the same
 * store that list enumerates. So a provider the list does not name has no
 * value to fetch: answer null locally instead of asking the host twice per
 * model call (api-key, then oauth) for providers routed through
 * models.json/runtime-managed auth.
 */
export const getAccessibleLocalLlmApiKey = async (
  stellaDataDirPath: string,
  provider: string,
): Promise<string | null> => {
  const normalized = normalizeProvider(provider);
  if (!broker) return getLocalLlmCredential(stellaDataDirPath, normalized);
  return broker.hasApiKey(normalized)
    ? await broker.getApiKey(normalized)
    : null;
};

export const getAccessibleLocalLlmOAuthApiKey = async (
  stellaDataDirPath: string,
  provider: string,
  options: LocalLlmOAuthApiKeyAccessOptions = {},
): Promise<string | null> => {
  const normalized = normalizeProvider(provider);
  if (!broker) {
    return await getLocalLlmOAuthApiKey(stellaDataDirPath, normalized, options);
  }
  return broker.hasOAuth(normalized)
    ? await broker.getOAuthApiKey(normalized, options)
    : null;
};
