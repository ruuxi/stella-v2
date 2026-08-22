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
  resolveProviderResourceOrigin,
  scopesForGroups,
} from "./oauth/providers";
import { resolveProviderClientCredentials } from "./oauth/client_credentials";
import {
  accessTokenIsFresh,
  expiryFromExpiresIn,
  parseTokenSet,
} from "./oauth/token_set";
import { DEFAULT_ROLLOUT, resolveRoute } from "./routing";
import {
  executeFirstPartyAction,
  firstPartyActionBelongsToConnector,
  firstPartyActionOperation,
  firstPartyActionRequiredScopes,
} from "./executors/first_party";

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
    const manifest = getProviderManifest(cred.provider);
    if (!manifest) throw new ConnectorError("provider_not_configured");

    const tokenSet = parseTokenSet(await decryptSecret(cred.encryptedTokenSet));
    const now = Date.now();
    if (
      manifest.accessTokensExpire === false ||
      accessTokenIsFresh(cred.accessTokenExpiresAt, manifest.refreshSkewMs, now)
    ) {
      return {
        accessToken: tokenSet.accessToken,
        resourceOrigin: tokenSet.resourceOrigin,
      };
    }
    if (!tokenSet.refreshToken) {
      await ctx.runMutation(
        internal.connectors.oauth.vault.markAccountReauthRequired,
        { accountId: args.accountId },
      );
      throw new ConnectorError("reauth_required");
    }

    const credentials = resolveProviderClientCredentials(manifest.key);
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
      const response = await fetch(manifest.tokenEndpoint, {
        method: "POST",
        ...tokenRequest,
      });
      const payload = await readSmallJson(response);
      if (!response.ok || payload.error) {
        const classified = classifyTokenEndpointError(payload.error);
        if (classified.code === "invalid_grant") {
          await ctx.runMutation(
            internal.connectors.oauth.vault.markAccountReauthRequired,
            { accountId: args.accountId },
          );
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
        payload.api_base_url_for_customer ??
          payload.instance_url ??
          payload.api_domain ??
          tokenSet.resourceOrigin,
      );
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

      const readiness = await ctx.runQuery(
        internal.connectors.oauth.accounts.getConnectorReadiness,
        { ownerId: args.ownerId, connectorId },
      );
      if (!readiness.provider || !readiness.accountId) {
        throw new ConnectorError("not_connected");
      }
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

      if (args.schemaJson) {
        let validation: "valid" | "invalid" | "invalid_schema";
        try {
          validation = await ctx.runAction(
            internal.node.native_integration_schemas.validateActionInput,
            { inputJson: args.inputJson, schemaJson: args.schemaJson },
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
      await auditFailure(code);
      throw error instanceof ConnectorError
        ? error
        : new ConnectorError("internal_error");
    }
  },
});
