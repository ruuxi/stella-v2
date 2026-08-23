/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Effect } from "effect";
import { google, Auth } from "googleapis";
import {
  deleteConnectorAccessTokens,
  loadConnectorTokenPayload,
  saveConnectorTokenPayload,
} from "../connectors/oauth.js";
import { getProjectRoot } from "./paths.js";
import { loadConfig } from "./config.js";
import { logToFile } from "./logger.js";
import {
  runGoogleWorkspaceEffect,
  tryGoogleWorkspaceOp,
  tryGoogleWorkspaceSync,
} from "./effect-runtime.js";
import {
  GoogleWorkspaceNotConnectedError,
  GoogleWorkspaceProjectRootError,
  GoogleWorkspaceReconnectRequiredError,
} from "./errors.js";

const TOKEN_KEY = "google-workspace";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const stellaAppDirFromProjectRoot = () => {
  const projectRoot = getProjectRoot();
  const suffix = "/google-workspace";
  if (!projectRoot.endsWith(suffix)) {
    throw new GoogleWorkspaceProjectRootError();
  }
  return projectRoot.slice(0, -suffix.length);
};

/**
 * Small auth adapter for the existing Google Workspace service classes.
 *
 * The old implementation had its own plaintext token file, cloud-function
 * exchange, and browser opener. Store-native integrations now own OAuth:
 * tokens live in connector protected storage and browser launch is brokered
 * by the shared connector dialog before this class is ever asked for a client.
 *
 * M5: the token/profile IO runs as Effects on the shared
 * `googleWorkspaceRuntime`; the public methods stay plain-Promise facades
 * that reject with the original failure objects (tagged parity errors carry
 * the exact pre-Effect messages). The `client.on("tokens")` persistence
 * callback stays a plain async closure because googleapis invokes it from
 * non-Effect land.
 */
export class AuthManager {
  private client: Auth.OAuth2Client | null = null;
  private readonly clientId = loadConfig().clientId;
  private onStatusUpdate: ((message: string) => void) | null = null;

  constructor(private scopes: string[]) {}

  public setOnStatusUpdate(callback: (message: string) => void) {
    this.onStatusUpdate = callback;
  }

  public dispose(): void {
    this.onStatusUpdate = null;
    this.client = null;
  }

  private getAuthenticatedClientEffect(): Effect.Effect<
    Auth.OAuth2Client,
    unknown
  > {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return Effect.gen(function* () {
      const stellaAppDir = yield* tryGoogleWorkspaceSync(
        stellaAppDirFromProjectRoot,
      );
      const payload = yield* tryGoogleWorkspaceOp(() =>
        loadConnectorTokenPayload(stellaAppDir, TOKEN_KEY),
      );
      if (!payload?.accessToken) {
        return yield* Effect.fail(new GoogleWorkspaceNotConnectedError());
      }

      const savedScopes = new Set(payload.scopes ?? []);
      const missingScopes = self.scopes.filter(
        (scope) => !savedScopes.has(scope),
      );
      if (missingScopes.length > 0) {
        logToFile(
          `Connector token missing Google Workspace scopes: ${missingScopes.join(", ")}`,
        );
        return yield* Effect.fail(new GoogleWorkspaceReconnectRequiredError());
      }

      const client = new google.auth.OAuth2({ clientId: self.clientId });
      client.setCredentials({
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken,
        expiry_date: payload.expiresAt,
        scope: payload.scopes?.join(" "),
        token_type: "Bearer",
      });
      client.on("tokens", async (tokens) => {
        const current = await loadConnectorTokenPayload(stellaAppDir, TOKEN_KEY);
        await saveConnectorTokenPayload(stellaAppDir, TOKEN_KEY, {
          accessToken:
            tokens.access_token ?? current?.accessToken ?? payload.accessToken,
          refreshToken:
            tokens.refresh_token ??
            current?.refreshToken ??
            payload.refreshToken ??
            undefined,
          expiresAt: tokens.expiry_date ?? current?.expiresAt,
          clientId: self.clientId,
          tokenEndpoint: TOKEN_ENDPOINT,
          scopes: tokens.scope
            ? tokens.scope.split(/\s+/u).filter(Boolean)
            : (current?.scopes ?? payload.scopes),
        });
      });
      self.client = client;
      return client;
    });
  }

  public getAuthenticatedClient(): Promise<Auth.OAuth2Client> {
    return runGoogleWorkspaceEffect(this.getAuthenticatedClientEffect());
  }

  public clearAuth(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return runGoogleWorkspaceEffect(
      Effect.gen(function* () {
        self.client = null;
        const stellaAppDir = yield* tryGoogleWorkspaceSync(
          stellaAppDirFromProjectRoot,
        );
        yield* tryGoogleWorkspaceOp(() =>
          deleteConnectorAccessTokens(stellaAppDir, [TOKEN_KEY]),
        );
      }),
    );
  }

  public refreshToken(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return runGoogleWorkspaceEffect(
      Effect.gen(function* () {
        self.onStatusUpdate?.("Refreshing Google Workspace connection...");
        const client = yield* self.getAuthenticatedClientEffect();
        const response = yield* tryGoogleWorkspaceOp(() =>
          client.refreshAccessToken(),
        );
        const stellaAppDir = yield* tryGoogleWorkspaceSync(
          stellaAppDirFromProjectRoot,
        );
        yield* tryGoogleWorkspaceOp(() =>
          saveConnectorTokenPayload(stellaAppDir, TOKEN_KEY, {
            accessToken: response.credentials.access_token ?? "",
            refreshToken:
              response.credentials.refresh_token ??
              client.credentials.refresh_token ??
              undefined,
            expiresAt: response.credentials.expiry_date ?? undefined,
            clientId: self.clientId,
            tokenEndpoint: TOKEN_ENDPOINT,
            scopes:
              response.credentials.scope?.split(/\s+/u).filter(Boolean) ??
              self.scopes,
          }),
        );
      }),
    );
  }
}
