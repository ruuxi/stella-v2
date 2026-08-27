import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { requireActionCtx } from "@convex-dev/better-auth/utils";
import { Resend } from "@convex-dev/resend";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { anonymous, bearer, magicLink, oneTimeToken } from "better-auth/plugins";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { DataModel, Id } from "./_generated/dataModel";
import authConfig from "./auth.config";
import { ConvexError, v } from "convex/values";
import betterAuthSchema from "./betterAuth/schema";
import {
  buildMagicLinkEmail,
  getMagicLinkSubject,
} from "./lib/email_templates";
import {
  enforceActionRateLimit,
  RATE_SENSITIVE,
} from "./lib/rate_limits";
import { expoOAuthProxy } from "./lib/expo_oauth_proxy";
import { nativeOttRedirect } from "./lib/native_ott_redirect";
import { importPKCS8, SignJWT } from "jose";

const getRequiredEnv = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

const getOptionalEnv = (name: string) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

export const getTokenIssuer = () => getRequiredEnv("CONVEX_SITE_URL");

export const tokenIdentifierForBetterAuthUserId = (userId: string) =>
  `${getTokenIssuer()}|${userId}`;

export const getAuthBaseUrl = () =>
  getOptionalEnv("STELLA_AUTH_BASE_URL") ?? getRequiredEnv("CONVEX_SITE_URL");

const escapeHtmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const getEmailLogoSrc = (siteUrl: string) => {
  const custom = process.env.STELLA_EMAIL_LOGO_URL?.trim();
  if (custom) {
    return custom;
  }
  return `${siteUrl.replace(/\/+$/, "")}/stella-logo.png`;
};

const extraTrustedOrigins = [

  "http://localhost:57314",
  "http://127.0.0.1:57314",
  "https://stella.sh",

];

const getMobileDeepLinkOrigins = () => {
  const scheme =
    process.env.EXPO_PUBLIC_STELLA_MOBILE_SCHEME?.trim()
    || process.env.STELLA_MOBILE_SCHEME?.trim()
    || "stella-mobile";

  return [`${scheme}://`, `${scheme}:///`];
};

const DEFAULT_JWT_EXPIRATION_SECONDS = 30 * 60;

