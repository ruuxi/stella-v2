import { makeFunctionReference, type HttpRouter } from "convex/server";
import {
  type OwnerEnforcement,
  type OwnerEnforcementStatus,
} from "@stella/contracts/gateway/usage";
import { httpAction } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { requireAdminRequest } from "../http_shared/admin";
import {
  readBetterAuthResponseUserId,
  readBetterAuthSessionToken,
} from "../http_shared/better_auth_response";
import { requireTestAccountsEnabled } from "../http_shared/test_accounts";
import {
  createAuth,
  resolveOwnerAccountAction,
  tokenIdentifierForBetterAuthUserId,
} from "../auth";

const ADMIN_DELETE_PATH = "/api/admin/delete";
const ADMIN_BILLING_PLAN_PATH = "/api/admin/billing/plan";
const ADMIN_TEST_ACCOUNT_SESSION_PATH = "/api/admin/test-accounts/session";
const ADMIN_OWNER_ENFORCEMENT_PATH = "/api/admin/owners/enforcement";
const ADMIN_OWNER_LOOKUP_PATH = "/api/admin/owners/lookup";
const ADMIN_OWNER_TOP_PATH = "/api/admin/owners/top";
const MEDIA_DELETE_MAX_STEPS = 200;

type AdminDeleteBody = {
  kind?: string;
  id?: string;
};

type AdminBillingPlanBody = {
  ownerId?: string;
  plan?: string;
  unlimited?: boolean;
  usageMode?: string;
  subscriptionStatus?: string;
  resetUsage?: boolean;
};

type AdminTestAccountBody = {
  email?: unknown;
  plan?: unknown;
  usageMode?: unknown;
};

type AdminOwnerEnforcementBody = {
  ownerId?: unknown;
  email?: unknown;
  status?: unknown;
  until?: unknown;
  reason?: unknown;
};

type AdminAuthUser = {
  _id?: string;
  email?: string;
  isAnonymous?: boolean | null;
};

type AdminBillingWindow = {
  usedMicroCents: number;
  limitMicroCents: number;
  remainingMicroCents: number | null;
  resetAt: number;
};

type AdminBillingSummary = {
  plan: "free" | "go" | "pro";
  unlimited: boolean;
  creditMicroCents: number;
  reservedMicroCents: number;
  totalUsageMicroCents: number;
  totalRequestCount: number;
  rolling: AdminBillingWindow;
  weekly: AdminBillingWindow;
  monthly: AdminBillingWindow;
  lifetime: AdminBillingWindow | null;
};

type AdminGatewayState = {
  enforcement: OwnerEnforcement;
  unreleasedGrants: unknown[];
  usageReceipts: unknown[];
  riskSignals: unknown[];
};

const setOwnerEnforcementRef = makeFunctionReference<
  "mutation",
  {
    ownerId: string;
    status: OwnerEnforcementStatus;
    until?: number;
    reason: string;
    actor: string;
  },
  unknown
>("owner_enforcement:setOwnerEnforcementInternal");

const getOwnerGatewayAdminStateRef = makeFunctionReference<
  "query",
  { ownerId: string },
  AdminGatewayState
>("owner_enforcement:getOwnerGatewayAdminStateInternal");

const getOwnerBillingWindowSummaryRef = makeFunctionReference<
  "query",
  { ownerId: string; isAnonymous: boolean },
  AdminBillingSummary
>("billing:getOwnerBillingWindowSummaryInternal");

const listTopOwnerRiskSignalsRef = makeFunctionReference<
  "query",
  {
    window: "1h" | "24h";
    by: "spend" | "requests" | "mints" | "score";
  },
  unknown[]
>("risk:listTopOwnerRiskSignalsInternal");

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const parseRequestJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const readDeleteBody = async (
  request: Request,
): Promise<{ kind: string; id: string } | Response> => {
  const body = (await parseRequestJson(request)) as AdminDeleteBody | null;
  const kind = typeof body?.kind === "string" ? body.kind.trim() : "";
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!kind || !id) {
    return jsonResponse(400, { error: "Missing kind or id." });
  }
  return { kind, id };
};

const isBillingPlan = (value: string): value is "free" | "go" | "pro" =>
  value === "free" || value === "go" || value === "pro";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const randomLetters = (length: number): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(length)),
    (byte) => alphabet[byte % alphabet.length],
  ).join("");
};

