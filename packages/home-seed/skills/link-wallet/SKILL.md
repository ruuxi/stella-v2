---
name: link-wallet
description: Pay with Stripe Link through the Link CLI. Use when the user wants to buy, purchase, check out, or pay. Connect with the link_wallet tool. Create spend requests with --request-approval. Never paste card numbers into chat.
---

# Link wallet

Call `link_wallet` so Stella shows the connect card. Do not run `auth login` yourself. This is not Stella product billing and not the Stripe Connect connector.

## Connect

If Link is disconnected, call `link_wallet`. The user can also connect, disconnect, or add a card from Settings → Wallet. Add card opens https://app.link.com/wallet. If they connect with no card, Stella asks them to add one.

`--client-name` is already set when Stella logs in.

## Pay

Run the Link CLI with JSON output and Stella's auth file:

```bash
npx --yes @stripe/link-cli --format json --auth ~/.stella/wallet/link-auth.json
```

If `$STELLA_DATA_DIR` is set, use `$STELLA_DATA_DIR/wallet/link-auth.json` instead.

Create spend requests with `--request-approval`. The user approves in the Link app. Stella pings their phone. Do not approve inside Stella.

Write cards to `--output-file`. Never paste PAN or CVC into chat. Link issues a one-time card. Stella does not store it.

## Limits

- US Link accounts
- $500 max per spend
