import { ConvexError, v } from "convex/values";
import {
  GATEWAY_BUDGET_UNLIMITED,
  GATEWAY_CAPABILITY_ISSUERS,
  GATEWAY_SESSION_CAPABILITY_TTL_MS,
  type ManagedModelAudience,
} from "@stella/contracts/gateway/capability";
import type { GatewaySessionCapabilityResponse } from "@stella/contracts/gateway/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { anonymousTrialDeviceId, readDeviceAllowance } from "./ai_proxy_data";
import { assertOwnerMigrationWriteAllowed, requireUserId } from "./auth";
import {
  runPeekManagedModelAllowance,
  runResolveManagedModelAllowance,
  type ManagedModelAllowanceResult,
} from "./billing";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "./http_shared/anon_device";
import {
  MODEL_GATEWAY_URL_ENV,
  resolveModelGatewayOrigin,
} from "./http_routes/stella_models";
import { getMaxAnonRequests } from "./lib/anonymous_usage";
import {
  importCapabilitySigningKey,
  signCapability,
  type CapabilitySigningKey,
} from "./lib/capability_signing";
import { assertOwnerDataAccessActive } from "./owner_lifecycle";
import { managedModelAudienceValidator } from "./schema/gateway";

/**
 * Model-gateway capabilities minted by Convex.
 *
 * A capability carries a fixed budget the gateway meters locally, so the
 * gateway never consults billing on a request. The budget is a ceiling on one
 * capability's lifetime spend: the owner's remaining allowance, capped so a
 * leaked capability bounds exposure to `GATEWAY_ALLOWANCE_CAP_MICRO_CENTS`.
 */

/** $5 ceiling per capability; owners with more headroom mint another one. */
export const GATEWAY_ALLOWANCE_CAP_MICRO_CENTS = 500_000_000;

export const CAPABILITY_SIGNING_KEY_ENV = "CAPABILITY_SIGNING_KEY";
export const CAPABILITY_SIGNING_KID_ENV = "CAPABILITY_SIGNING_KID";

/**
 * Where the renderer's own model calls go. The Electron runtime learns the
 * gateway origin from the `/api/stella/models` catalog; renderer code that
 * talks to the gateway directly (dictation cleanup, one-shot helpers) reads it
 * here over the authenticated Convex client instead of re-fetching the catalog.
 */
export const getModelGatewayConfig = query({
  args: {},
  returns: v.object({ origin: v.string() }),
  handler: async (ctx) => {
    await requireUserId(ctx);
    const origin = resolveModelGatewayOrigin(process.env);
    if (!origin) {
      throw new ConvexError({
        code: "SERVICE_UNAVAILABLE",
        message: `Stella model gateway is not configured (${MODEL_GATEWAY_URL_ENV}).`,
      });
    }
    return { origin };
  },
});

export type OwnerModelAllowance = {
  audience: ManagedModelAudience;
  budgetMicroCents: number;
  maxRequests?: number;
  unlimited: boolean;
};

const ownerModelAllowanceValidator = v.object({
  audience: managedModelAudienceValidator,
  budgetMicroCents: v.number(),
  maxRequests: v.optional(v.number()),
  unlimited: v.boolean(),
});

type OwnerModelAllowanceArgs = {
  ownerId: string;
  ownerGeneration: string;
  isAnonymous?: boolean;
  deviceId?: string;
};

const readAnonymousOwnerModelAllowance = async (
  ctx: QueryCtx | MutationCtx,
  args: OwnerModelAllowanceArgs,
): Promise<OwnerModelAllowance> => {
  await assertOwnerMigrationWriteAllowed(
    ctx,
    args.ownerId,
    args.ownerGeneration,
  );
  const deviceId =
    args.deviceId?.trim() || anonymousTrialDeviceId(args.ownerId);
  // Fail closed: without the salt the counter cannot be read, and an
  // uncounted trial would be unbounded.
  let remaining = 0;
  try {
    remaining = (
      await readDeviceAllowance(ctx, {
        deviceId,
        maxRequests: getMaxAnonRequests(),
      })
    ).remaining;
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) throw error;
    logMissingSaltOnce("gateway-capabilities");
  }
  // Money is not the anonymous ceiling; the request count is. A zero budget
  // would read as exhausted at the gateway's ledger.
  return {
    audience: "anonymous",
    budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
    maxRequests: remaining,
    unlimited: false,
  };
};

const toOwnerModelAllowance = (
  resolved: ManagedModelAllowanceResult,
): OwnerModelAllowance => {
  if (resolved.access.unlimited || resolved.remainingMicroCents === null) {
    return {
      audience: resolved.access.modelAudience,
      budgetMicroCents: GATEWAY_BUDGET_UNLIMITED,
      unlimited: true,
    };
  }
  return {
    audience: resolved.access.modelAudience,
    budgetMicroCents: Math.max(
      0,
      Math.min(
        Math.floor(resolved.remainingMicroCents),
        GATEWAY_ALLOWANCE_CAP_MICRO_CENTS,
      ),
    ),
    unlimited: false,
  };
};

