---
name: stripe-shared-live-account
description: "Stripe account \"FromYou, LLC\" is live, shared with bluemetal.ai and Stella prod; dev uses it with its own live webhook (no users)"
metadata:
  type: project
---

Found 2026-10-01: the Stripe CLI (~/.local/bin/stripe, logged in by the user) is authorized for **live mode only** on acct_1RgxEiGxJob0lqtd ("FromYou, LLC"). That account also sends webhooks to api.bluemetal.ai, cloud.stella.sh (Stella prod) and two Convex deployments, and holds live Stella Go $5 / Pro $15 prices. Dev cloud-builder's STRIPE_SECRET_KEY is that live key.

The user said dev may use live Stripe (no users). On 2026-10-01 the live webhook we_1ULz5EGxJob0lqtdxqfXfKaw → https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev/api/stripe/webhook (11 billing events) was created and its secret piped into dev's STRIPE_WEBHOOK_SECRET; a resent event returned 200.

**How to apply:** verify dev billing with `stripe events resend <evt> --live --webhook-endpoint we_1ULz5EGxJob0lqtdxqfXfKaw` plus a worker tail. Never touch the other endpoints or production config. Revisit once real users exist.
