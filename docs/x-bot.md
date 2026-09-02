# Stella AI X reply bot

When someone replies to a post on X and tags `@stelladotsh`, the bot posts a
reply under the summon explaining how Stella would handle the task in the
original post, with a 16:9 image attached. The image carries the address
`stella.sh/x/<handle>`; the text reply never contains a URL or domain,
because X treats auto-linked domains as link posts.

## Flow

1. `POST /api/x/bot/webhook` (`convex/http_routes/x_bot.ts`) verifies the
   X signature, parses the mention (modern Activity events and legacy
   Account Activity payloads), dedups by event id, rate limits per caller,
   and schedules `internal.x_bot.processMention`.
2. `convex/x_bot.ts` (Node action) fetches the parent post, asks the model
   for a structured plan (`reply`, `headline`, `exchanges`), renders the card
   with Satori and resvg, uploads it with the v2 chunked media endpoints,
   posts the reply with `media_ids`, stores the PNG in Convex storage, and
   records the run in `x_bot_runs`.
3. `GET /api/x/bot/page/<handle>` serves the runs for a handle as JSON. The
   website renders them at `stella.sh/x/<handle>`
   (`packages/website/src/app/x/[handle]`), `noindex`.

If rendering or uploading the image fails, the text reply still goes out and
the failure is logged as `x_bot_card_failed`.

## Who the page is addressed to

The summoner opted in by tagging the bot, so the page defaults to their
handle. When the summoner is one of our own promoter accounts
(`X_BOT_PROMOTER_USERNAMES`), the page is addressed to the original poster
instead.

## Card

`convex/lib/x_bot_card.ts` builds the element tree: the site's Open Graph
aura on the right with the homepage mini chat window on top of it, and the
headline, a one-line pitch, and the address on the left. Satori only speaks
a flexbox subset, so every container declares `display: flex`, and the
template avoids `box-shadow` and `filter`, which resvg rasterizes as blurs
that cost seconds at 1600×900. Fonts and the resvg WASM come from npm
packages listed under `node.externalPackages` in `packages/backend/convex.json`
and are read from `node_modules` at runtime.

## Environment variables (Convex deployment)

| Name | Purpose |
| --- | --- |
| `X_BOT_API_KEY`, `X_BOT_API_SECRET` | X app consumer key and secret. The secret also verifies webhook signatures and answers CRC. |
| `X_BOT_ACCESS_TOKEN`, `X_BOT_ACCESS_TOKEN_SECRET` | OAuth 1.0a user tokens for the bot account. |
| `X_BOT_USERNAME` | Bot handle without `@`. Defaults to `stelladotsh`. |
| `X_BOT_USER_ID` | Bot user id, used to ignore the bot's own posts. Optional. |
| `X_BOT_PROMOTER_USERNAMES` | Comma-separated handles whose summons address the page to the original poster, e.g. `1_missthesun`. |
| `X_BOT_MODEL` | Model for the reply plan. Defaults to `gpt-5.4-mini`. |
| `OPENAI_API_KEY` | Used for the reply plan. |

The website needs `NEXT_PUBLIC_CONVEX_URL` (or `NEXT_PUBLIC_CONVEX_SITE_URL`)
to reach the page JSON.

## Not built yet

- Sandbox tier: run a slice of the task for real and post a follow-up reply
  with the results (up to four photos, or one GIF or video).
- GPU Windows tier for tasks that need a desktop with a graphics card.
