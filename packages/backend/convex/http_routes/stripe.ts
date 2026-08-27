import Stripe from "stripe";
import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  consumeWebhookRateLimit,
  rateLimitResponse,
} from "../http_shared/webhook_controls";
import { getClientAddressKey } from "../lib/http_utils";

const STRIPE_API_VERSION = "2026-05-27.dahlia";

// Caps used for the Stripe webhook surface. The per-IP limit stops a
// leaked endpoint from being used to exhaust Convex transaction budget
// by spamming malformed payloads — it runs before Stripe's signature
// verification, so we gate on the source IP.
const STRIPE_WEBHOOK_PER_IP_LIMIT = 120;
const STRIPE_WEBHOOK_PER_IP_WINDOW_MS = 60_000;

const toSafeString = (value: string | null | undefined) => value?.trim() ?? "";

const toPaidPlan = (value: string | null | undefined) => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "go" || normalized === "pro" ? normalized : undefined;
};

const toPositiveInteger = (value: string | number | null | undefined) => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const getStripeClient = () => {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    throw new Error("Missing STRIPE_SECRET_KEY");
  }

  return new Stripe(secret, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
};

const getWebhookSecret = () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing STRIPE_WEBHOOK_SECRET");
  }
  return secret;
};

const toPeriodMs = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value * 1000)
    : undefined;

const normalizePaymentMethod = async (
  stripe: Stripe,
  paymentMethod: string | Stripe.PaymentMethod | null,
) => {
  if (!paymentMethod) {
    return {
      id: "",
      brand: "",
      last4: "",
    };
  }

  if (typeof paymentMethod === "string") {
    try {
      const fetched = await stripe.paymentMethods.retrieve(paymentMethod);
      return {
        id: fetched.id,
        brand: fetched.card?.brand ?? "",
        last4: fetched.card?.last4 ?? "",
      };
    } catch (error) {
      const candidate = error as { code?: unknown; statusCode?: unknown };
      if (
        candidate.code !== "resource_missing" &&
        candidate.statusCode !== 404
      ) {
        throw error;
      }
      return {
        id: paymentMethod,
        brand: "",
        last4: "",
      };
    }
  }

  return {
    id: paymentMethod.id,
    brand: paymentMethod.card?.brand ?? "",
    last4: paymentMethod.card?.last4 ?? "",
  };
};

