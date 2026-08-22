import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { decryptSecret } from "../data/secrets_crypto";
import {
  ConnectorError,
  type ConnectorErrorCode,
  classifyTokenEndpointError,
} from "./errors";
import { isFirstPartyExecutionEnabled } from "./env";
import {
  buildRefreshBody,
  buildTokenEndpointRequest,
  getProviderManifest,
  grantedScopesSatisfy,
  parseScopeString,
  requireEnabledProvider,
  resolveProviderManifestForAccount,
  resolveProviderResourceOrigin,
  scopesForGroups,
} from "./oauth/providers";
import { resolveProviderClientCredentials } from "./oauth/client_credentials";
import { REFRESH_TOKEN_REQUEST_TIMEOUT_MS } from "./oauth/refresh_policy";
import {
  accessTokenIsFresh,
  expiryFromExpiresIn,
  parseTokenSet,
} from "./oauth/token_set";
import { DEFAULT_ROLLOUT, resolveRoute } from "./routing";
import {
  executeFirstPartyAction,
  firstPartyActionBelongsToConnector,
  firstPartyActionInputSchema,
  firstPartyActionOperation,
  firstPartyActionRequiredScopes,
} from "./executors/first_party";
import { executeApiKeyProviderAction } from "./api_keys/execute";
import { executeHostedConnectAction } from "./hosted_connect/execute";
import {
  getHostedConnectActionDescriptor,
  hostedConnectProviderForConnectorAction,
} from "./hosted_connect/providers";
import {
  apiKeyProviderForConnectorAction,
  getApiKeyActionDescriptor,
} from "./api_keys/providers";

/**
 * Backend-owned first-party execution. This is the ONLY entrypoint that runs a
 * provider-native action. It resolves the route from `connector_rollouts`,
 * enforces account/scope readiness, obtains a fresh access token under a
 * single-flight refresh lease, dispatches to the provider handler, and records
 * a metadata-only audit event. It never dual-executes and never silently falls
 * back to Composio.
 */

const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

type TokenEndpointPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  instance_url?: unknown;
  api_domain?: unknown;
  api_base_url_for_customer?: unknown;
  error?: unknown;
};

const readSmallJson = async (
  response: Response,
): Promise<TokenEndpointPayload> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > TOKEN_RESPONSE_MAX_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("refresh_failed", true);
  }
  const text = await response.text();
  if (text.length > TOKEN_RESPONSE_MAX_BYTES) {
    throw new ConnectorError("refresh_failed", true);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as TokenEndpointPayload;
  } catch {
    throw new ConnectorError("refresh_failed", true);
  }
};

const requestTokenEndpoint = async (
  url: string,
  request: RequestInit,
): Promise<{ response: Response; payload: TokenEndpointPayload }> => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new ConnectorError("refresh_failed", true));
    }, REFRESH_TOKEN_REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, {
          ...request,
          signal: controller.signal,
        });
        return { response, payload: await readSmallJson(response) };
      })(),
      timeout,
    ]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ConnectorError("refresh_failed", true);
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};

/**
 * Obtain a non-expired access token for an account, refreshing under a lease if
 * needed. Never returns the refresh token or persists the access token in args/
 * results beyond the returned value that the executor uses in-process.
 */
