import { AUTH_CAPTCHA_ENDPOINTS } from "@stella/contracts/auth-challenge";
import { APIError } from "better-auth/api";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getClientAddressKey } from "./http_utils";

export type AuthIpRateLimitKind = "anonymous" | "magic_link";

export type AuthIpRateLimitPolicy = {
  kind: AuthIpRateLimitKind;
  limit: number;
  periodMs: number;
};

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

export const getAuthIpRateLimitPolicy = (
  path: string | undefined,
): AuthIpRateLimitPolicy | null => {
  if (path === AUTH_CAPTCHA_ENDPOINTS[0]) {
    return { kind: "anonymous", limit: 20, periodMs: DAY_MS };
  }
  if (path === AUTH_CAPTCHA_ENDPOINTS[1]) {
    return { kind: "magic_link", limit: 10, periodMs: HOUR_MS };
  }
  return null;
};

export const enforceAuthIpRateLimit = async (
  ctx: Pick<ActionCtx, "runMutation">,
  request: Request | undefined,
  path: string | undefined,
): Promise<void> => {
  const policy = getAuthIpRateLimitPolicy(path);
  if (!policy || !request) return;
  const clientAddress = getClientAddressKey(request);
  if (!clientAddress) return;

  const result: { allowed: boolean; retryAfterMs: number } =
    await ctx.runMutation(internal.rate_limits.consumeAuthIpRateLimit, {
      kind: policy.kind,
      key: clientAddress,
    });
  if (!result.allowed) {
    throw new APIError("TOO_MANY_REQUESTS", {
      message: "Too many sign-in attempts. Try again later.",
    });
  }
};
