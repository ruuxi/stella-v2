import {
  getNativeConnectorTools,
  isNativeConnectorEnabled,
  type NativeConnectorCatalogEntry,
} from "./native-integrations.js";
import { getNativeOAuthProviderConfig } from "./native-oauth-provider-config.js";
import { loadConnectorAccessToken } from "./oauth.js";

export type NativeConnectorAuthStatus =
  | "connected"
  | "backend_managed_unverified"
  | "local_implementation_incomplete"
  | "not_logged_in"
  | "unsupported";

export const nativeConnectorAuthStatus = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
): Promise<NativeConnectorAuthStatus> => {
  if (entry.provider === "google-workspace") {
    return (await loadConnectorAccessToken(stellaDataDir, "google-workspace"))
      ? "connected"
      : "not_logged_in";
  }
  if (entry.provider === "backend-composio")
    return "backend_managed_unverified";
  if (entry.localExecution !== "production-ready") {
    return "local_implementation_incomplete";
  }
  const config = entry.oauthConfig ?? getNativeOAuthProviderConfig(entry.id);
  if (!config?.tokenKey) return "unsupported";
  return (await loadConnectorAccessToken(stellaDataDir, config.tokenKey))
    ? "connected"
    : "not_logged_in";
};

export type NativeConnectorConnectionState = {
  enabled: boolean;
  authStatus: NativeConnectorAuthStatus;

  connected: boolean;

  accountVerified: boolean;
};

export type NativeConnectorReadiness = NativeConnectorConnectionState & {
  toolCount: number;

  executable: boolean;
};

export const getNativeConnectorConnectionState = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
): Promise<NativeConnectorConnectionState> => {
  const [enabled, authStatus] = await Promise.all([
    isNativeConnectorEnabled(stellaDataDir, entry.id),
    nativeConnectorAuthStatus(stellaDataDir, entry),
  ]);
  return {
    enabled,
    authStatus,
    connected:
      enabled &&
      (authStatus === "connected" ||
        authStatus === "backend_managed_unverified"),
    accountVerified: authStatus === "connected",
  };
};

export const getNativeConnectorReadiness = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
): Promise<NativeConnectorReadiness> => {
  const state = await getNativeConnectorConnectionState(stellaDataDir, entry);
  const toolCount = getNativeConnectorTools(entry).length;
  const credentialReady =
    state.authStatus === "connected" ||
    state.authStatus === "backend_managed_unverified";
  return {
    ...state,
    toolCount,
    executable: state.enabled && toolCount > 0 && credentialReady,
  };
};
