/**
 * Shared connection-state lookup for native Store integrations.
 *
 * One place answers "is this integration usable right now?" for the
 * node_repl connect client (discover/connectors), the connector keyword
 * reminder, and the orchestrator's `connector_status` tool.
 */

import {
  getNativeConnectorTools,
  isNativeConnectorEnabled,
  type NativeConnectorCatalogEntry,
} from "./native-integrations.js";
import { getNativeOAuthProviderConfig } from "./native-oauth-provider-config.js";
import { loadConnectorAccessToken, loadConnectorTokenPayload } from "./oauth.js";
import {
  getRequiredScopesForIntegration,
  hasRequiredScopes,
} from "../google-workspace/scopes.js";

export type NativeConnectorAuthStatus =
  | "connected"
  | "backend_managed_unverified"
  | "local_implementation_incomplete"
  | "scope_upgrade_required"
  | "not_logged_in"
  | "unsupported";

/**
 * Credential-side status only (does a usable token/account exist?).
 * `backend-composio` accounts live server-side behind the user's Stella
 * auth, so they are reported as connected — enablement is the local
 * gate for those.
 */
export const nativeConnectorAuthStatus = async (
  stellaDataDir: string,
  entry: NativeConnectorCatalogEntry,
): Promise<NativeConnectorAuthStatus> => {
  if (entry.provider === "google-workspace") {
    // The shared Google grant covers every Workspace service, so status is
    // scope-aware. A valid grant that predates a service's scope (e.g.
    // Sheets or Tasks added later) is NOT "not_logged_in" — the account is
    // linked — it needs an incremental scope upgrade, surfaced explicitly as
    // "scope_upgrade_required" so the reconnect unions in the missing scope.
    // Only the absence of any usable token is "not_logged_in".
    const payload = await loadConnectorTokenPayload(
      stellaDataDir,
      "google-workspace",
    );
    if (!payload?.accessToken) return "not_logged_in";
    return hasRequiredScopes(
      payload.scopes,
      getRequiredScopesForIntegration(entry.id),
    )
      ? "connected"
      : "scope_upgrade_required";
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
  /** Enabled AND credentialed — safe to call through connect.call. */
  connected: boolean;
  /** True only when this process actually verified a provider credential. */
  accountVerified: boolean;
};

export type NativeConnectorReadiness = NativeConnectorConnectionState & {
  toolCount: number;
  /** The CLI has a dispatcher it can attempt with the current local state. */
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
    // A valid grant is a verified account even when it lacks a service's
    // scope (scope_upgrade_required); it just isn't executable yet.
    accountVerified:
      authStatus === "connected" || authStatus === "scope_upgrade_required",
  };
};

/**
 * Provider-aware operational readiness shared by status and CLI consumers.
 * Backend execution is intentionally actionable without claiming the remote
 * provider account was verified; the run endpoint remains the auth authority.
 */
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
