import {
  deleteConnectorAccessTokens,
  loadConnectorTokenPayload,
} from "../connectors/oauth.js";
import { MICROSOFT_TOKEN_KEY } from "./constants.js";
import { hasRequiredMicrosoftScopes } from "./scopes.js";
import { logToFile } from "./logger.js";

/**
 * Auth adapter for the first-party Microsoft Graph services.
 *
 * Tokens are owned by the connector protected storage (the shared
 * `native-oauth:microsoft` grant). {@link loadConnectorTokenPayload} performs
 * near-expiry refresh transparently, so this class only loads the current
 * credential, verifies the required scopes are present, and hands the access
 * token to the {@link GraphClient}. It never persists or logs secrets.
 */
export class MicrosoftAuthManager {
  constructor(
    private readonly stellaAppDir: string,
    private readonly requiredScopes: readonly string[] = [],
  ) {}

  /** Returns a valid bearer token, throwing a connect-actionable error otherwise. */
  public getAccessToken = async (): Promise<string> => {
    const payload = await loadConnectorTokenPayload(
      this.stellaAppDir,
      MICROSOFT_TOKEN_KEY,
    );
    if (!payload?.accessToken) {
      throw new Error("Microsoft is not connected.");
    }
    if (this.requiredScopes.length > 0) {
      const missing = this.requiredScopes.filter(
        (scope) => !hasRequiredMicrosoftScopes(payload.scopes, [scope]),
      );
      if (missing.length > 0) {
        logToFile(
          `Connector token missing Microsoft Graph scopes: ${missing.join(", ")}`,
        );
        throw new Error("Microsoft needs to be reconnected.");
      }
    }
    return payload.accessToken;
  };

  /** True when a Microsoft credential is stored (regardless of scope coverage). */
  public async hasStoredCredentials(): Promise<boolean> {
    const payload = await loadConnectorTokenPayload(
      this.stellaAppDir,
      MICROSOFT_TOKEN_KEY,
    );
    return Boolean(payload?.accessToken);
  }

  /** The scopes the current stored grant carries, if any. */
  public async getGrantedScopes(): Promise<string[] | undefined> {
    const payload = await loadConnectorTokenPayload(
      this.stellaAppDir,
      MICROSOFT_TOKEN_KEY,
    );
    return payload?.scopes;
  }

  /** Forgets the shared Microsoft grant. Shared across all Microsoft services. */
  public async clearAuth(): Promise<void> {
    await deleteConnectorAccessTokens(this.stellaAppDir, [MICROSOFT_TOKEN_KEY]);
  }
}