export const getAccessTokenForAccount = internalAction({
  args: {
    accountId: v.id("oauth_provider_accounts"),
    requiredScopes: v.array(v.string()),
  },
  returns: v.object({
    accessToken: v.string(),
    resourceOrigin: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ accessToken: string; resourceOrigin?: string }> => {
    const cred = await ctx.runQuery(
      internal.connectors.oauth.vault.getCredentialForRefresh,
      { accountId: args.accountId },
    );
    if (!cred) throw new ConnectorError("account_not_found");
    if (
      cred.accountStatus === "reauth_required" ||
      cred.credentialStatus === "reauth_required"
    ) {
      throw new ConnectorError("reauth_required");
    }
    if (cred.accountStatus !== "active" || cred.credentialStatus !== "active") {
      throw new ConnectorError("not_connected");
    }
    if (!grantedScopesSatisfy(cred.grantedScopes, args.requiredScopes)) {
      throw new ConnectorError("missing_scope");
    }
    const baseManifest = getProviderManifest(cred.provider);
    if (!baseManifest) throw new ConnectorError("provider_not_configured");
    const manifest = resolveProviderManifestForAccount(
      baseManifest,
      cred.accountOrigin,
    );

    const tokenSet = parseTokenSet(await decryptSecret(cred.encryptedTokenSet));
    const persistedResourceOrigin = resolveProviderResourceOrigin(
      manifest,
      tokenSet.resourceOrigin ?? cred.accountOrigin,
    );
    if (
      manifest.accountBound &&
      persistedResourceOrigin !== manifest.apiOrigin
    ) {
      throw new ConnectorError("account_mismatch");
    }
    const now = Date.now();
    if (
      manifest.accessTokensExpire === false ||
      accessTokenIsFresh(cred.accessTokenExpiresAt, manifest.refreshSkewMs, now)
    ) {
      return {
        accessToken: tokenSet.accessToken,
        resourceOrigin: persistedResourceOrigin,
      };
    }
    if (!tokenSet.refreshToken) {
      const tombstone = await ctx.runMutation(
        internal.connectors.oauth.vault.markAccountReauthRequired,
        {
          accountId: args.accountId,
          expectedGeneration: cred.generation,
        },
      );
      if (!tombstone.ok) throw new ConnectorError("refresh_busy", true);
      throw new ConnectorError("reauth_required");
    }

    const credentials = resolveProviderClientCredentials(
      manifest.key,
      undefined,
      cred.accountOrigin,
    );
    const leaseId = crypto.randomUUID();
    const lease = await ctx.runMutation(
      internal.connectors.oauth.vault.claimRefreshLease,
      {
        accountId: args.accountId,
        expectedGeneration: cred.generation,
        leaseId,
      },
    );
    if (!lease.ok) throw new ConnectorError("refresh_busy", true);

    let leaseCleared = false;
    let releaseErrorCode: string | undefined;
    try {
      const tokenRequest = buildTokenEndpointRequest({
        manifest,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        body: buildRefreshBody({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          refreshToken: tokenSet.refreshToken,
        }),
      });
      const { response, payload } = await requestTokenEndpoint(
        manifest.refreshEndpoint ?? manifest.tokenEndpoint,
        {
          method: "POST",
          ...tokenRequest,
          redirect: "error",
        },
      );
      if (!response.ok || payload.error) {
        const classified = classifyTokenEndpointError(payload.error);
        if (classified.code === "invalid_grant") {
          const tombstone = await ctx.runMutation(
            internal.connectors.oauth.vault.markAccountReauthRequired,
            {
              accountId: args.accountId,
              expectedGeneration: cred.generation,
              expectedLeaseId: leaseId,
            },
          );
          if (!tombstone.ok) {
            releaseErrorCode = "refresh_busy";
            throw new ConnectorError("refresh_busy", true);
          }
          leaseCleared = true;
          throw new ConnectorError("reauth_required");
        }
        releaseErrorCode = classified.code;
        throw new ConnectorError(classified.code, classified.retryable);
      }
      const accessToken =
        typeof payload.access_token === "string" ? payload.access_token : null;
      if (!accessToken) {
        releaseErrorCode = "refresh_failed";
        throw new ConnectorError("refresh_failed", true);
      }
      const resourceOrigin = resolveProviderResourceOrigin(
        manifest,
        manifest.accountBound
          ? cred.accountOrigin
          : (payload.api_base_url_for_customer ??
              payload.instance_url ??
              payload.api_domain ??
              tokenSet.resourceOrigin),
      );
      if (manifest.accountBound && resourceOrigin !== manifest.apiOrigin) {
        throw new ConnectorError("account_mismatch");
      }
      const commit = await ctx.runMutation(
        internal.connectors.oauth.vault.commitRefreshedTokens,
        {
          accountId: args.accountId,
          leaseId,
          expectedGeneration: cred.generation,
          incoming: {
            accessToken,
            refreshToken:
              typeof payload.refresh_token === "string"
                ? payload.refresh_token
                : undefined,
            tokenType:
              typeof payload.token_type === "string"
                ? payload.token_type
                : undefined,
            accessTokenExpiresAt: expiryFromExpiresIn(payload.expires_in, now),
            scopes: parseScopeString(payload.scope),
            resourceOrigin,
          },
        },
      );
      if (!commit.ok) {
        releaseErrorCode = "refresh_busy";
        throw new ConnectorError("refresh_busy", true);
      }
      leaseCleared = true;
      return { accessToken, resourceOrigin };
    } catch (error) {
      if (!(error instanceof ConnectorError)) {
        releaseErrorCode = "refresh_failed";
        throw new ConnectorError("refresh_failed", true);
      }
      releaseErrorCode ??= error.code;
      throw error;
    } finally {
      if (!leaseCleared) {
        await ctx.runMutation(
          internal.connectors.oauth.vault.releaseRefreshLease,
          { accountId: args.accountId, leaseId, errorCode: releaseErrorCode },
        );
      }
    }
  },
});

export const runFirstPartyConnectorAction = internalAction({
  args: {
    ownerId: v.string(),
    connectorId: v.string(),
    action: v.string(),
    inputJson: v.string(),
    requestId: v.optional(v.string()),
    /**
     * Server-resolved input JSON Schema. In production this is resolved from the
     * catalog; passed explicitly here so the core is testable without the
     * catalog generalization. When omitted, no schema validation is performed.
     */
    schemaJson: v.optional(v.string()),
    schemaVersion: v.optional(v.number()),
  },
  returns: v.object({
    executor: v.literal("first_party"),
    output: v.any(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ executor: "first_party"; output: unknown }> => {
    const connectorId = args.connectorId.trim().toLowerCase();
    const startedAt = Date.now();
    let auditProvider: string | undefined;
    let auditRouteVersion: number | undefined;
    let loadedApiKey:
      | { provider: string; credentialSlot: string; generation: number }
      | undefined;
    let loadedHostedConnect:
      | { provider: string; generation: number }
      | undefined;

    const auditFailure = async (
      code: ConnectorErrorCode,
      provider?: string,
      routeVersion?: number,
    ) => {
      await ctx.runMutation(
        internal.connectors.audit.recordConnectorAuditEvent,
        {
          ownerId: args.ownerId,
          connectorId,
          action: args.action,
          provider,
          executor: "first_party",
          event: "execution",
          outcome:
            code === "reauth_required"
              ? "reauth_required"
              : code === "provider_rate_limited" || code === "rate_limited"
                ? "rate_limited"
                : "error",
          requestId: args.requestId,
          routeVersion,
          schemaVersion: args.schemaVersion,
          latencyMs: Date.now() - startedAt,
          errorCode: code,
        },
      );
    };

    try {
      if (!isFirstPartyExecutionEnabled()) {
        throw new ConnectorError("execution_disabled");
      }

      const hostedConnectDescriptor = hostedConnectProviderForConnectorAction(
        connectorId,
        args.action,
      );
      if (hostedConnectDescriptor) {
        auditProvider = hostedConnectDescriptor.providerKey;
        const actionDescriptor = getHostedConnectActionDescriptor(
          hostedConnectDescriptor,
          args.action,
        );
        if (!actionDescriptor) throw new ConnectorError("action_not_found");

        const [readiness, storedRollout] = await Promise.all([
          ctx.runQuery(
            internal.connectors.hosted_connect.vault.getHostedConnectReadiness,
            { ownerId: args.ownerId, connectorId },
          ),
          ctx.runQuery(internal.connectors.rollouts.getConnectorRollout, {
            connectorId,
          }),
        ]);
        const rollout = storedRollout ?? { ...DEFAULT_ROLLOUT, connectorId };
        const route = resolveRoute({
          rollout,
          ownerId: args.ownerId,
          operation: actionDescriptor.operation,
          killSwitchEnabled: true,
          hasFirstPartyReady: readiness?.ready ?? false,
        });
        auditRouteVersion = route.routeVersion;
        if (route.executor === "refused") {
          throw new ConnectorError(
            route.reasonCode === "execution_disabled"
              ? "execution_disabled"
              : "connector_disabled",
          );
        }
        if (route.executor !== "first_party") {
          throw new ConnectorError("route_not_first_party");
        }
        if (!readiness?.ready) {
          if (!readiness?.providerEnabled) {
            throw new ConnectorError("provider_disabled");
          }
          if (!readiness.providerVerified) {
            throw new ConnectorError("provider_unverified");
          }
          if (!readiness.egressTransportReady) {
            throw new ConnectorError("egress_transport_unavailable");
          }
          if (readiness.accountStatus === "invalid") {
            throw new ConnectorError("invalid_credential");
          }
          throw new ConnectorError("not_connected");
        }

        let input: Record<string, unknown>;
        try {
          const parsed = JSON.parse(args.inputJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("input is not an object");
          }
          input = parsed as Record<string, unknown>;
        } catch {
          throw new ConnectorError("invalid_input");
        }

        let validation: "valid" | "invalid" | "invalid_schema";
        try {
          validation = await ctx.runAction(
            internal.node.native_integration_schemas.validateActionInput,
            {
              inputJson: args.inputJson,
              schemaJson: JSON.stringify(actionDescriptor.inputSchema),
            },
          );
        } catch {
          throw new ConnectorError("schema_unavailable");
        }
        if (validation === "invalid") {
          throw new ConnectorError("invalid_input");
        }
        if (validation === "invalid_schema") {
          throw new ConnectorError("invalid_schema");
        }

        const credential = await ctx.runAction(
          internal.connectors.hosted_connect.vault
            .loadHostedConnectForExecution,
          { ownerId: args.ownerId, connectorId },
        );
        loadedHostedConnect = {
          provider: credential.provider,
          generation: credential.generation,
        };
        const result = await executeHostedConnectAction({
          descriptor: hostedConnectDescriptor,
          token: credential.token,
          boundOrigin: credential.boundOrigin,
          action: args.action,
          input,
          operation: actionDescriptor.operation,
        });
        await ctx.runMutation(
          internal.connectors.hosted_connect.vault.markHostedConnectUsed,
          {
            ownerId: args.ownerId,
            provider: credential.provider,
            expectedGeneration: credential.generation,
          },
        );
        await ctx.runMutation(
          internal.connectors.audit.recordConnectorAuditEvent,
          {
            ownerId: args.ownerId,
            connectorId,
            action: args.action,
            provider: hostedConnectDescriptor.providerKey,
            executor: "first_party",
            event: "execution",
            outcome: "ok",
            requestId: args.requestId,
            routeVersion: route.routeVersion,
            schemaVersion: args.schemaVersion,
            latencyMs: Date.now() - startedAt,
            providerStatusClass: result.providerStatusClass,
          },
        );
        return { executor: "first_party", output: result.output };
      }

      const apiKeyDescriptor = apiKeyProviderForConnectorAction(
        connectorId,
        args.action,
      );
      if (apiKeyDescriptor) {
        auditProvider = apiKeyDescriptor.providerKey;
        const actionDescriptor = getApiKeyActionDescriptor(
          apiKeyDescriptor,
          args.action,
        );
        if (!actionDescriptor) throw new ConnectorError("action_not_found");

        const [readiness, storedRollout] = await Promise.all([
          ctx.runQuery(internal.connectors.api_keys.vault.getApiKeyReadiness, {
            ownerId: args.ownerId,
            connectorId,
            action: args.action,
          }),
          ctx.runQuery(internal.connectors.rollouts.getConnectorRollout, {
            connectorId,
          }),
        ]);
        const rollout = storedRollout ?? { ...DEFAULT_ROLLOUT, connectorId };
        const route = resolveRoute({
          rollout,
          ownerId: args.ownerId,
          operation: actionDescriptor.operation,
          killSwitchEnabled: true,
          hasFirstPartyReady: readiness?.ready ?? false,
        });
        auditRouteVersion = route.routeVersion;
        if (route.executor === "refused") {
          throw new ConnectorError(
            route.reasonCode === "execution_disabled"
              ? "execution_disabled"
              : "connector_disabled",
          );
        }
        if (route.executor !== "first_party") {
          throw new ConnectorError("route_not_first_party");
        }
        if (!readiness?.ready) {
          if (!readiness?.providerEnabled) {
            throw new ConnectorError("provider_disabled");
          }
          if (!readiness.providerVerified) {
            throw new ConnectorError("provider_unverified");
          }
          if (readiness.accountStatus === "invalid") {
            throw new ConnectorError("invalid_credential");
          }
          throw new ConnectorError("not_connected");
        }

        let input: Record<string, unknown>;
        try {
          const parsed = JSON.parse(args.inputJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("input is not an object");
          }
          input = parsed as Record<string, unknown>;
        } catch {
          throw new ConnectorError("invalid_input");
        }

        let validation: "valid" | "invalid" | "invalid_schema";
        try {
          validation = await ctx.runAction(
            internal.node.native_integration_schemas.validateActionInput,
            {
              inputJson: args.inputJson,
              schemaJson: JSON.stringify(actionDescriptor.inputSchema),
            },
          );
        } catch {
          throw new ConnectorError("schema_unavailable");
        }
        if (validation === "invalid") {
          throw new ConnectorError("invalid_input");
        }
        if (validation === "invalid_schema") {
          throw new ConnectorError("invalid_schema");
        }

        const credential = await ctx.runAction(
          internal.connectors.api_keys.vault.loadApiKeyForExecution,
          { ownerId: args.ownerId, connectorId, action: args.action },
        );
        loadedApiKey = {
          provider: credential.provider,
          credentialSlot: credential.credentialSlot,
          generation: credential.generation,
        };
        const result = await executeApiKeyProviderAction({
          descriptor: apiKeyDescriptor,
          apiKey: credential.apiKey,
          action: args.action,
          input,
          operation: actionDescriptor.operation,
        });
        await ctx.runMutation(
          internal.connectors.api_keys.vault.markApiKeyUsed,
          {
            ownerId: args.ownerId,
            provider: credential.provider,
            credentialSlot: credential.credentialSlot,
            expectedGeneration: credential.generation,
          },
        );
        await ctx.runMutation(
          internal.connectors.audit.recordConnectorAuditEvent,
          {
            ownerId: args.ownerId,
            connectorId,
            action: args.action,
            provider: apiKeyDescriptor.providerKey,
            executor: "first_party",
            event: "execution",
            outcome: "ok",
            requestId: args.requestId,
            routeVersion: route.routeVersion,
            schemaVersion: args.schemaVersion,
            latencyMs: Date.now() - startedAt,
            providerStatusClass: result.providerStatusClass,
          },
        );
        return { executor: "first_party", output: result.output };
      }

      const readiness = await ctx.runQuery(
        internal.connectors.oauth.accounts.getConnectorReadiness,
        { ownerId: args.ownerId, connectorId },
      );
      if (!readiness.provider || !readiness.accountId) {
        throw new ConnectorError("not_connected");
      }
      auditProvider = readiness.provider;
      const manifest = requireEnabledProvider(readiness.provider);

      const operation = firstPartyActionOperation(manifest.key, args.action);
      if (!operation) throw new ConnectorError("action_not_found");
      if (
        !firstPartyActionBelongsToConnector(
          manifest.key,
          connectorId,
          args.action,
        )
      ) {
        throw new ConnectorError("action_not_found");
      }

      const rollout = (await ctx.runQuery(
        internal.connectors.rollouts.getConnectorRollout,
        { connectorId },
      )) ?? { ...DEFAULT_ROLLOUT, connectorId };

      const route = resolveRoute({
        rollout,
        ownerId: args.ownerId,
        operation,
        killSwitchEnabled: true,
        hasFirstPartyReady: readiness.ready,
      });
      auditRouteVersion = route.routeVersion;
      if (route.executor === "refused") {
        throw new ConnectorError(
          route.reasonCode === "execution_disabled"
            ? "execution_disabled"
            : "connector_disabled",
        );
      }
      if (route.executor !== "first_party") {
        // Not routed to first-party (composio_only / shadow / preferred-not-ready
        // / canary-not-selected). This endpoint must not run it.
        throw new ConnectorError("route_not_first_party");
      }

      if (!readiness.ready) {
        if (readiness.accountStatus === "reauth_required") {
          throw new ConnectorError("reauth_required");
        }
        throw new ConnectorError("missing_scope");
      }

      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(args.inputJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("input is not an object");
        }
        input = parsed as Record<string, unknown>;
      } catch {
        throw new ConnectorError("invalid_input");
      }

      const serverSchema = firstPartyActionInputSchema(
        manifest.key,
        args.action,
      );
      const schemaJson = serverSchema
        ? JSON.stringify(serverSchema)
        : args.schemaJson;
      if (schemaJson) {
        let validation: "valid" | "invalid" | "invalid_schema";
        try {
          validation = await ctx.runAction(
            internal.node.native_integration_schemas.validateActionInput,
            { inputJson: args.inputJson, schemaJson },
          );
        } catch {
          throw new ConnectorError("schema_unavailable");
        }
        if (validation === "invalid") throw new ConnectorError("invalid_input");
        if (validation === "invalid_schema") {
          throw new ConnectorError("invalid_schema");
        }
      }

      const connectorRequiredScopes =
        readiness.requiredScopeGroups.length > 0
          ? scopesForGroups(manifest, readiness.requiredScopeGroups)
          : [];
      const requiredScopes = [
        ...new Set([
          ...connectorRequiredScopes,
          ...firstPartyActionRequiredScopes(manifest.key, args.action),
        ]),
      ];

      const { accessToken, resourceOrigin } = await ctx.runAction(
        internal.connectors.execute.getAccessTokenForAccount,
        { accountId: readiness.accountId, requiredScopes },
      );

      const { output, providerStatusClass } = await executeFirstPartyAction({
        manifest,
        accessToken,
        resourceOrigin,
        action: args.action,
        input,
        operation,
      });

      await ctx.runMutation(
        internal.connectors.audit.recordConnectorAuditEvent,
        {
          ownerId: args.ownerId,
          accountId: String(readiness.accountId),
          connectorId,
          action: args.action,
          provider: manifest.key,
          executor: "first_party",
          event: "execution",
          outcome: "ok",
          requestId: args.requestId,
          routeVersion: route.routeVersion,
          schemaVersion: args.schemaVersion,
          scopeGroups: readiness.requiredScopeGroups,
          latencyMs: Date.now() - startedAt,
          providerStatusClass,
        },
      );

      return { executor: "first_party", output };
    } catch (error) {
      const code =
        error instanceof ConnectorError ? error.code : "internal_error";
      if (code === "invalid_credential" && loadedApiKey) {
        const invalidated = await ctx.runMutation(
          internal.connectors.api_keys.vault.markApiKeyInvalid,
          {
            ownerId: args.ownerId,
            provider: loadedApiKey.provider,
            credentialSlot: loadedApiKey.credentialSlot,
            expectedGeneration: loadedApiKey.generation,
          },
        );
        if (invalidated) {
          await ctx.runMutation(
            internal.connectors.audit.recordConnectorAuditEvent,
            {
              ownerId: args.ownerId,
              connectorId,
              provider: loadedApiKey.provider,
              executor: "first_party",
              event: "api_key_invalidated",
              outcome: "error",
              errorCode: "invalid_credential",
            },
          );
        }
      }
      if (code === "invalid_credential" && loadedHostedConnect) {
        const invalidated = await ctx.runMutation(
          internal.connectors.hosted_connect.vault.markHostedConnectInvalid,
          {
            ownerId: args.ownerId,
            provider: loadedHostedConnect.provider,
            expectedGeneration: loadedHostedConnect.generation,
          },
        );
        if (invalidated) {
          await ctx.runMutation(
            internal.connectors.audit.recordConnectorAuditEvent,
            {
              ownerId: args.ownerId,
              connectorId,
              provider: loadedHostedConnect.provider,
              executor: "first_party",
              event: "hosted_connect_invalidated",
              outcome: "error",
              errorCode: "invalid_credential",
            },
          );
        }
      }
      await auditFailure(code, auditProvider, auditRouteVersion);
      throw error instanceof ConnectorError
        ? error
        : new ConnectorError("internal_error");
    }
  },
});