const parseExpirationSeconds = (raw: string | undefined): number => {
  if (!raw) return DEFAULT_JWT_EXPIRATION_SECONDS;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_JWT_EXPIRATION_SECONDS;
  const match = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?$/i.exec(
    trimmed,
  );
  if (!match) {
    throw new Error(
      `Invalid STELLA_JWT_EXPIRATION value: "${raw}". Use e.g. "5m", "300s", "1h".`,
    );
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier =
    unit.startsWith("d") ? 86400
    : unit.startsWith("h") ? 3600
    : unit.startsWith("m") ? 60
    : 1;
  return value * multiplier;
};

const JWT_EXPIRATION_SECONDS = parseExpirationSeconds(
  process.env.STELLA_JWT_EXPIRATION,
);

const SESSION_EXPIRES_IN_SECONDS = parseExpirationSeconds(
  process.env.STELLA_SESSION_EXPIRATION ?? "7d",
);
const SESSION_UPDATE_AGE_SECONDS = parseExpirationSeconds(
  process.env.STELLA_SESSION_UPDATE_AGE ?? "1d",
);
const STATIC_JWKS = process.env.JWKS?.trim();

const APPLE_CLIENT_SECRET_TTL_SECONDS = 180 * 24 * 60 * 60;

const normalizeApplePrivateKey = (privateKey: string) =>
  privateKey.replace(/\\n/g, "\n");

const generateAppleClientSecret = async ({
  clientId,
  keyId,
  privateKey,
  teamId,
}: {
  clientId: string;
  keyId: string;
  privateKey: string;
  teamId: string;
}) => {
  const key = await importPKCS8(normalizeApplePrivateKey(privateKey), "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience("https://appleid.apple.com")
    .setIssuedAt(now)
    .setExpirationTime(now + APPLE_CLIENT_SECRET_TTL_SECONDS)
    .sign(key);
};

const createAppleProviderOptions = async () => {
  const clientId = getOptionalEnv("APPLE_CLIENT_ID");
  const teamId = getOptionalEnv("APPLE_TEAM_ID");
  const keyId = getOptionalEnv("APPLE_KEY_ID");
  const privateKey = getOptionalEnv("APPLE_PRIVATE_KEY");
  const appBundleIdentifier =
    getOptionalEnv("APPLE_APP_BUNDLE_IDENTIFIER") ?? "com.stella.mobile";
  const enabled = Boolean(clientId && teamId && keyId && privateKey);

  return {
    clientId: clientId ?? "",
    clientSecret: enabled
      ? await generateAppleClientSecret({
          clientId: clientId!,
          teamId: teamId!,
          keyId: keyId!,
          privateKey: privateKey!,
        })
      : "",
    appBundleIdentifier,
    enabled,
  };
};

export const authComponent = createClient<DataModel, typeof betterAuthSchema>(
  components.betterAuth,
  {
    local: {
      schema: betterAuthSchema,
    },
  },
);
const resend = new Resend(components.resend, { testMode: false });

const readSessionIdClaim = (
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
): string | null => {
  if (!identity || typeof identity !== "object") {
    return null;
  }
  const value = (identity as Record<string, unknown>).sessionId;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const revokedSessionError = () =>
  new ConvexError({
    code: "UNAUTHENTICATED",
    message: "Session has been revoked. Please sign in again.",
  });

const isSessionRevokedInDb = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  sessionId: string | null,
  nowMs: number,
) => {
  if (sessionId === null) {
    const anyLive = await ctx.db
      .query("auth_revoked_sessions")
      .withIndex("by_ownerId_and_sessionId", (q) => q.eq("ownerId", ownerId))
      .filter((q) => q.gt(q.field("expiresAt"), nowMs))
      .first();
    return anyLive !== null;
  }
  const row = await ctx.db
    .query("auth_revoked_sessions")
    .withIndex("by_ownerId_and_sessionId", (q) =>
      q.eq("ownerId", ownerId).eq("sessionId", sessionId),
    )
    .unique();
  return row !== null && row.expiresAt > nowMs;
};

export const assertSensitiveSessionPolicy = async (
  ctx: QueryCtx | MutationCtx,
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
) => {
  if (!identity) return;
  if (
    await isSessionRevokedInDb(
      ctx,
      identity.tokenIdentifier,
      readSessionIdClaim(identity),
      Date.now(),
    )
  ) {
    throw revokedSessionError();
  }
};

export const assertSensitiveSessionPolicyAction = async (
  ctx: ActionCtx,
  identity: Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>,
) => {
  if (!identity) return;
  const revoked = await ctx.runQuery(internal.auth.isSessionRevokedInternal, {
    ownerId: identity.tokenIdentifier,
    sessionId: readSessionIdClaim(identity),
  });
  if (revoked) {
    throw revokedSessionError();
  }
};

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = getRequiredEnv("SITE_URL");
  const authBaseUrl = getAuthBaseUrl();
  const googleClientId =
    getOptionalEnv("GOOGLE_CLIENT_ID") ??
    getOptionalEnv("WORKSPACE_CLIENT_ID") ??
    "398468929332-q768etk5go3lbjbdh9nth3d505pc7aqk.apps.googleusercontent.com";
  const googleClientSecret =
    getOptionalEnv("GOOGLE_CLIENT_SECRET") ??
    getOptionalEnv("STELLA_NATIVE_OAUTH_GOOGLE_WORKSPACE_CLIENT_SECRET");
  const trustedOrigins = Array.from(
    new Set(
      [
        siteUrl,
        authBaseUrl,
        ...getMobileDeepLinkOrigins(),
        "https://appleid.apple.com",
        ...extraTrustedOrigins,
      ].filter((origin): origin is string => Boolean(origin)),
    ),
  );

  const options = {
    baseURL: authBaseUrl,
    trustedOrigins,
    database: authComponent.adapter(ctx),

    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },

    rateLimit: { enabled: false },

    account: {
      storeStateStrategy: "database" as const,
      skipStateCookieCheck: true,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const actionCtx = requireActionCtx(ctx);
          await actionCtx.runAction(internal.account_deletion.purgeOwnerCloudData, {
            ownerId: tokenIdentifierForBetterAuthUserId(user.id),
          });
        },
      },
    },
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        enabled: Boolean(googleClientSecret),
      },
      apple: createAppleProviderOptions,
    },
    plugins: [

      expoOAuthProxy(),

      bearer({ requireSignature: true }),
      oneTimeToken({
        storeToken: "hashed",
        expiresIn: 3,
        disableClientRequest: true,
        setOttHeaderOnNewSession: true,
      }),

      nativeOttRedirect(),
      anonymous({
        emailDomainName: "anon.stella.local",
        disableDeleteAnonymousUser: true,
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          const actionCtx = requireActionCtx(ctx);
          await actionCtx.scheduler.runAfter(
            0,
            internal.auth_migration.migrateOwnership,
            {
              fromOwnerId: tokenIdentifierForBetterAuthUserId(anonymousUser.user.id),
              toOwnerId: tokenIdentifierForBetterAuthUserId(newUser.user.id),
            },
          );
        },
      }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          const actionCtx = requireActionCtx(ctx);
          const logoSrc = escapeHtmlAttribute(getEmailLogoSrc(siteUrl));
          const signInUrl = escapeHtmlAttribute(url);

          const recipientLocale: string | undefined = undefined;
          await resend.sendEmail(actionCtx, {
            from: getRequiredEnv("RESEND_FROM"),
            to: email,
            subject: getMagicLinkSubject(recipientLocale),
            html: buildMagicLinkEmail(logoSrc, signInUrl, recipientLocale),
          });
        },
      }),

      convex({
        authConfig,
        ...(STATIC_JWKS ? { jwks: STATIC_JWKS } : {}),
        jwksRotateOnTokenGenerationError: true,
        jwt: {
          expirationSeconds: JWT_EXPIRATION_SECONDS,
        },
      }),
    ],
  } satisfies BetterAuthOptions;

  return options;
};

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth(createAuthOptions(ctx));

