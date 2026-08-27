import { useCallback } from "react";
import type {
  LocalLlmCredentialSummary,
  LocalLlmOAuthProviderSummary,
} from "@/shared/types/electron";
import {
  createResourceStore,
  useResourceStore,
} from "@/shared/lib/resource-cache";

export const PROVIDER_CONNECTED_EVENT = "stella:llm-provider-connected";

export interface ProviderConnectedEventDetail {
  provider: string;
  kind: "api-key" | "oauth";
}

declare global {
  interface WindowEventMap {
    [PROVIDER_CONNECTED_EVENT]: CustomEvent<ProviderConnectedEventDetail>;
  }
}

type CredentialSnapshot = {
  apiKeys: LocalLlmCredentialSummary[];
  oauthProviders: LocalLlmOAuthProviderSummary[];
  oauthCredentials: LocalLlmCredentialSummary[];
};

export type LlmCredentialState = CredentialSnapshot & {
  loading: boolean;
  error: string | null;
};

export type LlmCredentialActions = {
  reload: () => Promise<void>;
  saveApiKey: (
    provider: string,
    label: string,
    plaintext: string,
  ) => Promise<void>;
  removeApiKey: (provider: string) => Promise<void>;
  loginOAuth: (
    provider: string,
    options?: { announceConnection?: boolean },
  ) => Promise<void>;
  cancelOAuth: (provider: string) => Promise<void>;
  validateOAuth: (provider: string) => Promise<{
    connected: boolean;
    needsReauth: boolean;
  }>;
  logoutOAuth: (provider: string) => Promise<void>;
};

export type LlmCredentials = LlmCredentialState & LlmCredentialActions;

const EMPTY_SNAPSHOT: CredentialSnapshot = {
  apiKeys: [],
  oauthProviders: [],
  oauthCredentials: [],
};

const SINGLETON_KEY = "default" as const;

const credentialStore = createResourceStore<
  typeof SINGLETON_KEY,
  CredentialSnapshot
>({
  fetcher: async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.listLlmCredentials) {
      return EMPTY_SNAPSHOT;
    }
    const [apiKeys, oauthProviders, oauthCredentials] = await Promise.all([
      systemApi.listLlmCredentials(),
      systemApi.listLlmOAuthProviders?.() ?? Promise.resolve([]),
      systemApi.listLlmOAuthCredentials?.() ?? Promise.resolve([]),
    ]);
    return { apiKeys, oauthProviders, oauthCredentials };
  },
});

const knownConnected = new Set<string>();
let knownConnectedSeeded = false;

