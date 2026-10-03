import { ConvexError } from "convex/values";
import { resolveBuilderEndpoint } from "./lib/builder_turns";

/**
 * Convex's remaining calls into billing, which lives in each owner's object
 * on cloud-builder: the test-account plan override, and closing the
 * owner's Stripe customer and devices on account deletion. Over
 * `/internal/billing/*` and `/internal/devices/close` with the builder
 * service secret. Convex spends nothing itself any more.
 */

const BILLING_TIMEOUT_MS = 10_000;

const callBuilder = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
  const endpoint = resolveBuilderEndpoint();
  if (!endpoint) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Billing is not configured (CLOUD_BUILDER_URL / BUILDER_SERVICE_SECRET).",
    });
  }
  let response: Response;
  try {
    response = await fetch(`${endpoint.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
    });
  } catch {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Billing is temporarily unavailable. Try again.",
    });
  }
  if (!response.ok) {
    throw new ConvexError({
      code: "SERVICE_UNAVAILABLE",
      message: "Billing is temporarily unavailable. Try again.",
    });
  }
  return (await response.json()) as T;
};

const callBilling = <T>(action: string, body: Record<string, unknown>): Promise<T> =>
  callBuilder<T>(`/internal/billing/${action}`, body);

/** Admin and test accounts: set a plan outside Stripe. */
export const setBillingPlan = (
  ownerId: string,
  input: { plan?: "free" | "go" | "pro"; usageMode?: "default" | "unlimited"; resetUsage?: boolean },
): Promise<{ ok: true }> => callBilling("plan", { ownerId, ...input });

/** Account deletion: end the owner's Stripe customer. */
export const closeBilling = (ownerId: string): Promise<{ ok: true }> =>
  callBilling("close", { ownerId });

/** Account deletion: delete the owner's Cloudflare tunnels. */
export const closeDevices = (ownerId: string): Promise<{ ok: true }> =>
  callBuilder("/internal/devices/close", { ownerId });
