/**
 * Stella provider — billing, usage normalization, and anonymous
 * rate-limit bookkeeping (per-device + per-IP).
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
import {
  getMaxAnonRequests,
  getMaxAnonRequestsPerIp,
} from "../lib/anonymous_usage";

export type TokenEstimate = {
  inputTokens: number;
  outputTokens: number;
};

/**
 * Per-anonymous-device cap on the Stella provider endpoint. Each call
 * runs a managed-LLM completion that Stella pays for, so this stays
 * enforced server-side.
 *
 * Required env: `STELLA_ANON_MAX_REQUESTS` (positive integer). The shared
 * policy loader validates it and also exposes it to subscription status.
 *
 * This per-device counter resets whenever a user deletes Stella's local
 * data (a new anonymous identity is minted, so a fresh `deviceId`). It is
 * the per-person trial size, not an abuse backstop — see the per-IP cap
 * below for the durable ceiling.
 */
/**
 * Per-IP cap on anonymous Stella provider usage. IP is the one identifier
 * that survives a local-data wipe, so this is the durable ceiling that
 * stops spam-reset abuse (delete data -> new anon identity -> fresh device
 * counter, but the same IP bucket).
 *
 * Optional env: `STELLA_ANON_MAX_REQUESTS_PER_IP` (positive integer). When
 * unset it defaults to `STELLA_ANON_MAX_REQUESTS * ANON_IP_CAP_DEFAULT_MULTIPLIER`
 * so the network ceiling sits well above the per-person trial out of the box
 * (shared networks — dorms, offices, CGNAT — aren't starved) while a single
 * machine's resets still hit the ceiling. Deriving from the per-device cap also
 * guarantees the invariant `ipCap >= deviceCap`, so a lone legitimate user
 * never trips the IP wall before exhausting their own device trial.
 */
/**
 * Constant `deviceId` for the per-IP counter. Hashing this with the client
 * IP (`hash(salt, "anon-ip|addr:<IP>")`) yields a bucket keyed purely on
 * the network address, with no resettable per-install component.
 */
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

/**
 * Consume one allowance from the durable per-IP counter. When no client IP
 * is resolvable (e.g. self-host without a reverse proxy), the per-IP cap
 * can't be enforced, so we fall back to the per-device cap alone rather than
 * collapsing every IP-less caller into one global bucket.
 */
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
