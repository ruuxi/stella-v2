import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  isAnonDeviceHashSaltMissingError,
  logMissingSaltOnce,
} from "../http_shared/anon_device";
import {
  getMaxAnonRequests,
  getMaxAnonRequestsPerIp,
} from "../lib/anonymous_usage";

export type TokenEstimate = {
  inputTokens: number;
  outputTokens: number;
};

const ANON_IP_BUCKET_DEVICE_ID = "anon-ip";
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const STELLA_MODELS_RATE_LIMIT = 60;
export const STELLA_MODELS_RATE_WINDOW_MS = 60_000;

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

export async function consumeAnonymousIpAllowance(
  ctx: ActionCtx,
  clientAddressKey: string | null,
): Promise<boolean> {
  if (!clientAddressKey) return true;
  try {
    const usage = await ctx.runMutation(
      internal.ai_proxy_data.consumeDeviceAllowance,
      {
        deviceId: ANON_IP_BUCKET_DEVICE_ID,
        maxRequests: getMaxAnonRequestsPerIp(),
        clientAddressKey,
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
