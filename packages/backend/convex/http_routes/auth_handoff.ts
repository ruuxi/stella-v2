import {
  makeFunctionReference,
  type FunctionReference,
  type HttpRouter,
} from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  createAuth,
  getAuthBaseUrl,
  getUserIdentityOrNullAction,
  isAnonymousIdentity,
  tokenIdentifierForBetterAuthUserId,
} from "../auth";
import {
  BROWSER_AUTH_HANDOFF_TOKEN_PATTERN,
  buildBrowserAuthFragmentRedirect,
  normalizeBrowserAuthReturnTarget,
} from "../lib/browser_auth_callback";
import { decideAnonymousLinkBinding } from "../lib/mobile_auth_link";
import {
  decryptHandoffToken,
  encryptHandoffToken,
  sha256Base64Url,
} from "../lib/handoff_crypto";
import {
  errorResponse,
  jsonResponse,
  withCors,
  handleCorsRequest,
} from "../http_shared/cors";
import {
  consumeWebhookRateLimit,
  rateLimitResponse,
} from "../http_shared/webhook_controls";
import { readJsonBody } from "../http_shared/request";
import {
  readBetterAuthResponseUserId,
  readBetterAuthSessionToken,
} from "../http_shared/better_auth_response";
import { getClientAddressKey } from "../lib/http_utils";
import { isDisposableEmail } from "../lib/disposable_email_domains";
import {
  appIntegrityErrorMessage,
  appIntegrityErrorStatus,
  verifyAuthRequestProof,
} from "../lib/app_integrity";

/** Per-request-id cap for the magic-link status poll. */
const MAGIC_LINK_STATUS_RATE_LIMIT = 60;
const MAGIC_LINK_STATUS_RATE_WINDOW_MS = 60_000;

const MAGIC_LINK_RATE_LIMIT = 3;
/** Per-IP cap on magic-link sends so one caller can't spam many addresses. */
const MAGIC_LINK_IP_RATE_LIMIT = 10;
const MAGIC_LINK_RATE_WINDOW_MS = 60_000;
const MAGIC_LINK_IP_RATE_WINDOW_MS = 60 * 60_000;
const MAGIC_LINK_EXPIRY_MS = 10 * 60_000;
// Matches the `/api/auth/link/claim` window in `mobile_auth.claimLinkRequest`.
// Do not keep an independently usable callback registration any longer.
const BROWSER_SOCIAL_HANDOFF_EXPIRY_MS = 3 * 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * base64url(SHA-256(claimSecret)), unpadded: 43 characters. Validated in the
 * route so a malformed hash is rejected before a handoff row is created —
 * a row whose `claimHash` no client can reproduce would be unclaimable.
 */
const CLAIM_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const recordOwnerPlatformRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    platform: "ios" | "android" | "web";
    identityLevel: 0;
    now: number;
  },
  null
>("owner_origins:recordOwnerOriginInternal") as unknown as FunctionReference<
  "mutation",
  "internal",
  {
    ownerId: string;
    platform: "ios" | "android" | "web";
    identityLevel: 0;
    now: number;
  },
  null
>;

type AnonymousLinkOwnerBinding =
  | { fromOwnerId?: string; fromAuthUserId?: string }
  | { response: Response };

const BEARER_AUTHORIZATION_PATTERN = /^Bearer\s+\S+$/i;

const resolveAnonymousLinkOwnerBinding = async (
  ctx: ActionCtx,
  request: Request,
  origin: string | null,
  requireAnonymousOwner: boolean,
): Promise<AnonymousLinkOwnerBinding> => {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  let identity: Awaited<ReturnType<typeof getUserIdentityOrNullAction>> = null;
  try {
    identity = await getUserIdentityOrNullAction(ctx);
  } catch {
    // Invalid/expired JWTs are credentials, so never echo or log their value.
    return {
      response: errorResponse(
        401,
        "The anonymous session could not be verified.",
        origin,
      ),
    };
  }
  const decision = decideAnonymousLinkBinding({
    hasAuthorizationHeader: authorization.length > 0,
    hasBearerAuthorization: BEARER_AUTHORIZATION_PATTERN.test(authorization),
    ...(identity ? { identityOwnerId: identity.tokenIdentifier } : {}),
    identityIsAnonymous: identity ? isAnonymousIdentity(identity) : false,
    requireAnonymousOwner,
  });
  if (!decision.ok) {
    return {
      response: errorResponse(
        401,
        decision.reason === "invalid_authorization"
          ? "The anonymous session could not be verified."
          : "An authenticated anonymous session is required to preserve this conversation.",
        origin,
      ),
    };
  }
  return decision.fromOwnerId
    ? {
        fromOwnerId: decision.fromOwnerId,
        ...(identity && typeof identity.subject === "string"
          ? { fromAuthUserId: identity.subject }
          : {}),
      }
    : {};
};

