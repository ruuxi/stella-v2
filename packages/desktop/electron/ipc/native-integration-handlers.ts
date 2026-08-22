import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

import {
  disableNativeConnector,
  enableNativeConnector,
  getNativeConnectorCatalogEntry,
  getNativeConnectorOAuthConfig,
  listNativeConnectors,
  type NativeConnectorCatalogEntry,
} from "@stella/runtime/kernel/connectors/native-integrations";
import {
  resolveNativeConnectorCatalog,
  type ResolvedNativeCatalog,
} from "@stella/runtime/kernel/connectors/catalog-cache";
import {
  hasNativeOAuthProviderClientIdOverride,
  isNativeOAuthProviderConfigReady,
} from "@stella/runtime/kernel/connectors/native-oauth-provider-config";
import { loadConnectorAccessToken } from "@stella/runtime/kernel/connectors/oauth";
import { waitForBackendIntegrationConnection } from "./backend-integration-status.js";
import { loadConfig } from "@stella/runtime/kernel/google-workspace/config";
import { SCOPES as GOOGLE_WORKSPACE_SCOPES } from "@stella/runtime/kernel/google-workspace/scopes";
import { assertPrivilegedRequest } from "./privileged-ipc.js";

export type NativeIntegrationHandlersOptions = {
  getStellaAppDir: () => string | null;
  requestPreregisteredOAuth?: (payload: {
    tokenKey: string;
    displayName: string;
    clientId: string;
    authorizationEndpoint: string;
    tokenEndpoint?: string;
    responseType?: "code" | "token";
    scopes?: string[];
    resourceUrl?: string;
    oauthResource?: string | null;
    callbackUrl?: string;
    callbackId?: string;
    callbackMode?: "local" | "external";
    scopeSeparator?: string;
    usesPkce?: boolean;
    authorizationRedirectParam?: string;
    authorizationParams?: Record<string, string>;
    tokenRedirectParam?: string;
    tokenAuth?: "body" | "basic";
    tokenExchange?: {
      type: "backend";
      provider: string;
    };
    description?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  requestDeviceOAuth?: (payload: {
    tokenKey: string;
    displayName: string;
    clientId: string;
    deviceAuthorizationEndpoint: string;
    tokenEndpoint: string;
    scopes?: string[];
    resourceUrl?: string;
    verificationUri?: string;
    description?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  requestExternalOAuthApproval?: (payload: {
    tokenKey: string;
    displayName: string;
    resourceUrl: string;
    description?: string;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  requestBackendApiKey?: (payload: {
    connectorId: string;
    displayName: string;
    credentialLabel: string;
    expectedGeneration?: number;
  }) => Promise<
    | { ok: true }
    | { ok: false; reason: "cancelled" | "timeout" | "unsupported" | string }
  >;
  disconnectGoogleWorkspace?: () => Promise<{ ok: boolean }>;
  getConvexAuthToken?: () => Promise<string | null>;
  getConvexSiteUrl?: () => string | null;
  assertPrivilegedSender: (
    event: IpcMainEvent | IpcMainInvokeEvent,
    channel: string,
  ) => boolean;
};

/**
 * The subset of the handler options that the credential/enable flow
 * actually consumes. Exported so the in-chat connect card service can
 * run the exact Store connect flow with its own (headless) OAuth
 * callbacks instead of the modal-backed ones.
 */
export type NativeCredentialFlowOptions = Pick<
  NativeIntegrationHandlersOptions,
  | "requestPreregisteredOAuth"
  | "requestDeviceOAuth"
  | "requestExternalOAuthApproval"
  | "requestBackendApiKey"
  | "getConvexAuthToken"
  | "getConvexSiteUrl"
> & {
  /**
   * Abort hook for the backend Composio completion wait (the in-chat
   * connect card threads its cancel/abort controller through here).
   */
  abortSignal?: AbortSignal;
};

type BackendOAuthProvidersResponse = {
  providers?: Array<{
    id?: unknown;
    clientId?: unknown;
    externalCallbackReady?: unknown;
  }>;
};

type ConfiguredOAuthProviderSets = {
  backend: ReadonlySet<string>;
  externalCallback: ReadonlySet<string>;
};

const readId = (payload: unknown) => {
  const id =
    payload && typeof payload === "object"
      ? (payload as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("Missing integration id.");
  }
  return id.trim();
};

const requireRoot = (options: NativeIntegrationHandlersOptions) => {
  const stellaAppDir = options.getStellaAppDir();
  if (!stellaAppDir) throw new Error("Stella root is unavailable.");
  return stellaAppDir;
};

const emptyConfiguredOAuthProviders = (): ConfiguredOAuthProviderSets => ({
  backend: new Set(),
  externalCallback: new Set(),
});

export const loadConfiguredOAuthProviders = async (
  options: NativeCredentialFlowOptions,
) => {
  const siteUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
  if (!siteUrl) return emptyConfiguredOAuthProviders();
  const authToken = await options.getConvexAuthToken?.();
  if (!authToken) return emptyConfiguredOAuthProviders();
  const response = await fetch(`${siteUrl}/api/native-oauth/providers`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${authToken}`,
    },
    // Bounded: this runs inside connect flows whose card must never be
    // stranded by a hung request; a slow backend degrades to "no
    // configured providers" instead of blocking.
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) return emptyConfiguredOAuthProviders();
  const payload = (await response
    .json()
    .catch(() => null)) as BackendOAuthProvidersResponse | null;
  const backend = new Set<string>();
  const externalCallback = new Set<string>();
  for (const provider of payload?.providers ?? []) {
    const id =
      typeof provider.id === "string" ? provider.id.trim().toLowerCase() : "";
    if (!id) continue;
    backend.add(id);
    // The hosted stella.sh OAuth callback route is provider-generic. Once a
    // provider has a server-side token exchange configured, an external
    // callback config can use the same bridge without another desktop code
    // change.
    if (provider.externalCallbackReady !== false) externalCallback.add(id);
  }
  return { backend, externalCallback };
};

const createBackendIntegrationConnectTarget = async (
  // Pre-resolved auth: the caller carries the SAME values into the
  // completion-status wait afterwards, so a transient auth loss between
  // link creation and polling can't silently skip the confirmation.
  auth: { siteUrl: string; authToken: string },
  id: string,
  signal?: AbortSignal,
) => {
  const { siteUrl, authToken } = auth;
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(
    `${siteUrl}/api/native-integrations/connect-link`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ id }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    },
  ).catch(() => {
    // Distinguishes a hung/failed request from an HTTP error below; the
    // connect flow surfaces this on the card instead of hanging.
    throw new Error("Stella's backend did not respond while creating the connection link.");
  });
  const payload = (await response.json().catch(() => null)) as {
    url?: unknown;
    authType?: unknown;
    credentialLabel?: unknown;
    expectedGeneration?: unknown;
    error?: unknown;
    message?: unknown;
  } | null;
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.message === "string"
          ? payload.message
          : "Could not start this connection.";
    throw new Error(message);
  }
  if (payload?.authType === "api_key") {
    const credentialLabel =
      typeof payload.credentialLabel === "string"
        ? payload.credentialLabel.trim()
        : "";
    const expectedGeneration = payload.expectedGeneration;
    if (
      !credentialLabel ||
      (expectedGeneration !== undefined &&
        (typeof expectedGeneration !== "number" ||
          !Number.isSafeInteger(expectedGeneration) ||
          expectedGeneration < 1))
    ) {
      throw new Error("Stella backend returned an invalid API-key prompt.");
    }
    return {
      authType: "api_key" as const,
      credentialLabel,
      expectedGeneration:
        typeof expectedGeneration === "number" ? expectedGeneration : undefined,
    };
  }
  const url = typeof payload?.url === "string" ? payload.url.trim() : "";
  if (!url) throw new Error("Stella backend did not return a connect link.");
  return { authType: "oauth" as const, url };
};

const disconnectBackendApiKeyIfConfigured = async (
  options: NativeCredentialFlowOptions,
  id: string,
) => {
  const siteUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
  const authToken = await options.getConvexAuthToken?.();
  if (!siteUrl || !authToken) return;
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${authToken}`,
  };
  const response = await fetch(
    `${siteUrl}/api/native-integrations/disconnect`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(30_000),
    },
  ).catch(() => null);
  // A 400 means this is an OAuth connector; 404 keeps older backends
  // compatible. Any other failure leaves local enablement untouched so the UI
  // never claims a server-owned key was destroyed when it may still exist.
  if (response?.ok || response?.status === 400 || response?.status === 404) {
    return;
  }
  throw new Error("Could not destroy the server-owned API key.");
};

export const resolveDesktopNativeConnectorCatalog = async (
  options: NativeCredentialFlowOptions,
  stellaAppDir: string,
): Promise<ResolvedNativeCatalog> =>
  resolveNativeConnectorCatalog({
    stellaDataDir: stellaAppDir,
    getStellaSiteAuth: async () => {
      const baseUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
      const authToken = (await options.getConvexAuthToken?.())?.trim() ?? "";
      return baseUrl && authToken ? { baseUrl, authToken } : null;
    },
  });

export const resolveDesktopNativeConnectorEntry = async (
  options: NativeCredentialFlowOptions,
  stellaAppDir: string,
  id: string,
) => {
  const catalog = await resolveDesktopNativeConnectorCatalog(
    options,
    stellaAppDir,
  );
  return {
    catalog,
    entry: getNativeConnectorCatalogEntry(id, catalog.entries),
  };
};

export type ResolvedNativeCredentialTarget = {
  catalog: ResolvedNativeCatalog;
  entry: NativeConnectorCatalogEntry;
};

export const ensureNativeCredential = async (
  options: NativeCredentialFlowOptions,
  stellaAppDir: string,
  id: string,
  acceptedTarget?: ResolvedNativeCredentialTarget,
) => {
  const configuredOAuthProviders = await loadConfiguredOAuthProviders(options);
  const entry = acceptedTarget
    ? acceptedTarget.entry
    : (await resolveDesktopNativeConnectorEntry(options, stellaAppDir, id))
        .entry;
  if (acceptedTarget && acceptedTarget.entry.id !== id) {
    throw new Error("Accepted connector snapshot does not match the request.");
  }
  if (entry?.provider === "google-workspace") {
    if (await loadConnectorAccessToken(stellaAppDir, "google-workspace"))
      return;
    if (!options.requestPreregisteredOAuth) {
      throw new Error("Google Workspace connection is unavailable.");
    }
    const config = loadConfig();
    if (!configuredOAuthProviders.backend.has("google-workspace")) {
      throw new Error("Google Workspace secure connection is not ready yet.");
    }
    const connected = await options.requestPreregisteredOAuth({
      tokenKey: "google-workspace",
      displayName: "Google Workspace",
      clientId: config.clientId,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scopes: GOOGLE_WORKSPACE_SCOPES,
      // Google incremental auth: carry forward already-granted scopes so a
      // reconnect to upgrade one service returns the union, not a shrunk set.
      authorizationParams: { include_granted_scopes: "true" },
      tokenExchange: {
        type: "backend",
        provider: "google-workspace",
      },
      description:
        "Stella needs to open Google in your browser so you can sign in and approve Workspace access.",
    });
    if (!connected.ok) {
      throw new Error(
        `Could not connect Google Workspace: ${connected.reason}`,
      );
    }
    return;
  }

  if (entry?.provider === "backend-composio") {
    if (!options.requestExternalOAuthApproval) {
      throw new Error(`${entry.name} connection is unavailable.`);
    }
    // Resolve auth ONCE and reuse it for both the connect link and the
    // completion wait below. Re-reading it after the browser hop could
    // silently come back empty (transient auth loss / sign-out) and must
    // not turn into an implicit "connected".
    const siteUrl = options.getConvexSiteUrl?.()?.trim().replace(/\/+$/u, "");
    if (!siteUrl) throw new Error("Stella backend is unavailable.");
    const authToken = await options.getConvexAuthToken?.();
    if (!authToken) {
      throw new Error(`Sign in to Stella before connecting ${entry.name}.`);
    }
    const target = await createBackendIntegrationConnectTarget(
      { siteUrl, authToken },
      id,
      options.abortSignal,
    );
    if (target.authType === "api_key") {
      if (!options.requestBackendApiKey) {
        throw new Error(`${entry.name} API-key connection is unavailable.`);
      }
      const connected = await options.requestBackendApiKey({
        connectorId: id,
        displayName: entry.name,
        credentialLabel: target.credentialLabel,
        expectedGeneration: target.expectedGeneration,
      });
      if (!connected.ok) {
        throw new Error(`Could not connect ${entry.name}: ${connected.reason}`);
      }
      return;
    }
    // "ok" here only means the browser was opened with the user's
    // consent — Composio OAuth finishes on a hosted page with no
    // deep-link back to the desktop, so completion is confirmed below.
    const approved = await options.requestExternalOAuthApproval({
      tokenKey: `backend-integration:${id}`,
      displayName: entry.name,
      resourceUrl: target.url,
      description: `Stella needs to open ${entry.name} in your browser so you can sign in and approve access.`,
    });
    if (!approved.ok) {
      throw new Error(`Could not connect ${entry.name}: ${approved.reason}`);
    }
    // Real completion signal: poll the backend for the Composio
    // account status (with the auth carried from link creation) instead
    // of assuming success. ONLY "unsupported" (status endpoint not
    // deployed yet, 404/405) may degrade to the previous optimistic
    // behavior; every other non-connected outcome fails the enable.
    const wait = await waitForBackendIntegrationConnection({
      siteUrl,
      authToken,
      id,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    if (wait === "connected" || wait === "unsupported") return;
    if (wait === "cancelled") {
      throw new Error(`Could not connect ${entry.name}: cancelled`);
    }
    if (wait === "auth_unavailable") {
      throw new Error(
        `Could not confirm the ${entry.name} connection because Stella's sign-in expired. Sign in and try connecting again.`,
      );
    }
    throw new Error(
      `${entry.name} authorization was not completed in the browser. Finish signing in on the ${entry.name} page that opened, then try connecting again.`,
    );
  }

  if (entry?.provider === "oauth-catalog") {
    const config = getNativeConnectorOAuthConfig(entry);
    if (!config) {
      throw new Error(
        `${entry.name} supports OAuth, but Stella's provider setup is not ready yet.`,
      );
    }
    if (
      !isNativeOAuthProviderConfigReady(id, config, {
        configuredBackendProviders: configuredOAuthProviders.backend,
        configuredExternalCallbackProviders:
          configuredOAuthProviders.externalCallback,
      })
    ) {
      if (config.tokenExchange?.type === "backend") {
        const tokenExchangeProvider = (config.tokenExchange.provider ?? id)
          .trim()
          .toLowerCase();
        const hasExplicitOAuthApp =
          hasNativeOAuthProviderClientIdOverride(id) ||
          hasNativeOAuthProviderClientIdOverride(tokenExchangeProvider);
        if (!hasExplicitOAuthApp) {
          throw new Error(
            `${entry.name} supports OAuth, but Stella's provider setup is not ready yet.`,
          );
        }
        throw new Error(
          `${entry.name} supports OAuth, but Stella's secure server connection is not ready yet.`,
        );
      }
      if (
        config.flow === "authorization_code" &&
        config.callbackMode === "external"
      ) {
        throw new Error(
          `${entry.name} supports OAuth, but Stella's browser return link is not ready yet.`,
        );
      }
      throw new Error(
        `${entry.name} supports OAuth, but Stella's provider setup is not ready yet.`,
      );
    }
    if (await loadConnectorAccessToken(stellaAppDir, config.tokenKey)) return;
    const connected =
      config.flow === "device"
        ? await options.requestDeviceOAuth?.({
            tokenKey: config.tokenKey,
            displayName: entry.name,
            clientId: config.clientId,
            deviceAuthorizationEndpoint: config.deviceAuthorizationEndpoint,
            tokenEndpoint: config.tokenEndpoint!,
            scopes: config.scopes,
            resourceUrl: config.resourceUrl,
            verificationUri: config.verificationUri,
            description: `Stella needs to open ${entry.name} in your browser. Enter the code shown here to approve access.`,
          })
        : await options.requestPreregisteredOAuth?.({
            tokenKey: config.tokenKey,
            displayName: entry.name,
            clientId: config.clientId,
            authorizationEndpoint: config.authorizationEndpoint,
            tokenEndpoint: config.tokenEndpoint,
            responseType: config.responseType,
            scopes: config.scopes,
            resourceUrl: config.resourceUrl,
            oauthResource: config.oauthResource,
            callbackUrl: config.callbackUrl,
            callbackId: config.callbackId,
            callbackMode: config.callbackMode,
            scopeSeparator: config.scopeSeparator,
            usesPkce: config.usesPkce,
            authorizationRedirectParam: config.authorizationRedirectParam,
            authorizationParams: config.authorizationParams,
            tokenRedirectParam: config.tokenRedirectParam,
            tokenAuth: config.tokenAuth,
            tokenExchange:
              config.tokenExchange?.type === "backend"
                ? {
                    type: "backend",
                    provider: config.tokenExchange.provider ?? id,
                  }
                : undefined,
            description: `Stella needs to open ${entry.name} in your browser so you can sign in and approve access.`,
          });
    if (!connected) {
      throw new Error(`${entry.name} connection is unavailable.`);
    }
    if (!connected.ok) {
      throw new Error(`Could not connect ${entry.name}: ${connected.reason}`);
    }
    return;
  }

  throw new Error(
    `${entry?.name ?? id} is not available as an OAuth Store integration yet.`,
  );
};

export const listDesktopNativeIntegrations = async (
  options: NativeIntegrationHandlersOptions,
) => {
  const configuredOAuthProviders = await loadConfiguredOAuthProviders(options);
  const stellaAppDir = requireRoot(options);
  const catalog = await resolveDesktopNativeConnectorCatalog(
    options,
    stellaAppDir,
  );
  return await listNativeConnectors(
    stellaAppDir,
    {
      configuredBackendProviders: configuredOAuthProviders.backend,
      configuredExternalCallbackProviders:
        configuredOAuthProviders.externalCallback,
    },
    catalog.entries,
  );
};

export const enableDesktopNativeIntegration = async (
  options: NativeIntegrationHandlersOptions,
  payload: unknown,
) => {
  const stellaAppDir = requireRoot(options);
  const id = readId(payload);
  await ensureNativeCredential(options, stellaAppDir, id);
  const configuredOAuthProviders = await loadConfiguredOAuthProviders(options);
  const catalog = await resolveDesktopNativeConnectorCatalog(
    options,
    stellaAppDir,
  );
  return await enableNativeConnector(
    stellaAppDir,
    id,
    "store",
    {
      configuredBackendProviders: configuredOAuthProviders.backend,
      configuredExternalCallbackProviders:
        configuredOAuthProviders.externalCallback,
    },
    catalog.entries,
  );
};

export const disableDesktopNativeIntegration = async (
  options: NativeIntegrationHandlersOptions,
  payload: unknown,
) => {
  const stellaAppDir = requireRoot(options);
  const id = readId(payload);
  const configuredOAuthProviders = await loadConfiguredOAuthProviders(options);
  const catalog = await resolveDesktopNativeConnectorCatalog(
    options,
    stellaAppDir,
  );
  const entry = getNativeConnectorCatalogEntry(id, catalog.entries);
  if (entry?.provider === "backend-composio") {
    await disconnectBackendApiKeyIfConfigured(options, id);
  }
  const result = await disableNativeConnector(
    stellaAppDir,
    id,
    {
      configuredBackendProviders: configuredOAuthProviders.backend,
      configuredExternalCallbackProviders:
        configuredOAuthProviders.externalCallback,
    },
    catalog.entries,
  );
  if (
    entry?.provider === "google-workspace" &&
    options.disconnectGoogleWorkspace
  ) {
    const remaining = await listNativeConnectors(
      stellaAppDir,
      {},
      catalog.entries,
    );
    const stillEnabledGoogle = remaining.some(
      (connector) =>
        connector.provider === "google-workspace" && connector.enabled,
    );
    if (!stillEnabledGoogle) {
      await options.disconnectGoogleWorkspace();
    }
  }
  return result;
};

export const registerNativeIntegrationHandlers = (
  options: NativeIntegrationHandlersOptions,
) => {
  ipcMain.handle("nativeIntegrations:list", async (event) => {
    assertPrivilegedRequest(options, event, "nativeIntegrations:list");
    return await listDesktopNativeIntegrations(options);
  });

  ipcMain.handle(
    "nativeIntegrations:enable",
    async (event, payload: unknown) => {
      assertPrivilegedRequest(options, event, "nativeIntegrations:enable");
      return await enableDesktopNativeIntegration(options, payload);
    },
  );

  ipcMain.handle(
    "nativeIntegrations:disable",
    async (event, payload: unknown) => {
      assertPrivilegedRequest(options, event, "nativeIntegrations:disable");
      return await disableDesktopNativeIntegration(options, payload);
    },
  );
};