export const registerStripeRoutes = (http: HttpRouter) => {
  http.route({
    path: "/api/stripe/webhook",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      // Per-IP guard runs *before* signature verification so a leaked
      // endpoint or random scanner can't drive unlimited Stripe SDK
      // verification work.
      const clientAddress = getClientAddressKey(request);
      if (clientAddress) {
        const ipRateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "stripe_webhook_ip",
          key: clientAddress,
          limit: STRIPE_WEBHOOK_PER_IP_LIMIT,
          windowMs: STRIPE_WEBHOOK_PER_IP_WINDOW_MS,
          blockMs: STRIPE_WEBHOOK_PER_IP_WINDOW_MS,
        });
        if (!ipRateLimit.allowed) {
          return rateLimitResponse(ipRateLimit.retryAfterMs);
        }
      }

      let stripe: Stripe;
      let webhookSecret: string;

      try {
        stripe = getStripeClient();
        webhookSecret = getWebhookSecret();
      } catch (error) {
        console.error("[stripe-webhook] Missing Stripe configuration", error);
        return new Response("Stripe is not configured", { status: 503 });
      }

      const signature = request.headers.get("stripe-signature");
      if (!signature) {
        return new Response("Missing stripe-signature header", { status: 400 });
      }

      const payload = await request.text();
      let event: Stripe.Event;

      try {
        event = await stripe.webhooks.constructEventAsync(
          payload,
          signature,
          webhookSecret,
        );
      } catch (error) {
        console.error("[stripe-webhook] Signature verification failed", error);
        return new Response("Invalid Stripe signature", { status: 400 });
      }

      const eventObject = event.data.object as unknown as Record<
        string,
        unknown
      >;
      const eventMetadata =
        eventObject.metadata && typeof eventObject.metadata === "object"
          ? (eventObject.metadata as Record<string, unknown>)
          : undefined;
      const eventOwnerId = toSafeString(
        typeof eventMetadata?.ownerId === "string"
          ? eventMetadata.ownerId
          : undefined,
      );
      const eventCustomerId = toSafeString(
        typeof eventObject.id === "string" &&
          event.type.startsWith("customer.") &&
          !event.type.startsWith("customer.subscription.")
          ? eventObject.id
          : typeof eventObject.customer === "string"
            ? eventObject.customer
            : undefined,
      );
      const eventParent =
        eventObject.parent && typeof eventObject.parent === "object"
          ? (eventObject.parent as Record<string, unknown>)
          : undefined;
      const eventSubscriptionDetails =
        eventParent?.subscription_details &&
        typeof eventParent.subscription_details === "object"
          ? (eventParent.subscription_details as Record<string, unknown>)
          : undefined;
      const nestedEventSubscription =
        typeof eventSubscriptionDetails?.subscription === "string"
          ? eventSubscriptionDetails.subscription
          : eventSubscriptionDetails?.subscription &&
              typeof eventSubscriptionDetails.subscription === "object" &&
              typeof (
                eventSubscriptionDetails.subscription as Record<string, unknown>
              ).id === "string"
            ? ((
                eventSubscriptionDetails.subscription as Record<string, unknown>
              ).id as string)
            : undefined;
      const eventSubscriptionId = toSafeString(
        typeof eventObject.id === "string" &&
          event.type.startsWith("customer.subscription")
          ? eventObject.id
          : typeof eventObject.subscription === "string"
            ? eventObject.subscription
            : nestedEventSubscription,
      );
      const eventPaymentMethodId = toSafeString(
        typeof eventObject.id === "string" &&
          event.type.startsWith("payment_method.")
          ? eventObject.id
          : undefined,
      );
      const eventCheckoutSessionId = toSafeString(
        typeof eventObject.id === "string" &&
          event.type.startsWith("checkout.session.")
          ? eventObject.id
          : undefined,
      );
      const claimId = crypto.randomUUID();

      // Dedup via billing_stripe_events: Stripe's retry policy can fire the
      // same event id repeatedly. The record is deleted again in the failure
      // path below so a Stripe retry can reprocess the event — do not add a
      // non-releasable dedup layer in front of this.
      const dedup = await ctx.runMutation(internal.billing.recordStripeEvent, {
        eventId: event.id,
        claimId,
        eventType: event.type,
        ownerId: eventOwnerId || undefined,
        stripeCustomerId: eventCustomerId || undefined,
        stripeSubscriptionId: eventSubscriptionId || undefined,
        stripePaymentMethodId: eventPaymentMethodId || undefined,
        stripeCheckoutSessionId: eventCheckoutSessionId || undefined,
        createdAt: toPeriodMs(event.created) ?? Date.now(),
      });

      if (!dedup.accepted) {
        if (dedup.status === "in_progress" || dedup.status === "retry") {
          return new Response("Webhook processing is already in progress", {
            status: 503,
            headers: { "Retry-After": "1" },
          });
        }
        return new Response(
          JSON.stringify({ received: true, duplicate: true }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        );
      }

      try {
        const claimFence = await ctx.runQuery(
          internal.billing.getStripeEventClaimFenceInternal,
          { eventId: event.id, claimId },
        );
        if (!claimFence) {
          throw new Error("Stripe webhook claim lost its admission fence.");
        }
        const canonicalOwnerId = claimFence.ownerId;
        const ownerGeneration = claimFence.ownerGeneration;
        switch (event.type) {
          case "checkout.session.async_payment_succeeded":
          case "checkout.session.completed": {
            const session = event.data.object as Stripe.Checkout.Session;
            const ownerId = canonicalOwnerId;
            const customerId = toSafeString(
              typeof session.customer === "string"
                ? session.customer
                : undefined,
            );
            if (
              session.mode === "payment" &&
              session.metadata?.purpose === "usage_credit"
            ) {
              const paymentIntentId = toSafeString(
                typeof session.payment_intent === "string"
                  ? session.payment_intent
                  : session.payment_intent?.id,
              );
              const amountCents =
                toPositiveInteger(session.metadata?.amountCents) ||
                toPositiveInteger(session.amount_total);

              if (ownerId && customerId && amountCents > 0) {
                await ctx.runMutation(
                  internal.billing.recordUsageCreditPurchase,
                  {
                    ownerId,
                    ownerGeneration,
                    stripeEventCreatedAt:
                      toPeriodMs(event.created) ?? Date.now(),
                    stripeCheckoutSessionId: session.id,
                    stripePaymentIntentId: paymentIntentId || undefined,
                    stripeCustomerId: customerId,
                    amountCents,
                    currency: session.currency ?? "usd",
                    status: session.payment_status ?? "unknown",
                  },
                );
              }
              break;
            }

            if (session.mode !== "subscription") {
              break;
            }

            const requestedPlan = toPaidPlan(session.metadata?.plan);
            const subscriptionId = toSafeString(
              typeof session.subscription === "string"
                ? session.subscription
                : undefined,
            );

            if (subscriptionId) {
              const subscription = await stripe.subscriptions.retrieve(
                subscriptionId,
                {
                  expand: ["default_payment_method"],
                },
              );

              const paymentMethod = await normalizePaymentMethod(
                stripe,
                subscription.default_payment_method,
              );
              const priceId = toSafeString(
                subscription.items.data[0]?.price?.id,
              );

              const firstItem = subscription.items.data[0];
              await ctx.runMutation(
                internal.billing.syncSubscriptionFromStripe,
                {
                  ownerId: ownerId || undefined,
                  ownerGeneration,
                  stripeEventCreatedAt: toPeriodMs(event.created) ?? Date.now(),
                  stripeEventId: event.id,
                  stripeCustomerId: customerId,
                  stripeSubscriptionId: subscription.id,
                  stripePriceId: priceId || undefined,
                  requestedPlan,
                  subscriptionStatus: subscription.status,
                  cancelAtPeriodEnd: subscription.cancel_at_period_end,
                  currentPeriodStart: toPeriodMs(
                    firstItem?.current_period_start,
                  ),
                  currentPeriodEnd: toPeriodMs(firstItem?.current_period_end),
                  defaultPaymentMethodId: paymentMethod.id || undefined,
                  paymentMethodBrand: paymentMethod.brand || undefined,
                  paymentMethodLast4: paymentMethod.last4 || undefined,
                },
              );
            }

            break;
          }

          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted": {
            const eventSubscription = event.data.object as Stripe.Subscription;
            const subscription =
              event.type === "customer.subscription.deleted"
                ? eventSubscription
                : await stripe.subscriptions.retrieve(eventSubscription.id, {
                    expand: ["default_payment_method"],
                  });
            const customerId = toSafeString(
              typeof subscription.customer === "string"
                ? subscription.customer
                : undefined,
            );
            const requestedPlan = toPaidPlan(subscription.metadata?.plan);
            const ownerId = canonicalOwnerId;
            const firstItem = subscription.items.data[0];
            const priceId = toSafeString(firstItem?.price?.id);
            const paymentMethod = await normalizePaymentMethod(
              stripe,
              subscription.default_payment_method,
            );

            await ctx.runMutation(internal.billing.syncSubscriptionFromStripe, {
              ownerId: ownerId || undefined,
              ownerGeneration,
              stripeEventCreatedAt: toPeriodMs(event.created) ?? Date.now(),
              stripeEventId: event.id,
              stripeEventTerminal:
                event.type === "customer.subscription.deleted",
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscription.id,
              stripePriceId: priceId || undefined,
              requestedPlan,
              subscriptionStatus: subscription.status,
              cancelAtPeriodEnd: subscription.cancel_at_period_end,
              currentPeriodStart: toPeriodMs(firstItem?.current_period_start),
              currentPeriodEnd: toPeriodMs(firstItem?.current_period_end),
              defaultPaymentMethodId: paymentMethod.id || undefined,
              paymentMethodBrand: paymentMethod.brand || undefined,
              paymentMethodLast4: paymentMethod.last4 || undefined,
            });
            break;
          }

          case "customer.updated": {
            const eventCustomer = event.data.object as Stripe.Customer;
            if (eventCustomer.deleted) {
              break;
            }
            const customer = await stripe.customers.retrieve(eventCustomer.id);
            if (customer.deleted) break;

            const customerId = toSafeString(customer.id);
            const defaultPaymentMethod =
              customer.invoice_settings.default_payment_method;
            const paymentMethod = await normalizePaymentMethod(
              stripe,
              typeof defaultPaymentMethod === "string"
                ? defaultPaymentMethod
                : null,
            );

            if (customerId) {
              await ctx.runMutation(
                internal.billing.updatePaymentMethodForCustomer,
                {
                  stripeCustomerId: customerId,
                  ownerGeneration,
                  stripeEventCreatedAt: toPeriodMs(event.created) ?? Date.now(),
                  stripeEventId: event.id,
                  defaultPaymentMethodId: paymentMethod.id || undefined,
                  paymentMethodBrand: paymentMethod.brand || undefined,
                  paymentMethodLast4: paymentMethod.last4 || undefined,
                },
              );
            }

            break;
          }

          case "customer.deleted": {
            // Stripe's generic Event typing does not reliably discriminate
            // deleted customers. We need only the inert identifier here, so
            // inspect the payload structurally instead of asserting a richer
            // live-customer shape.
            const customer = event.data.object as unknown;
            const rawCustomerId =
              customer && typeof customer === "object"
                ? (customer as { id?: unknown }).id
                : undefined;
            const customerId =
              typeof rawCustomerId === "string"
                ? toSafeString(rawCustomerId)
                : null;
            if (customerId) {
              await ctx.runMutation(
                internal.billing.syncCustomerDeletionFromStripe,
                {
                  stripeCustomerId: customerId,
                  ownerGeneration,
                  stripeEventCreatedAt: toPeriodMs(event.created) ?? Date.now(),
                  stripeEventId: event.id,
                },
              );
            }
            break;
          }

          case "invoice.payment_succeeded":
          case "invoice.payment_failed":
          case "invoice.payment_action_required": {
            const invoice = event.data.object as Stripe.Invoice;
            const customerId = toSafeString(
              typeof invoice.customer === "string"
                ? invoice.customer
                : undefined,
            );

            const subDetails = invoice.parent?.subscription_details;
            const rawSub = subDetails?.subscription;
            const subscriptionId =
              typeof rawSub === "string" ? rawSub : rawSub?.id;

            await ctx.runMutation(internal.billing.recordInvoicePayment, {
              ownerId: canonicalOwnerId,
              ownerGeneration,
              stripeEventCreatedAt: toPeriodMs(event.created) ?? Date.now(),
              stripeCustomerId: customerId || undefined,
              stripeInvoiceId: invoice.id,
              stripePaymentIntentId: undefined,
              stripeSubscriptionId: toSafeString(subscriptionId) || undefined,
              amountPaidCents: Math.max(
                0,
                Math.floor(invoice.amount_paid ?? 0),
              ),
              currency: invoice.currency ?? "usd",
              billingReason: invoice.billing_reason ?? "unknown",
              status: invoice.status ?? "unknown",
              periodStart: toPeriodMs(invoice.period_start),
              periodEnd: toPeriodMs(invoice.period_end),
            });
            break;
          }

          default:
            break;
        }
      } catch (error) {
        console.error("[stripe-webhook] Event handling failed", {
          eventId: event.id,
          eventType: event.type,
          error,
        });

        await ctx.runMutation(internal.billing.releaseStripeEventClaim, {
          eventId: event.id,
          claimId,
          error: (error instanceof Error ? error.message : String(error)).slice(
            0,
            2_000,
          ),
          now: Date.now(),
        });

        return new Response("Webhook processing failed", { status: 500 });
      }

      const completed = await ctx.runMutation(
        internal.billing.completeStripeEvent,
        {
          eventId: event.id,
          claimId,
          processedAt: Date.now(),
        },
      );
      if (!completed) {
        return new Response("Webhook claim was superseded", {
          status: 503,
          headers: { "Retry-After": "1" },
        });
      }

      return new Response(JSON.stringify({ received: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }),
  });
};