const browserAuthBridgeResponse = (
  status: number,
  location?: string,
): Response => {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (location) headers.set("Location", location);
  return new Response(null, { status, headers });
};

const authNoStoreJsonResponse = (
  data: unknown,
  status: number,
  origin: string | null,
): Response => {
  const response = jsonResponse(data, status, origin);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const readConvexErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof ConvexError) {
    const data = error.data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { message?: unknown }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

export const registerAuthHandoffRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/auth/browser-social/start",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        let body: { returnTo?: unknown } | null = null;
        try {
          body = (await request.json()) as { returnTo?: unknown };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        const returnTo = normalizeBrowserAuthReturnTarget({
          rawReturnTo:
            typeof body?.returnTo === "string" ? body.returnTo.trim() : "",
          requestOrigin: origin ?? "",
        });
        if (!returnTo || !origin) {
          return errorResponse(
            400,
            "Invalid browser auth return target.",
            origin,
          );
        }

        const ownerBinding = await resolveAnonymousLinkOwnerBinding(
          ctx,
          request,
          origin,
          true,
        );
        if ("response" in ownerBinding || !ownerBinding.fromOwnerId) {
          return "response" in ownerBinding
            ? ownerBinding.response
            : errorResponse(
                401,
                "An authenticated anonymous session is required to preserve this conversation.",
                origin,
              );
        }

        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "browser_social_auth_start",
          key: getClientAddressKey(request) ?? ownerBinding.fromOwnerId,
          limit: MAGIC_LINK_RATE_LIMIT,
          windowMs: MAGIC_LINK_RATE_WINDOW_MS,
          blockMs: MAGIC_LINK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const authBaseUrl = getAuthBaseUrl().replace(/\/+$/, "");
        const requestId = crypto.randomUUID();
        const now = Date.now();
        const created = await ctx.runMutation(
          internal.mobile_auth.createBrowserSocialHandoff,
          {
            requestId,
            provider: "google",
            fromOwnerId: ownerBinding.fromOwnerId,
            returnOrigin: origin,
            returnTo,
            expiresAt: now + BROWSER_SOCIAL_HANDOFF_EXPIRY_MS,
            createdAt: now,
          },
        );
        if (!created.ok) {
          return errorResponse(
            409,
            "Account connection is unavailable while account data is changing.",
            origin,
          );
        }
        await ctx.scheduler.runAfter(
          BROWSER_SOCIAL_HANDOFF_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupBrowserSocialHandoff,
          { requestId },
        );
        return authNoStoreJsonResponse(
          {
            callbackURL: `${authBaseUrl}/api/auth/browser-social/verify?requestId=${encodeURIComponent(requestId)}`,
          },
          200,
          origin,
        );
      }),
    ),
  });

  // Better Auth's provider hook currently appends its one-time credential as
  // `?ott=`. This no-render route consumes that query before any app shell or
  // third-party asset loads, then redirects to the registered target with the
  // credential in a fragment. The registration is atomically single-use.
  http.route({
    path: "/api/auth/browser-social/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestIds = url.searchParams.getAll("requestId");
      const tokens = url.searchParams.getAll("ott");
      const hasUnexpectedParameter = Array.from(url.searchParams.keys()).some(
        (key) => key !== "requestId" && key !== "ott",
      );
      const requestId = requestIds[0] ?? "";
      const token = tokens[0] ?? "";
      if (
        requestIds.length !== 1 ||
        tokens.length !== 1 ||
        hasUnexpectedParameter ||
        !requestId ||
        !BROWSER_AUTH_HANDOFF_TOKEN_PATTERN.test(token)
      ) {
        return browserAuthBridgeResponse(400);
      }

      const handoff = await ctx.runMutation(
        internal.mobile_auth.consumeBrowserSocialHandoff,
        { requestId, nowMs: Date.now() },
      );
      if (!handoff.ok) {
        return browserAuthBridgeResponse(
          handoff.reason === "not_found" ? 400 : 410,
        );
      }
      const returnTo = normalizeBrowserAuthReturnTarget({
        rawReturnTo: handoff.returnTo,
        requestOrigin: handoff.returnOrigin,
      });
      const redirect = returnTo
        ? buildBrowserAuthFragmentRedirect({ returnTo, token })
        : null;
      return redirect
        ? browserAuthBridgeResponse(302, redirect)
        : browserAuthBridgeResponse(400);
    }),
  });

  // Start a desktop social sign-in and return a requestId for polling. The
  // OAuth callback lands on `/api/auth/desktop-social/verify`, where the OTT is
  // exchanged server-side for a bearer token encrypted into the claim row.
  http.route({
    path: "/api/auth/desktop-social/start",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "desktop_social_auth_start",
          key: getClientAddressKey(request) ?? "unknown",
          limit: MAGIC_LINK_RATE_LIMIT,
          windowMs: MAGIC_LINK_RATE_WINDOW_MS,
          blockMs: MAGIC_LINK_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const authBaseUrl = getAuthBaseUrl();
        if (!authBaseUrl) {
          console.error("[desktop/auth] Missing auth base URL");
          return errorResponse(500, "Server configuration error", origin);
        }

        let socialClaimHash = "";
        try {
          const body = (await request.json()) as { claimHash?: unknown };
          if (typeof body?.claimHash === "string") {
            socialClaimHash = body.claimHash.trim();
          }
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }
        if (!CLAIM_HASH_PATTERN.test(socialClaimHash)) {
          return errorResponse(400, "A valid claimHash is required", origin);
        }

        const requestId = crypto.randomUUID();
        const now = Date.now();
        await ctx.runMutation(internal.mobile_auth.createPendingLinkRequest, {
          email: "desktop-social:google",
          requestId,
          expiresAt: now + MAGIC_LINK_EXPIRY_MS,
          createdAt: now,
          claimHash: socialClaimHash,
        });

        await ctx.scheduler.runAfter(
          MAGIC_LINK_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupLinkRequest,
          { requestId },
        );

        return authNoStoreJsonResponse(
          {
            requestId,
            callbackURL: `${authBaseUrl}/api/auth/desktop-social/verify?requestId=${encodeURIComponent(requestId)}`,
          },
          200,
          origin,
        );
      }),
    ),
  });

  // Send a magic link and return a requestId for polling.
  http.route({
    path: "/api/auth/link/send",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        let body: {
          email?: unknown;
          requireAnonymousOwner?: unknown;
          claimHash?: unknown;
        } | null = null;
        try {
          body = (await request.json()) as {
            email?: unknown;
            requireAnonymousOwner?: unknown;
            claimHash?: unknown;
          };
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const email =
          typeof body?.email === "string"
            ? body.email.trim().toLowerCase()
            : "";
        if (!email || !EMAIL_PATTERN.test(email)) {
          return errorResponse(400, "A valid email is required.", origin);
        }
        if (isDisposableEmail(email)) {
          return jsonResponse({ error: "email_not_supported" }, 400, origin);
        }
        const ipKey = getClientAddressKey(request);
        const proofResult = await verifyAuthRequestProof({
          ctx,
          request,
          purpose: "magic-link",
        });
        if (!proofResult.ok) {
          return jsonResponse(
            {
              error: proofResult.code,
              message: appIntegrityErrorMessage(proofResult.code),
            },
            appIntegrityErrorStatus(proofResult.code),
            origin,
          );
        }
        const claimHash =
          typeof body?.claimHash === "string" ? body.claimHash.trim() : "";
        if (!CLAIM_HASH_PATTERN.test(claimHash)) {
          return errorResponse(400, "A valid claimHash is required", origin);
        }
        if (
          body?.requireAnonymousOwner !== undefined &&
          typeof body.requireAnonymousOwner !== "boolean"
        ) {
          return errorResponse(
            400,
            "requireAnonymousOwner must be a boolean.",
            origin,
          );
        }

        const ownerBinding = await resolveAnonymousLinkOwnerBinding(
          ctx,
          request,
          origin,
          body?.requireAnonymousOwner === true,
        );
        if ("response" in ownerBinding) {
          return ownerBinding.response;
        }
        if (proofResult.platform && ownerBinding.fromOwnerId) {
          await ctx.runMutation(recordOwnerPlatformRef, {
            ownerId: ownerBinding.fromOwnerId,
            platform: proofResult.platform,
            identityLevel: 0,
            now: Date.now(),
          });
        }

        const rateLimit = await ctx.runMutation(
          internal.rate_limits.consumeWebhookRateLimit,
          {
            scope: "mobile_magic_link",
            key: email,
            limit: MAGIC_LINK_RATE_LIMIT,
            windowMs: MAGIC_LINK_RATE_WINDOW_MS,
            blockMs: MAGIC_LINK_RATE_WINDOW_MS,
          },
        );
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        if (ipKey) {
          const ipRateLimit = await consumeWebhookRateLimit(ctx, {
            scope: "mobile_magic_link_ip",
            key: ipKey,
            limit: MAGIC_LINK_IP_RATE_LIMIT,
            windowMs: MAGIC_LINK_IP_RATE_WINDOW_MS,
            blockMs: MAGIC_LINK_IP_RATE_WINDOW_MS,
          });
          if (!ipRateLimit.allowed) {
            return withCors(
              rateLimitResponse(ipRateLimit.retryAfterMs),
              origin,
            );
          }
        }

        const authBaseUrl = getAuthBaseUrl();
        if (!authBaseUrl) {
          console.error("[mobile/auth] Missing auth base URL");
          return errorResponse(500, "Server configuration error", origin);
        }

        const requestId = crypto.randomUUID();
        const now = Date.now();

        await ctx.runMutation(internal.mobile_auth.createPendingLinkRequest, {
          email,
          requestId,
          ...(ownerBinding.fromOwnerId
            ? { fromOwnerId: ownerBinding.fromOwnerId }
            : {}),
          ...(ownerBinding.fromAuthUserId
            ? { fromAuthUserId: ownerBinding.fromAuthUserId }
            : {}),
          expiresAt: now + MAGIC_LINK_EXPIRY_MS,
          createdAt: now,
          claimHash,
        });

        // Schedule cleanup before attempting the send so a failed send
        // doesn't leak the pending row forever.
        await ctx.scheduler.runAfter(
          MAGIC_LINK_EXPIRY_MS + 30_000,
          internal.mobile_auth.cleanupLinkRequest,
          { requestId },
        );

        try {
          const auth = createAuth(ctx);
          const callbackURL = `${authBaseUrl}/api/auth/link/verify?requestId=${encodeURIComponent(requestId)}`;
          await auth.api.signInMagicLink({
            body: { email, callbackURL },
            headers: new Headers({ origin: authBaseUrl }),
          });
        } catch (error) {
          console.error("[mobile/auth] Failed to send magic link:", error);
          return errorResponse(500, "Failed to send sign-in email.", origin);
        }

        return authNoStoreJsonResponse({ requestId }, 200, origin);
      }),
    ),
  });

  // Poll for magic link verification status.
  http.route({
    path: "/api/auth/link/status",
    method: "GET",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const url = new URL(request.url);
        const requestId = url.searchParams.get("requestId") ?? "";
        if (!requestId) {
          return errorResponse(400, "requestId is required", origin);
        }
        // Cap polls per requestId so a misbehaving client can't spin a
        // tight poll loop. The mobile client polls every ~1 s, so 60/min
        // is comfortably above legitimate usage.
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "mobile_auth_link_status",
          key: requestId,
          limit: MAGIC_LINK_STATUS_RATE_LIMIT,
          windowMs: MAGIC_LINK_STATUS_RATE_WINDOW_MS,
          blockMs: MAGIC_LINK_STATUS_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const result = await ctx.runQuery(
          internal.mobile_auth.getLinkRequestStatus,
          { requestId, nowMs: Date.now() },
        );
        if (!result) {
          return errorResponse(404, "Request not found", origin);
        }

        return authNoStoreJsonResponse(result, 200, origin);
      }),
    ),
  });

  // Exchange a completed handoff for its connected-account bearer. The
  // request id is intentionally insufficient on its own: only the shell that
  // generated the in-memory claim secret can consume this single-use row.
  http.route({
    path: "/api/auth/link/claim",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const parsed = await readJsonBody<{
          requestId?: unknown;
          claimSecret?: unknown;
        }>(request, origin);
        if (!parsed.ok) return parsed.response;

        const requestId =
          typeof parsed.body.requestId === "string"
            ? parsed.body.requestId.trim()
            : "";
        const claimSecret =
          typeof parsed.body.claimSecret === "string"
            ? parsed.body.claimSecret.trim()
            : "";
        if (!requestId || !CLAIM_SECRET_PATTERN.test(claimSecret)) {
          return errorResponse(400, "Unable to claim sign-in", origin);
        }

        const result = await ctx.runMutation(
          internal.mobile_auth.claimLinkRequest,
          {
            requestId,
            claimHash: await sha256Base64Url(claimSecret),
            nowMs: Date.now(),
          },
        );
        if (!result.ok) {
          return errorResponse(400, "Unable to claim sign-in", origin);
        }

        try {
          const token = await decryptHandoffToken(result.tokenEnc);
          if (!token.trim()) {
            throw new Error("The claimed sign-in token was empty.");
          }
          return authNoStoreJsonResponse({ token }, 200, origin);
        } catch {
          // Never log the encrypted or decrypted credential.
          console.error("[mobile/auth] Sign-in claim decryption failed");
          return errorResponse(500, "Unable to claim sign-in", origin);
        }
      }),
    ),
  });

  // Browser landing after desktop social auth. The one-time-token plugin
  // appends ?ott=... to this URL after the provider flow completes.
  http.route({
    path: "/api/auth/desktop-social/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        let sessionToken = "";
        let connectedUserId = "";
        try {
          const auth = createAuth(ctx);
          const verifyRes = await auth.api.verifyOneTimeToken({
            body: { token: ott },
            headers: new Headers(),
            returnHeaders: true,
          });
          sessionToken = readBetterAuthSessionToken(verifyRes);
          connectedUserId = readBetterAuthResponseUserId(verifyRes);
        } catch {
          // Never attach the thrown value here: provider errors may echo the
          // one-time credential that arrived in the request query string.
          console.error("[desktop/auth] Server-side OTT verification failed");
        }
        if (sessionToken && connectedUserId) {
          const completion = await ctx.runMutation(
            internal.mobile_auth.completeLinkRequest,
            {
              requestId,
              tokenEnc: await encryptHandoffToken(sessionToken),
              toOwnerId: tokenIdentifierForBetterAuthUserId(connectedUserId),
            },
          );
          if (!completion.ok) {
            console.error(
              `[desktop/auth] Link request completion rejected: ${completion.reason}`,
            );
          }
        }
      }

      const websiteUrl =
        process.env.STELLA_WEBSITE_URL?.trim() || "https://stella.sh";
      const redirect = `${websiteUrl.replace(/\/+$/, "")}/auth/callback?done=true`;

      return new Response(null, {
        status: 302,
        headers: { Location: redirect },
      });
    }),
  });

  // Browser landing after magic link verification.
  // The one-time-token plugin appends ?ott=... to this URL after verifying the
  // token. The OTT is exchanged for the opaque bearer server-side and stored
  // encrypted, so the row is claimable only by the holder of the claim secret.
  http.route({
    path: "/api/auth/link/verify",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const requestId = url.searchParams.get("requestId") ?? "";
      const ott = url.searchParams.get("ott") ?? "";

      if (requestId && ott) {
        let sessionToken = "";
        let connectedUserId = "";
        try {
          const auth = createAuth(ctx);
          const verifyRes = await auth.api.verifyOneTimeToken({
            body: { token: ott },
            headers: new Headers(),
            returnHeaders: true,
          });
          sessionToken = readBetterAuthSessionToken(verifyRes);
          connectedUserId = readBetterAuthResponseUserId(verifyRes);
        } catch {
          // Keep credentials out of logs even when the auth library includes
          // request input in its thrown error.
          console.error("[mobile/auth] Server-side OTT verification failed");
        }
        if (sessionToken && connectedUserId) {
          const completion = await ctx.runMutation(
            internal.mobile_auth.completeLinkRequest,
            {
              requestId,
              tokenEnc: await encryptHandoffToken(sessionToken),
              toOwnerId: tokenIdentifierForBetterAuthUserId(connectedUserId),
            },
          );
          if (!completion.ok) {
            console.error(
              `[mobile/auth] Link request completion rejected: ${completion.reason}`,
            );
          }
        }
      }

      const websiteUrl =
        process.env.STELLA_WEBSITE_URL?.trim() || "https://stella.sh";
      const redirect = `${websiteUrl.replace(/\/+$/, "")}/auth/callback?done=true`;

      return new Response(null, {
        status: 302,
        headers: { Location: redirect },
      });
    }),
  });
};
