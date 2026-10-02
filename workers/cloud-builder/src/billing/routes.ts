/**
 * Billing's HTTP surface on the Worker.
 *
 *   POST /api/stripe/webhook           Stripe, verified by the endpoint secret
 *   POST /internal/billing/access      Convex: what an owner may spend now
 *   POST /internal/billing/usage       Convex: spend metered outside the gateway
 *   POST /internal/billing/plan        Convex admin: set a plan outside Stripe
 *   POST /internal/billing/close       Convex account deletion: end the Stripe customer
 *
 * The internal routes take the builder service secret and stay only while
 * Convex code still meters spend; each phase that moves a metered feature
 * shrinks them. They address owners whose objects already exist (an active
 * client created them), so they never place an object from Convex's region.
 */

import { verifyServiceBearerRequest } from "../service-bearer.js";
import { StripeError, stripeRequest, verifyStripeWebhook, type StripeEvent } from "./stripe.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const OWNER_ID_MAX = 512;
const MAX_USAGE_RECORDS = 200;

const metadataOwner = (value: unknown): string | null => {
  const owner = (value as { ownerId?: unknown } | null | undefined)?.ownerId;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
};

/**
 * The owner a Stripe event belongs to. Checkout, subscriptions and customers
 * carry `metadata.ownerId`; anything else is traced through its customer.
 */
const ownerForEvent = async (env: Cloudflare.Env, event: StripeEvent): Promise<string | null> => {
  const object = event.data.object;
  const direct =
    metadataOwner(object.metadata) ??
    (typeof object.client_reference_id === "string" ? object.client_reference_id : null) ??
    metadataOwner(
      (object.parent as { subscription_details?: { metadata?: unknown } } | undefined)?.subscription_details
        ?.metadata,
    ) ??
    metadataOwner((object.subscription_details as { metadata?: unknown } | undefined)?.metadata);
  if (direct) return direct;
  const customer =
    object.object === "customer" ? null : typeof object.customer === "string" ? object.customer : null;
  if (!customer) return null;
  try {
    const record = await stripeRequest<{ metadata?: unknown; deleted?: boolean }>(
      env,
      "GET",
      `/customers/${encodeURIComponent(customer)}`,
    );
    return metadataOwner(record.metadata);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return null;
    throw error;
  }
};

const stripeWebhook = async (request: Request, env: Cloudflare.Env): Promise<Response> => {
  const secret = (env as unknown as Record<string, unknown>).STRIPE_WEBHOOK_SECRET;
  if (typeof secret !== "string" || !secret.trim()) {
    return json({ error: "Stripe webhooks are not configured." }, 503);
  }
  const payload = await request.text();
  const event = await verifyStripeWebhook(payload, request.headers.get("stripe-signature"), secret.trim());
  if (!event) return json({ error: "Invalid signature." }, 400);
  const ownerId = await ownerForEvent(env, event);
  if (!ownerId || ownerId.length > OWNER_ID_MAX) {
    console.log(JSON.stringify({ event: "stripe_webhook_unowned", type: event.type, id: event.id }));
    return json({ received: true });
  }
  await env.OWNER_GATES.getByName(ownerId).applyStripeEvent(event);
  return json({ received: true });
};

const readOwnerBody = async (request: Request): Promise<Record<string, unknown> & { ownerId: string }> => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const ownerId = typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
  if (!body || !ownerId || ownerId.length > OWNER_ID_MAX) throw new Response(null, { status: 400 });
  return { ...body, ownerId };
};

const internalRoute = async (
  request: Request,
  env: Cloudflare.Env,
  action: string,
): Promise<Response> => {
  if (!(await verifyServiceBearerRequest(request, env.BUILDER_SERVICE_SECRET))) {
    return json({ error: "unauthorized" }, 401);
  }
  let body: Record<string, unknown> & { ownerId: string };
  try {
    body = await readOwnerBody(request);
  } catch {
    return json({ error: "ownerId is required." }, 400);
  }
  const gate = env.OWNER_GATES.getByName(body.ownerId);
  switch (action) {
    case "access":
      return json(
        await gate.billingAccess(
          typeof body.isAnonymous === "boolean" ? { isAnonymous: body.isAnonymous } : undefined,
        ),
      );
    case "usage": {
      const records = Array.isArray(body.records) ? body.records : null;
      if (!records || records.length === 0 || records.length > MAX_USAGE_RECORDS) {
        return json({ error: "records is required." }, 400);
      }
      const parsed: Array<{ id: string; costMicroCents: number }> = [];
      for (const record of records) {
        const id = (record as { id?: unknown }).id;
        const cost = (record as { costMicroCents?: unknown }).costMicroCents;
        if (typeof id !== "string" || !id || id.length > 256 || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
          return json({ error: "records are malformed." }, 400);
        }
        parsed.push({ id, costMicroCents: cost });
      }
      return json(await gate.recordBillingUsage(parsed));
    }
    case "plan": {
      const plan = body.plan;
      const usageMode = body.usageMode;
      if (
        (plan !== undefined && plan !== "free" && plan !== "go" && plan !== "pro") ||
        (usageMode !== undefined && usageMode !== "default" && usageMode !== "unlimited") ||
        (body.resetUsage !== undefined && typeof body.resetUsage !== "boolean")
      ) {
        return json({ error: "plan, usageMode or resetUsage is malformed." }, 400);
      }
      await gate.setBillingPlan({
        ...(plan !== undefined ? { plan } : {}),
        ...(usageMode !== undefined ? { usageMode } : {}),
        ...(typeof body.resetUsage === "boolean" ? { resetUsage: body.resetUsage } : {}),
      });
      return json({ ok: true });
    }
    case "close":
      await gate.closeBilling();
      return json({ ok: true });
    default:
      return json({ error: "Not found." }, 404);
  }
};

/** Billing routes, or null when the request is not one. */
export const handleBillingRoute = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/stripe/webhook") {
    return request.method === "POST" ? await stripeWebhook(request, env) : json({ error: "Method not allowed." }, 405);
  }
  const match = url.pathname.match(/^\/internal\/billing\/([a-z]+)$/);
  if (!match) return null;
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  return await internalRoute(request, env, match[1]!);
};