const defaultTestAccountEmail = (): string =>
  `agent-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}@test.stella.local`;

const readTestAccountBody = async (
  request: Request,
): Promise<
  | {
      email: string;
      plan?: "free" | "go" | "pro";
      usageMode?: "default" | "unlimited";
    }
  | Response
> => {
  const parsed = await parseRequestJson(request);
  if (!isRecord(parsed)) {
    return jsonResponse(400, { error: "Body must be a JSON object." });
  }
  const body: AdminTestAccountBody = parsed;

  if (body.email !== undefined && typeof body.email !== "string") {
    return jsonResponse(400, { error: "email must be a string." });
  }
  const email =
    typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : defaultTestAccountEmail();
  if (!email.endsWith("@test.stella.local")) {
    return jsonResponse(400, {
      error: "email must end with @test.stella.local.",
    });
  }

  if (body.plan !== undefined && typeof body.plan !== "string") {
    return jsonResponse(400, { error: "plan must be free, go, or pro." });
  }
  const rawPlan =
    typeof body.plan === "string" ? body.plan.trim().toLowerCase() : "";
  if (rawPlan && !isBillingPlan(rawPlan)) {
    return jsonResponse(400, { error: `Unsupported plan: ${rawPlan}` });
  }

  if (body.usageMode !== undefined && typeof body.usageMode !== "string") {
    return jsonResponse(400, {
      error: "usageMode must be default or unlimited.",
    });
  }
  const rawUsageMode =
    typeof body.usageMode === "string"
      ? body.usageMode.trim().toLowerCase()
      : "";
  if (
    rawUsageMode &&
    rawUsageMode !== "default" &&
    rawUsageMode !== "unlimited"
  ) {
    return jsonResponse(400, {
      error: `Unsupported usageMode: ${rawUsageMode}`,
    });
  }

  return {
    email,
    ...(isBillingPlan(rawPlan) ? { plan: rawPlan } : {}),
    ...(rawUsageMode === "default" || rawUsageMode === "unlimited"
      ? { usageMode: rawUsageMode }
      : {}),
  };
};

const readBillingPlanBody = async (
  request: Request,
): Promise<
  | {
      ownerId: string;
      plan?: "free" | "go" | "pro";
      usageMode?: "default" | "unlimited";
      subscriptionStatus?: string;
      resetUsage?: boolean;
    }
  | Response
> => {
  const body = (await parseRequestJson(request)) as AdminBillingPlanBody | null;
  const ownerId = typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
  if (!ownerId) {
    return jsonResponse(400, { error: "Missing ownerId." });
  }

  const rawPlan =
    typeof body?.plan === "string" ? body.plan.trim().toLowerCase() : "";
  let plan: "free" | "go" | "pro" | undefined;
  if (rawPlan && isBillingPlan(rawPlan)) {
    plan = rawPlan;
  } else if (rawPlan) {
    return jsonResponse(400, { error: `Unsupported plan: ${rawPlan}` });
  }

  const rawUsageMode =
    typeof body?.usageMode === "string"
      ? body.usageMode.trim().toLowerCase()
      : "";
  let usageMode: "default" | "unlimited" | undefined;
  if (typeof body?.unlimited === "boolean") {
    usageMode = body.unlimited ? "unlimited" : "default";
  } else if (rawUsageMode === "default" || rawUsageMode === "unlimited") {
    usageMode = rawUsageMode;
  } else if (rawUsageMode) {
    return jsonResponse(400, {
      error: `Unsupported usageMode: ${rawUsageMode}`,
    });
  }

  const subscriptionStatus =
    typeof body?.subscriptionStatus === "string"
      ? body.subscriptionStatus.trim()
      : undefined;
  const resetUsage =
    typeof body?.resetUsage === "boolean" ? body.resetUsage : undefined;

  return {
    ownerId,
    ...(plan ? { plan } : {}),
    ...(usageMode ? { usageMode } : {}),
    ...(subscriptionStatus ? { subscriptionStatus } : {}),
    ...(resetUsage !== undefined ? { resetUsage } : {}),
  };
};

const readOptionalLocator = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
};