const seedKnownConnected = (snapshot: CredentialSnapshot) => {
  knownConnected.clear();
  for (const entry of snapshot.apiKeys) {
    if (entry.status === "active") knownConnected.add(entry.provider);
  }
  for (const entry of snapshot.oauthCredentials) {
    if (entry.status === "active") knownConnected.add(entry.provider);
  }
  knownConnectedSeeded = true;
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const upsertCredential = (
  list: LocalLlmCredentialSummary[],
  next: LocalLlmCredentialSummary,
): LocalLlmCredentialSummary[] => {
  const filtered = list.filter((entry) => entry.provider !== next.provider);
  filtered.push(next);
  filtered.sort((a, b) => a.label.localeCompare(b.label));
  return filtered;
};

const removeProvider = <T extends { provider: string }>(
  list: T[],
  provider: string,
): T[] => list.filter((entry) => entry.provider !== provider);

const dispatchConnected = (
  provider: string,
  kind: ProviderConnectedEventDetail["kind"],
) => {
  if (knownConnected.has(provider)) return;
  knownConnected.add(provider);
  window.dispatchEvent(
    new CustomEvent<ProviderConnectedEventDetail>(PROVIDER_CONNECTED_EVENT, {
      detail: { provider, kind },
    }),
  );
};

export function useLlmCredentials(): LlmCredentials {
  const { data, error, isLoading, refresh } = useResourceStore(
    credentialStore,
    SINGLETON_KEY,
  );
  const snapshot = data ?? EMPTY_SNAPSHOT;
  if (data && !knownConnectedSeeded) seedKnownConnected(data);

  const reload = useCallback(async () => {
    const next = await refresh();
    if (next) seedKnownConnected(next);
  }, [refresh]);

  const saveApiKey = useCallback(
    async (provider: string, label: string, plaintext: string) => {
      if (!window.electronAPI?.system?.saveLlmCredential) {
        throw new Error("Local API key storage is unavailable in this window.");
      }
      const wasConnected = knownConnected.has(provider);
      const saved = await window.electronAPI.system.saveLlmCredential({
        provider,
        label,
        plaintext,
      });
      const current = credentialStore.get(SINGLETON_KEY).data ?? EMPTY_SNAPSHOT;
      credentialStore.set(SINGLETON_KEY, {
        ...current,
        apiKeys: upsertCredential(current.apiKeys, saved),
      });
      if (!wasConnected) dispatchConnected(provider, "api-key");
    },
    [],
  );

  const removeApiKey = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.deleteLlmCredential) {
      throw new Error("Local API key storage is unavailable in this window.");
    }
    await window.electronAPI.system.deleteLlmCredential(provider);
    const current = credentialStore.get(SINGLETON_KEY).data ?? EMPTY_SNAPSHOT;
    credentialStore.set(SINGLETON_KEY, {
      ...current,
      apiKeys: removeProvider(current.apiKeys, provider),
    });
    knownConnected.delete(provider);
  }, []);

  const loginOAuth = useCallback(
    async (provider: string, options?: { announceConnection?: boolean }) => {
      if (!window.electronAPI?.system?.loginLlmOAuthCredential) {
        throw new Error("OAuth login is unavailable in this window.");
      }
      const wasConnected = knownConnected.has(provider);
      const saved =
        await window.electronAPI.system.loginLlmOAuthCredential(provider);
      const current = credentialStore.get(SINGLETON_KEY).data ?? EMPTY_SNAPSHOT;
      credentialStore.set(SINGLETON_KEY, {
        ...current,
        oauthCredentials: upsertCredential(current.oauthCredentials, saved),
      });
      if (!wasConnected) {
        if (options?.announceConnection === false) {
          knownConnected.add(provider);
        } else {
          dispatchConnected(provider, "oauth");
        }
      }
    },
    [],
  );

  const logoutOAuth = useCallback(async (provider: string) => {
    if (!window.electronAPI?.system?.deleteLlmOAuthCredential) {
      throw new Error("OAuth login is unavailable in this window.");
    }
    await window.electronAPI.system.deleteLlmOAuthCredential(provider);
    const current = credentialStore.get(SINGLETON_KEY).data ?? EMPTY_SNAPSHOT;
    credentialStore.set(SINGLETON_KEY, {
      ...current,
      oauthCredentials: removeProvider(current.oauthCredentials, provider),
    });
    knownConnected.delete(provider);
  }, []);

  const cancelOAuth = useCallback(async (provider: string) => {
    await window.electronAPI?.system?.cancelLlmOAuthCredential?.(provider);
  }, []);

  const validateOAuth = useCallback(async (provider: string) => {
    const result =
      await window.electronAPI?.system?.validateLlmOAuthCredential?.(provider);
    const next = result ?? { connected: false, needsReauth: false };
    if (!next.connected) {
      const current = credentialStore.get(SINGLETON_KEY).data ?? EMPTY_SNAPSHOT;
      credentialStore.set(SINGLETON_KEY, {
        ...current,
        oauthCredentials: removeProvider(current.oauthCredentials, provider),
      });
      knownConnected.delete(provider);
    }
    return next;
  }, []);

  return {
    apiKeys: snapshot.apiKeys,
    oauthProviders: snapshot.oauthProviders,
    oauthCredentials: snapshot.oauthCredentials,
    loading: isLoading,
    error: error ? errorMessage(error, "Failed to load local API keys.") : null,
    reload,
    saveApiKey,
    removeApiKey,
    loginOAuth,
    cancelOAuth,
    validateOAuth,
    logoutOAuth,
  };
}

export const findApiKey = (
  credentials: readonly LocalLlmCredentialSummary[],
  provider: string,
) =>
  credentials.find(
    (credential) =>
      credential.provider === provider && credential.status === "active",
  );

export const findOauthProvider = (
  providers: readonly LocalLlmOAuthProviderSummary[],
  provider: string,
) => providers.find((entry) => entry.provider === provider);

export const findOauthCredential = (
  credentials: readonly LocalLlmCredentialSummary[],
  provider: string,
) =>
  credentials.find(
    (credential) =>
      credential.provider === provider && credential.status === "active",
  );
