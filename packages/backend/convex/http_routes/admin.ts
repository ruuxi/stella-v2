import { setBillingPlan } from "../billing_bridge";
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { requireAdminRequest } from "../http_shared/admin";
import {
  readBetterAuthResponseUserId,
  readBetterAuthSessionToken,
} from "../http_shared/better_auth_response";
import { requireTestAccountsEnabled } from "../http_shared/test_accounts";
import { createAuth, tokenIdentifierForBetterAuthUserId } from "../auth";

/**
 * The one admin route left in Convex: minting a Better Auth session for a
 * test account. The rest of admin is served by cloud-builder.
 */
const ADMIN_TEST_ACCOUNT_SESSION_PATH = "/api/admin/test-accounts/session";

type AdminTestAccountBody = {
  email?: unknown;
  plan?: unknown;
  usageMode?: unknown;
};

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
        // Test accounts only: this first touch places the owner's object
        // near Convex rather than the tester, which dev tolerates.
        await setBillingPlan(ownerId, {
          plan: parsed.plan,
          ...(parsed.usageMode ? { usageMode: parsed.usageMode } : {}),
        });
        activePlan = parsed.plan;
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
};
