/**
 * Billing's HTTP surface on the Worker.
 *
 *   POST /api/stripe/webhook           Stripe, verified by the endpoint secret
 */

import { StripeError, stripeRequest, verifyStripeWebhook, type StripeEvent } from "./stripe.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const OWNER_ID_MAX = 512;

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

/** Billing routes, or null when the request is not one. */
export const handleBillingRoute = async (
  request: Request,
  env: Cloudflare.Env,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/stripe/webhook") {
    return request.method === "POST" ? await stripeWebhook(request, env) : json({ error: "Method not allowed." }, 405);
  }
  return null;
};
