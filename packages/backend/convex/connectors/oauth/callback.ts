import { internalAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { v } from "convex/values";
import { decryptSecret } from "../../data/secrets_crypto";
import { ConnectorError } from "../errors";
import { connectorPublicBaseUrl } from "../env";
import {
  buildTokenExchangeBody,
  buildTokenEndpointRequest,
  connectorBindingsSatisfiedByScopes,
  getProviderManifest,
  parseScopeString,
  resolveProviderResourceOrigin,
  scopesForGroups,
  sha256Hex,
} from "./providers";
import { resolveProviderClientCredentials } from "./client_credentials";
import { expiryFromExpiresIn } from "./token_set";

/**
 * Shared hosted OAuth callback logic: atomically consume state, exchange the
 * code server-to-server with PKCE, fetch stable provider identity, and commit
 * encrypted credentials + a connector binding — all before any success is
 * reported. Never returns tokens/codes/state; the HTTP layer renders a branded
 * page and an opaque deep link only.
 */

const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

type TokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  instance_url?: unknown;
  api_domain?: unknown;
  api_base_url_for_customer?: unknown;
  error?: unknown;
};

const readSmallJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > TOKEN_RESPONSE_MAX_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("code_exchange_failed");
  }
  const text = await response.text();
  if (text.length > TOKEN_RESPONSE_MAX_BYTES || !text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new ConnectorError("code_exchange_failed");
  }
};

type ProviderIdentity = { sub: string; email?: string; name?: string };

const fetchProviderIdentity = async (
  manifest: NonNullable<ReturnType<typeof getProviderManifest>>,
  accessToken: string,
  resourceOrigin: string,
): Promise<ProviderIdentity | null> => {
  const endpoint =
    manifest.userinfoEndpoint ??
    (manifest.userinfoPath
      ? new URL(manifest.userinfoPath, `${resourceOrigin}/`).toString()
      : null);
  if (!endpoint) return null;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      ...manifest.userinfoHeaders,
    },
  });
  if (!response.ok) return null;
  const payload = await readSmallJson(response);
  const readPath = (path: string | undefined): unknown => {
    if (!path) return undefined;
    return path.split(".").reduce<unknown>((value, segment) => {
      if (!value || typeof value !== "object") return undefined;
      if (Array.isArray(value)) {
        const index = Number(segment);
        return Number.isInteger(index) ? value[index] : undefined;
      }
      return (value as Record<string, unknown>)[segment];
    }, payload);
  };
  const subject = manifest.identityPaths?.subject
    ? readPath(manifest.identityPaths.subject)
    : (payload.sub ?? payload.id);
  const sub =
    typeof subject === "string"
      ? subject
      : typeof subject === "number"
        ? String(subject)
        : null;
  if (!sub) return null;
  const email = manifest.identityPaths?.email
    ? readPath(manifest.identityPaths.email)
    : payload.email ?? payload.mail ?? payload.userPrincipalName;
  const name = manifest.identityPaths?.name
    ? readPath(manifest.identityPaths.name)
    : payload.name ?? payload.displayName;
  return {
    sub,
    email: typeof email === "string" ? email : undefined,
    name: typeof name === "string" ? name : undefined,
  };
};