export const { getAuthUser } = authComponent.clientApi();

export const getCurrentUser = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      id: v.string(),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      isAnonymous: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx) => {

    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user || typeof user !== "object") {
      return null;
    }
    const record = user as Record<string, unknown>;
    const id =
      typeof record._id === "string"
        ? record._id
        : typeof record.id === "string"
          ? record.id
          : "";
    if (!id) {
      return null;
    }
    return {
      id,
      email: typeof record.email === "string" ? record.email : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      image: typeof record.image === "string" ? record.image : undefined,
      isAnonymous: record.isAnonymous === true ? true : undefined,
    };
  },
});

export const rotateKeys = internalAction({
  args: {},
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    await auth.api.rotateKeys();
    return null;
  },
});

export const getLatestJwks = internalAction({
  args: {},
  handler: async (ctx) => {
    const auth = createAuth(ctx);
    return await auth.api.getLatestJwks();
  },
});

export const isSessionRevokedInternal = internalQuery({
  args: { ownerId: v.string(), sessionId: v.union(v.string(), v.null()) },
  returns: v.boolean(),
  handler: async (ctx, args) =>
    isSessionRevokedInDb(ctx, args.ownerId, args.sessionId, Date.now()),
});

export const recordRevokedSessionsInternal = internalMutation({
  args: {
    ownerId: v.string(),
    sessionIds: v.array(v.string()),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const sessionId of args.sessionIds) {
      const existing = await ctx.db
        .query("auth_revoked_sessions")
        .withIndex("by_ownerId_and_sessionId", (q) =>
          q.eq("ownerId", args.ownerId).eq("sessionId", sessionId),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          revokedAt: now,
          expiresAt: args.expiresAt,
        });
        continue;
      }
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId: args.ownerId,
        sessionId,
        revokedAt: now,
        expiresAt: args.expiresAt,
      });
    }
    return null;
  },
});

export const purgeExpiredRevokedSessions = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const limit = args.batchSize ?? 200;
    const stale = await ctx.db
      .query("auth_revoked_sessions")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", Date.now()))
      .take(limit);
    for (const row of stale) {
      await ctx.db.delete(row._id);
    }
    return { deleted: stale.length };
  },
});