const findAdminAuthUser = async (
  ctx: Parameters<typeof resolveOwnerAccountAction>[0],
  locator: { ownerId?: string; email?: string },
): Promise<{ ownerId: string; user: AdminAuthUser } | null> => {
  if (locator.ownerId) {
    const account = await resolveOwnerAccountAction(ctx, locator.ownerId);
    if (!account) return null;
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", value: account.userId }],
    })) as AdminAuthUser | null;
    return user ? { ownerId: locator.ownerId, user } : null;
  }
  if (!locator.email) return null;
  const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "email", value: locator.email }],
  })) as AdminAuthUser | null;
  return user?._id
    ? { ownerId: tokenIdentifierForBetterAuthUserId(user._id), user }
    : null;
};

const readOwnerLocator = (
  ownerIdValue: unknown,
  emailValue: unknown,
): { ownerId?: string; email?: string } | Response => {
  const ownerId = readOptionalLocator(ownerIdValue);
  const email = readOptionalLocator(emailValue)?.toLowerCase();
  if (Boolean(ownerId) === Boolean(email)) {
    return jsonResponse(400, {
      error: "Provide exactly one of ownerId or email.",
    });
  }
  return { ...(ownerId ? { ownerId } : {}), ...(email ? { email } : {}) };
};

const isOwnerEnforcementStatus = (
  value: string,
): value is OwnerEnforcementStatus => {
  switch (value) {
    case "ok":
    case "challenged":
    case "throttled":
    case "suspended":
      return true;
    default:
      return false;
  }
};