export const handleOAuthCallback = internalAction({
  args: {
    state: v.string(),
    code: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.object({
    status: v.union(
      v.literal("succeeded"),
      v.literal("denied"),
      v.literal("failed"),
      v.literal("invalid"),
    ),
    connectorId: v.optional(v.string()),
    provider: v.optional(v.string()),
    attemptId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "succeeded" | "denied" | "failed" | "invalid";
    connectorId?: string;
    provider?: string;
    attemptId?: string;
    errorCode?: string;
  }> => {
    const stateHash = await sha256Hex(args.state);
    const attempt = await ctx.runMutation(
      internal.connectors.oauth.attempts.consumeConnectAttempt,
      { stateHash },
    );
    // Reject reused/expired/unknown state before any token exchange.
    if (!attempt)
      return { status: "invalid" as const, errorCode: "invalid_state" };

    const attemptIdStr = String(attempt.attemptId);
    const finalize = async (
      status: "succeeded" | "denied" | "failed",
      errorCode?: string,
      resolvedAccountId?: string,
    ) => {
      await ctx.runMutation(
        internal.connectors.oauth.attempts.finalizeConnectAttempt,
        { attemptId: attempt.attemptId, status, resolvedAccountId, errorCode },
      );
      await ctx.runMutation(
        internal.connectors.audit.recordConnectorAuditEvent,
        {
          ownerId: attempt.ownerId,
          connectorId: attempt.connectorId,
          provider: attempt.provider,
          accountId: resolvedAccountId,
          event:
            status === "succeeded"
              ? "connect_attempt_succeeded"
              : status === "denied"
                ? "connect_attempt_denied"
                : "connect_attempt_failed",
          outcome:
            status === "succeeded"
              ? "ok"
              : status === "denied"
                ? "denied"
                : "error",
          scopeGroups: attempt.scopeGroupIds,
          errorCode,
        },
      );
    };

    try {
      if (args.error) {
        await finalize("denied", "consent_denied");
        return {
          status: "denied" as const,
          connectorId: attempt.connectorId,
          provider: attempt.provider,
          attemptId: attemptIdStr,
          errorCode: "consent_denied",
        };
      }
      if (!args.code) throw new ConnectorError("invalid_state");

      const manifest = getProviderManifest(attempt.provider);
      if (!manifest) throw new ConnectorError("provider_not_configured");
      const baseUrl = connectorPublicBaseUrl();
      if (!baseUrl) throw new ConnectorError("provider_not_configured");
      const credentials = resolveProviderClientCredentials(
        manifest.key,
        attempt.clientSecretVersion,
      );
      const redirectUri = `${baseUrl}${manifest.callbackPath}`;
      const verifier = await decryptSecret(attempt.encryptedVerifier);

      const now = Date.now();
      const tokenRequest = buildTokenEndpointRequest({
        manifest,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        body: buildTokenExchangeBody({
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          code: args.code,
          redirectUri,
          codeVerifier: manifest.requiresPkce ? verifier : undefined,
        }),
      });
      const tokenResponse = await fetch(manifest.tokenEndpoint, {
        method: "POST",
        ...tokenRequest,
      });
      const payload = (await readSmallJson(tokenResponse)) as TokenPayload;
      if (!tokenResponse.ok || payload.error) {
        throw new ConnectorError("code_exchange_failed");
      }
      const accessToken =
        typeof payload.access_token === "string" ? payload.access_token : null;
      if (!accessToken) throw new ConnectorError("code_exchange_failed");

      const candidateResourceOrigin =
        payload.api_base_url_for_customer ??
        payload.instance_url ??
        payload.api_domain;
      const resourceOrigin = resolveProviderResourceOrigin(
        manifest,
        candidateResourceOrigin,
      );

      if (!manifest.userinfoEndpoint && !manifest.userinfoPath) {
        throw new ConnectorError("identity_unavailable");
      }
      const identity = await fetchProviderIdentity(
        manifest,
        accessToken,
        resourceOrigin,
      );
      if (!identity) throw new ConnectorError("identity_unavailable");

      // Prefer the provider-issued scope string; otherwise treat the requested
      // groups as granted (best effort). Never widen beyond requested groups.
      const providerReportedScopes =
        typeof payload.scope === "string" && payload.scope.trim()
          ? parseScopeString(payload.scope)
          : scopesForGroups(manifest, attempt.scopeGroupIds);
      // Entra may omit protocol scopes from the access-token `scope` echo.
      // They are nevertheless proven by this completed OIDC flow; only mark
      // offline_access when a refresh token was actually issued.
      const grantedScopes =
        manifest.key === "microsoft"
          ? [
              ...new Set([
                ...providerReportedScopes,
                "openid",
                "profile",
                "email",
                ...(typeof payload.refresh_token === "string"
                  ? ["offline_access"]
                  : []),
              ]),
            ]
          : providerReportedScopes;

      const commit = await ctx.runMutation(
        internal.connectors.oauth.vault.commitProviderAccountTokens,
        {
          ownerId: attempt.ownerId,
          provider: manifest.key,
          providerAccountId: identity.sub,
          providerAccountIdIntent: attempt.providerAccountIdIntent,
          displayEmail: identity.email,
          displayLabel: identity.name,
          registrationVersion: manifest.registrationVersion,
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
            scopes: grantedScopes,
            ...(resourceOrigin !== manifest.apiOrigin
              ? { resourceOrigin }
              : {}),
          },
        },
      );

      const familyBindings = connectorBindingsSatisfiedByScopes(
        manifest,
        commit.grantedScopes,
      );
      const bindings = [
        ...familyBindings,
        ...(!familyBindings.some(
          (binding) => binding.connectorId === attempt.connectorId,
        )
          ? [
              {
                connectorId: attempt.connectorId,
                requiredScopeGroups:
                  manifest.connectorBindings?.[attempt.connectorId]
                    ?.requiredScopeGroups ?? attempt.scopeGroupIds,
              },
            ]
          : []),
      ];
      for (const binding of bindings) {
        await ctx.runMutation(
          internal.connectors.oauth.accounts.setConnectorBinding,
          {
            ownerId: attempt.ownerId,
            connectorId: binding.connectorId,
            provider: manifest.key,
            accountId: commit.accountId,
            requiredScopeGroups: [...binding.requiredScopeGroups],
          },
        );
      }

      await finalize("succeeded", undefined, String(commit.accountId));
      await ctx.runMutation(
        internal.connectors.audit.recordConnectorAuditEvent,
        {
          ownerId: attempt.ownerId,
          connectorId: attempt.connectorId,
          provider: manifest.key,
          accountId: String(commit.accountId),
          event: "account_bound",
          outcome: "ok",
          scopeGroups: attempt.scopeGroupIds,
        },
      );
      return {
        status: "succeeded" as const,
        connectorId: attempt.connectorId,
        provider: manifest.key,
        attemptId: attemptIdStr,
      };
    } catch (error) {
      const errorCode =
        error instanceof ConnectorError ? error.code : "code_exchange_failed";
      await finalize("failed", errorCode);
      return {
        status: "failed" as const,
        connectorId: attempt.connectorId,
        provider: attempt.provider,
        attemptId: attemptIdStr,
        errorCode,
      };
    }
  },
});
