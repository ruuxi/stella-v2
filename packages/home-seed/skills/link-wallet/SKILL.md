---
name: link-wallet
description: Pay with Stripe Link through the Link CLI. Use when the user wants to buy, purchase, check out, or pay — connect via Stella's link_wallet tool, create spend requests with --request-approval, and never paste card numbers into chat.
---

# Link wallet

Stella owns Link login UX. This is not Stella product billing and not the Stripe Connect connector.

## Connect

If Link is disconnected, call the `link_wallet` tool so the user sees the connect card. Do **not** run `auth login` yourself.

The user can also connect or disconnect from Settings → Wallet, and add another card there (opens https://app.link.com/wallet).

`--client-name` is already set when Stella logs in.

## Pay

Use the Link CLI with JSON output and Stella's auth file:

```bash
npx --yes @stripe/link-cli --format json --auth ~/.stella/wallet/link-auth.json
```

If `$STELLA_DATA_DIR` is set, use `$STELLA_DATA_DIR/wallet/link-auth.json` instead.

Create spend requests with `--request-approval`. The user approves in the Link app. Stella also pings their phone. Do not try to approve inside Stella.

Retrieve cards with `--output-file` and **never paste PAN/CVC into chat**. Ephemeral one-time cards are Link's problem — Stella never stores them.

## Limits

- US Link accounts
- Max $500 per spend