export const revokeActiveSessions = action({
  args: {},
  returns: v.object({ revokedCount: v.number(), expiresAt: v.number() }),
  handler: async (ctx): Promise<{ revokedCount: number; expiresAt: number }> => {
    const identity = await requireSensitiveUserIdentityAction(ctx);
    const ownerId = identity.tokenIdentifier;

    await enforceActionRateLimit(
      ctx,
      "auth_revoke_active_sessions",
      ownerId,
      RATE_SENSITIVE,
      "Too many session revocation requests. Please wait a minute and try again.",
    );

    const auth = createAuth(ctx);
    const authCtx = await auth.$context;
    const userId = identity.subject;

    const sessions = await authCtx.internalAdapter.listSessions(userId);
    const sessionIds = sessions
      .map((session: { id?: unknown }) =>
        typeof session.id === "string" ? session.id : null,
      )
      .filter((id: string | null): id is string => id !== null);

    const currentSessionId = readSessionIdClaim(identity);
    if (currentSessionId !== null && !sessionIds.includes(currentSessionId)) {
      sessionIds.push(currentSessionId);
    }

    const expiresAt = Date.now() + JWT_EXPIRATION_SECONDS * 1000;
    if (sessionIds.length > 0) {
      await ctx.runMutation(internal.auth.recordRevokedSessionsInternal, {
        ownerId,
        sessionIds,
        expiresAt,
      });
    }

    await authCtx.internalAdapter.deleteSessions(userId);

    return { revokedCount: sessionIds.length, expiresAt };
  },
});

export const requireUserIdentity = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
  }
  return identity;
};

export const requireUserId = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const isAnonymousIdentity = (identity: unknown): boolean =>
  Boolean(
    identity
    && typeof identity === "object"
    && (identity as Record<string, unknown>).isAnonymous === true,
  );

export const requireConnectedUserIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Sign in with an account to use this feature.",
    });
  }
  return identity;
};

export const requireConnectedUserIdentityAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  if (isAnonymousIdentity(identity)) {
    throw new ConvexError({
      code: "UNAUTHORIZED",
      message: "Sign in with an account to use this feature.",
    });
  }
  return identity;
};

export const requireConnectedUserId = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireConnectedUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const getConnectedUserIdOrNull = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || isAnonymousIdentity(identity)) {
    return null;
  }
  return identity.tokenIdentifier;
};

export const getUserIdOrNull = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.tokenIdentifier ?? null;
};

export const requireConnectedUserIdAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireConnectedUserIdentityAction(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveUserIdentity = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  await assertSensitiveSessionPolicy(ctx, identity);
  return identity;
};

export const requireSensitiveUserIdentityAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireUserIdentity(ctx);
  await assertSensitiveSessionPolicyAction(ctx, identity);
  return identity;
};

export const requireSensitiveUserId = async (
  ctx: QueryCtx | MutationCtx,
) => {
  const identity = await requireSensitiveUserIdentity(ctx);
  return identity.tokenIdentifier;
};

export const requireSensitiveUserIdAction = async (
  ctx: ActionCtx,
) => {
  const identity = await requireSensitiveUserIdentityAction(ctx);
  return identity.tokenIdentifier;
};

const loadConversation = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  return await ctx.db.get(conversationId);
};

const loadConversationAction = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
) => {
  return await ctx.runQuery(internal.conversations.getById, {
    id: conversationId,
  });
};

export const tryLoadOwnedConversation = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    return null;
  }
  return conversation;
};

export const requireConversationOwner = async (
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversation(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
  }
  return conversation;
};

export const requireConversationOwnerAction = async (
  ctx: ActionCtx,
  conversationId: Id<"conversations">,
) => {
  const ownerId = await requireUserId(ctx);
  const conversation = await loadConversationAction(ctx, conversationId);
  if (!conversation || conversation.ownerId !== ownerId) {
    throw new ConvexError({
      code: "NOT_FOUND",
      message: "Conversation not found",
    });
  }
  return conversation;
};
