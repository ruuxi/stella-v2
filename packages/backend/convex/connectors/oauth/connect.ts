import { mutation } from "../../_generated/server";
import { v, ConvexError } from "convex/values";
import { requireUserId } from "../../auth";
import {
  enforceMutationRateLimit,
  RATE_VERY_EXPENSIVE,
} from "../../lib/rate_limits";
import {
  encryptSecret,
  getActiveSecretKeyVersion,
} from "../../data/secrets_crypto";
import { ConnectorError } from "../errors";
import { connectorPublicBaseUrl } from "../env";
import {
  buildAuthorizationUrl,
  generateOAuthState,
  generatePkceVerifier,
  pkceChallengeS256,
  requireEnabledProvider,
  scopesForGroups,
  sha256Hex,
} from "./providers";
import { resolveProviderClientCredentials } from "./client_credentials";
import { CONNECT_ATTEMPT_TTL_MS } from "./attempts";

const RETURN_SURFACES = new Set(["desktop", "mobile", "web"]);
const SAFE_CONNECTOR_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/u;

/**
 * Authenticated connect-start. Mirrors the X `createXConnectUrl` precedent:
 * builds state + PKCE, encrypts the verifier, stores a one-time attempt, and
 * returns the provider authorization URL whose redirect is the branded hosted
 * callback. The client opens the URL and polls `getConnectAttemptStatus`.
 */
export const startConnectAttempt = mutation({
  args: {
    connectorId: v.string(),
    provider: v.string(),
    scopeGroupIds: v.array(v.string()),
    returnSurface: v.optional(v.string()),
    providerAccountIdIntent: v.optional(v.string()),
  },
  returns: v.object({
    attemptId: v.id("oauth_connect_attempts"),
    authorizationUrl: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireUserId(ctx);
    await enforceMutationRateLimit(
      ctx,
      "connector_connect_start",
      ownerId,
      RATE_VERY_EXPENSIVE,
      "Too many connect requests. Please wait before trying again.",
    );

    const connectorId = args.connectorId.trim().toLowerCase();
    if (!SAFE_CONNECTOR_ID.test(connectorId)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Invalid connector id.",
      });
    }
    const returnSurface = args.returnSurface ?? "desktop";
    if (!RETURN_SURFACES.has(returnSurface)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Invalid return surface.",
      });
    }

    try {
      const baseUrl = connectorPublicBaseUrl();
      if (!baseUrl) throw new ConnectorError("provider_not_configured");
      const manifest = requireEnabledProvider(args.provider);
      const credentials = resolveProviderClientCredentials(manifest.key);
      const scopes = scopesForGroups(manifest, args.scopeGroupIds);

      const now = Date.now();
      const expiresAt = now + CONNECT_ATTEMPT_TTL_MS;
      const state = generateOAuthState();
      const stateHash = await sha256Hex(state);
      const verifier = generatePkceVerifier();
      const codeChallenge = await pkceChallengeS256(verifier);
      const encryptedVerifier = JSON.stringify(await encryptSecret(verifier));
      const keyVersion = getActiveSecretKeyVersion();

      const attemptId = await ctx.db.insert("oauth_connect_attempts", {
        ownerId,
        provider: manifest.key,
        connectorId,
        scopeGroupIds: args.scopeGroupIds,
        stateHash,
        encryptedVerifier,
        keyVersion,
        returnSurface,
        registrationVersion: manifest.registrationVersion,
        clientSecretVersion: credentials.clientSecretVersion,
        providerAccountIdIntent: args.providerAccountIdIntent,
        status: "pending",
        expiresAt,
        createdAt: now,
      });

      const authorizationUrl = buildAuthorizationUrl({
        manifest,
        clientId: credentials.clientId,
        redirectUri: `${baseUrl}${manifest.callbackPath}`,
        state,
        codeChallenge,
        scopes,
      });

      return { attemptId, authorizationUrl, expiresAt };
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw new ConvexError({
          code: "CONNECTOR_ERROR",
          message: error.code,
        });
      }
      throw error;
    }
  },
});
