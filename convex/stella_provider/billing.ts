/**
 * Stella provider — billing, usage normalization, and per-device
 * anonymous rate-limit bookkeeping.
 *
 * Pulled out of `stella_provider.ts` so the three streaming /
 * authorization / request-shaping concerns stop reaching for the
 * billing helpers via large mixed imports.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "../http_shared/anon_device";

export type TokenEstimate = {
  inputTokens: number;
  outputTokens: number;
};

export type AnonymousUsageRecord = {
  deviceId: string;
  clientAddressKey?: string;
};

/**
 * Per-anonymous-device cap on the Stella provider endpoint. Each call
 * runs a managed-LLM completion that Stella pays for, so this stays
 * enforced server-side.
 *
 * Required env: `STELLA_ANON_MAX_REQUESTS` (positive integer). No
 * default — Stella is open source and the cap lives in the deployment,
 * not the repo. Throws on first read if missing or invalid.
 */
let cachedMaxAnonRequests: number | null = null;

const loadMaxAnonRequests = (): number => {
  if (cachedMaxAnonRequests !== null) return cachedMaxAnonRequests;
  const raw = process.env.STELLA_ANON_MAX_REQUESTS?.trim();
  if (!raw) {
    throw new Error(
      "[stella-provider] Missing required env STELLA_ANON_MAX_REQUESTS. Set it in Convex env before starting.",
    );
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw new Error(
      `[stella-provider] Invalid env STELLA_ANON_MAX_REQUESTS=${raw}; expected a positive integer.`,
    );
  }
  cachedMaxAnonRequests = parsed;
  return parsed;
};

export const getMaxAnonRequests = (): number => loadMaxAnonRequests();
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const STELLA_MODELS_RATE_LIMIT = 60;
export const STELLA_MODELS_RATE_WINDOW_MS = 60_000;

export async function checkDeviceRateLimit(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  try {
    const usage = await ctx.runQuery(
      internal.ai_proxy_data.getDeviceUsage,
      {
        deviceId,
        nowMs: Date.now(),
        clientAddressKey: clientAddressKey ?? undefined,
      },
    );
    return (usage?.requestCount ?? 0) < getMaxAnonRequests();
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) {
      throw error;
    }
    logMissingSaltOnce("stella-provider");
    return false;
  }
}

export async function consumeAnonymousRequestAllowance(
  ctx: ActionCtx,
  deviceId: string,
  clientAddressKey: string | null,
): Promise<boolean> {
  try {
    const usage = await ctx.runMutation(
      internal.ai_proxy_data.consumeDeviceAllowance,
      {
        deviceId,
        maxRequests: getMaxAnonRequests(),
        clientAddressKey: clientAddressKey ?? undefined,
      },
    );
    return usage.allowed;
  } catch (error) {
    if (!isAnonDeviceHashSaltMissingError(error)) {
      throw error;
    }
    logMissingSaltOnce("stella-provider");
    return false;
  }
}

export const scheduleAnonymousUsageRecord = async (
  ctx: ActionCtx,
  record: AnonymousUsageRecord | undefined,
): Promise<void> => {
  if (!record) return;
  try {
    await ctx.scheduler.runAfter(0, internal.ai_proxy_data.incrementDeviceUsage, {
      deviceId: record.deviceId,
      clientAddressKey: record.clientAddressKey,
    });
  } catch (error) {
    if (isAnonDeviceHashSaltMissingError(error)) {
      logMissingSaltOnce("stella-provider");
      return;
    }
    console.error("[stella-provider] Failed to record anonymous usage", error);
  }
};