export const registerAdminRoutes = (http: HttpRouter) => {
  http.route({
    path: ADMIN_TEST_ACCOUNT_SESSION_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      const enabled = requireTestAccountsEnabled();
      if (!enabled.ok) return enabled.response;

      const parsed = await readTestAccountBody(request);
      if (parsed instanceof Response) return parsed;

      const auth = createAuth(ctx);
      const context = await auth.$context;
      const token = randomLetters(32);
      await context.internalAdapter.createVerificationValue({
        identifier: token,
        value: JSON.stringify({ email: parsed.email, name: "" }),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      });
      const verifyRes = await auth.api.magicLinkVerify({
        query: { token },
        headers: new Headers(),
        returnHeaders: true,
      });
      const sessionToken = readBetterAuthSessionToken(verifyRes);
      const userId = readBetterAuthResponseUserId(verifyRes);
      if (!sessionToken || !userId) {
        return jsonResponse(500, {
          error: "Better Auth did not return a test account session.",
        });
      }

      const ownerId = tokenIdentifierForBetterAuthUserId(userId);
      let activePlan: "free" | "go" | "pro" = "free";
      if (parsed.plan) {
        const billing = await ctx.runMutation(
          internal.billing.setAdminBillingPlan,
          {
            ownerId,
            plan: parsed.plan,
            ...(parsed.usageMode ? { usageMode: parsed.usageMode } : {}),
          },
        );
        activePlan = billing.activePlan;
      }

      return jsonResponse(200, {
        ownerId,
        userId,
        email: parsed.email,
        sessionToken,
        plan: activePlan,
        siteUrl: process.env.CONVEX_SITE_URL,
      });
    }),
  });

  http.route({
    path: ADMIN_OWNER_ENFORCEMENT_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      const body = (await parseRequestJson(
        request,
      )) as AdminOwnerEnforcementBody | null;
      const locator = readOwnerLocator(body?.ownerId, body?.email);
      if (locator instanceof Response) return locator;
      const status =
        typeof body?.status === "string"
          ? body.status.trim().toLowerCase()
          : "";
      if (!isOwnerEnforcementStatus(status)) {
        return jsonResponse(400, { error: "Invalid enforcement status." });
      }
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      if (!reason || reason.length > 1_000) {
        return jsonResponse(400, {
          error: "reason must be 1 to 1,000 characters.",
        });
      }
      const until = body?.until;
      if (
        until !== undefined &&
        (typeof until !== "number" || !Number.isFinite(until))
      ) {
        return jsonResponse(400, { error: "until must be a timestamp." });
      }
      const resolved = await findAdminAuthUser(ctx, locator);
      if (!resolved) return jsonResponse(404, { error: "Owner not found." });
      const result = await ctx.runMutation(setOwnerEnforcementRef, {
        ownerId: resolved.ownerId,
        status,
        ...(typeof until === "number" ? { until } : {}),
        reason,
        actor: "admin-api",
      });
      return jsonResponse(200, result);
    }),
  });

  http.route({
    path: ADMIN_OWNER_LOOKUP_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      const url = new URL(request.url);
      const locator = readOwnerLocator(
        url.searchParams.get("ownerId") ?? undefined,
        url.searchParams.get("email") ?? undefined,
      );
      if (locator instanceof Response) return locator;
      const resolved = await findAdminAuthUser(ctx, locator);
      if (!resolved) return jsonResponse(404, { error: "Owner not found." });
      const isAnonymous = resolved.user.isAnonymous === true;
      const [billing, gateway] = await Promise.all([
        ctx.runQuery(getOwnerBillingWindowSummaryRef, {
          ownerId: resolved.ownerId,
          isAnonymous,
        }),
        ctx.runQuery(getOwnerGatewayAdminStateRef, {
          ownerId: resolved.ownerId,
        }),
      ]);
      return jsonResponse(200, {
        ownerId: resolved.ownerId,
        isAnonymous,
        ...(resolved.user.email ? { email: resolved.user.email } : {}),
        plan: billing.plan,
        enforcement: gateway.enforcement,
        billingWindows: {
          unlimited: billing.unlimited,
          creditMicroCents: billing.creditMicroCents,
          reservedMicroCents: billing.reservedMicroCents,
          totalUsageMicroCents: billing.totalUsageMicroCents,
          totalRequestCount: billing.totalRequestCount,
          rolling: billing.rolling,
          weekly: billing.weekly,
          monthly: billing.monthly,
          lifetime: billing.lifetime,
        },
        unreleasedGrants: gateway.unreleasedGrants,
        usageReceipts: gateway.usageReceipts,
        riskSignals: gateway.riskSignals,
      });
    }),
  });

  http.route({
    path: ADMIN_OWNER_TOP_PATH,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;
      const url = new URL(request.url);
      const window = url.searchParams.get("window");
      const by = url.searchParams.get("by");
      if (window !== "1h" && window !== "24h") {
        return jsonResponse(400, { error: "window must be 1h or 24h." });
      }
      if (
        by !== "spend" &&
        by !== "requests" &&
        by !== "mints" &&
        by !== "score"
      ) {
        return jsonResponse(400, {
          error: "by must be spend, requests, mints, or score.",
        });
      }
      const owners = await ctx.runQuery(listTopOwnerRiskSignalsRef, {
        window,
        by,
      });
      return jsonResponse(200, { window, by, owners });
    }),
  });

  http.route({
    path: ADMIN_BILLING_PLAN_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;

      const parsed = await readBillingPlanBody(request);
      if (parsed instanceof Response) return parsed;

      return jsonResponse(
        200,
        await ctx.runMutation(internal.billing.setAdminBillingPlan, parsed),
      );
    }),
  });

  http.route({
    path: ADMIN_DELETE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const admin = requireAdminRequest(request);
      if (!admin.ok) return admin.response;

      const parsed = await readDeleteBody(request);
      if (parsed instanceof Response) return parsed;

      const { kind, id } = parsed;
      switch (kind) {
        case "emoji_pack":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteEmojiPack, {
              packId: id,
            }),
          );
        case "media_job": {
          let result: { hasMore?: boolean } | null = null;
          for (let step = 0; step < MEDIA_DELETE_MAX_STEPS; step += 1) {
            result = await ctx.runMutation(
              internal.admin_deletes.deleteMediaJob,
              { jobId: id },
            );
            if (result && !result.hasMore) return jsonResponse(200, result);
          }
          return jsonResponse(409, {
            error: "Media job delete needs another request.",
            kind,
            id,
            hasMore: true,
          });
        }
        case "feedback":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteFeedback, {
              id,
            }),
          );
        case "desktop_release":
          return jsonResponse(
            200,
            await ctx.runMutation(internal.admin_deletes.deleteDesktopRelease, {
              platform: id,
            }),
          );
        default:
          return jsonResponse(400, {
            error: `Unsupported delete kind: ${kind}`,
          });
      }
    }),
  });
};