export const runPeekOwnerModelAllowance = async (
  ctx: QueryCtx | MutationCtx,
  args: OwnerModelAllowanceArgs,
): Promise<OwnerModelAllowance> => {
  if (args.isAnonymous) {
    return await readAnonymousOwnerModelAllowance(ctx, args);
  }
  return toOwnerModelAllowance(
    await runPeekManagedModelAllowance(ctx, {
      ownerId: args.ownerId,
      ownerGeneration: args.ownerGeneration,
    }),
  );
};

/** Read-only allowance for owner snapshots and other control-plane reads. */
export const peekOwnerModelAllowanceInternal = internalQuery({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    isAnonymous: v.optional(v.boolean()),
    deviceId: v.optional(v.string()),
  },
  returns: ownerModelAllowanceValidator,
  handler: async (ctx, args): Promise<OwnerModelAllowance> =>
    await runPeekOwnerModelAllowance(ctx, args),
});

/**
 * Single source of truth for capability budgets. Signed-in owners get the
 * audience from `resolveManagedModelAccess` and `min(remaining allowance,
 * cap)`, or the unlimited sentinel; anonymous owners get no monetary budget
 * and the request-count trial that is left on their device counter.
 */
export const getOwnerModelAllowanceInternal = internalMutation({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    isAnonymous: v.optional(v.boolean()),
    deviceId: v.optional(v.string()),
  },
  returns: ownerModelAllowanceValidator,
  handler: async (ctx, args): Promise<OwnerModelAllowance> => {
    if (args.isAnonymous) {
      return await readAnonymousOwnerModelAllowance(ctx, args);
    }

    return toOwnerModelAllowance(
      await runResolveManagedModelAllowance(ctx, {
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
      }),
    );
  },
});

let cachedSigningKey: {
  pem: string;
  kid: string;
  key: Promise<CapabilitySigningKey>;
} | null = null;

/** Import the ES256 signing key from env once per isolate (re-imported on rotation). */
export const loadCapabilitySigningKey = (): Promise<CapabilitySigningKey> => {
  const pem = process.env[CAPABILITY_SIGNING_KEY_ENV]?.trim();
  const kid = process.env[CAPABILITY_SIGNING_KID_ENV]?.trim();
  if (!pem || !kid) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: `Capability signing is not configured (${CAPABILITY_SIGNING_KEY_ENV} / ${CAPABILITY_SIGNING_KID_ENV}).`,
    });
  }
  if (
    !cachedSigningKey ||
    cachedSigningKey.pem !== pem ||
    cachedSigningKey.kid !== kid
  ) {
    // Env editors sometimes store the PEM with literal "\n" sequences.
    const key = importCapabilitySigningKey(pem.replace(/\\n/g, "\n"), kid);
    key.catch(() => {
      cachedSigningKey = null;
    });
    cachedSigningKey = { pem, kid, key };
  }
  return cachedSigningKey.key;
};

/**
 * Mint a `session` capability for a desktop runtime. `gen` pins the owner's
 * current data generation so a capability minted before a reset is refused at
 * the gateway; claims come from `getOwnerModelAllowanceInternal`.
 */
export const signSessionCapabilityInternal = internalAction({
  args: {
    ownerId: v.string(),
    isAnonymous: v.boolean(),
    deviceId: v.optional(v.string()),
  },
  returns: v.object({
    capability: v.string(),
    expiresAt: v.number(),
    audience: v.string(),
    budgetMicroCents: v.number(),
    maxRequests: v.optional(v.number()),
  }),
  handler: async (ctx, args): Promise<GatewaySessionCapabilityResponse> => {
    const { generation } = await assertOwnerDataAccessActive(ctx, args.ownerId);
    const allowance: OwnerModelAllowance = await ctx.runMutation(
      internal.gateway_capabilities.getOwnerModelAllowanceInternal,
      {
        ownerId: args.ownerId,
        ownerGeneration: generation,
        isAnonymous: args.isAnonymous,
        ...(args.deviceId ? { deviceId: args.deviceId } : {}),
      },
    );
    const signingKey = await loadCapabilitySigningKey();
    const { token, claims } = await signCapability(
      {
        iss: GATEWAY_CAPABILITY_ISSUERS.convex,
        sub: args.ownerId,
        gen: generation,
        kind: "session",
        audience: allowance.audience,
        budgetMicroCents: allowance.budgetMicroCents,
        ...(allowance.maxRequests !== undefined
          ? { maxRequests: allowance.maxRequests }
          : {}),
      },
      signingKey,
      { ttlMs: GATEWAY_SESSION_CAPABILITY_TTL_MS },
    );
    return {
      capability: token,
      expiresAt: claims.exp * 1000,
      audience: allowance.audience,
      budgetMicroCents: allowance.budgetMicroCents,
      ...(allowance.maxRequests !== undefined
        ? { maxRequests: allowance.maxRequests }
        : {}),
    };
  },
});
