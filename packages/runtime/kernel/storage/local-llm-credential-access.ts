import { getLocalLlmCredential } from "./llm-credentials.js";
import {
  getLocalLlmOAuthApiKey,
  hasLocalLlmOAuthCredential,
} from "./llm-oauth-credentials.js";

export type LocalLlmCredentialAccessBroker = {
  hasApiKey(provider: string): boolean;
  hasOAuth(provider: string): boolean;
  getApiKey(provider: string): Promise<string | null>;
  getOAuthApiKey(provider: string): Promise<string | null>;
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

export const getAccessibleLocalLlmApiKey = async (
  stellaDataDirPath: string,
  provider: string,
): Promise<string | null> => {
  const normalized = normalizeProvider(provider);
  return broker
    ? await broker.getApiKey(normalized)
    : getLocalLlmCredential(stellaDataDirPath, normalized);
};

export const getAccessibleLocalLlmOAuthApiKey = async (
  stellaDataDirPath: string,
  provider: string,
): Promise<string | null> => {
  const normalized = normalizeProvider(provider);
  return broker
    ? await broker.getOAuthApiKey(normalized)
    : await getLocalLlmOAuthApiKey(stellaDataDirPath, normalized);
};
