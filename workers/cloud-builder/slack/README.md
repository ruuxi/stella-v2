# Tag Stella in Slack

A Slack app that lets people mention `@Stella` in a channel or DM her. Each
person's requests run on their own Stella account. Code: `src/slack/`.

## How it works

- **Install:** any workspace installs through `<auth>/api/slack/install`
  (OAuth v2). The bot token is stored per workspace in D1
  (`slack_installations`), AES-GCM encrypted under a key derived from
  `BETTER_AUTH_SECRET`. Nothing is hardcoded to one workspace.
- **Connect:** the first time someone mentions Stella, they get a private
  "Connect Stella" button. It opens `<auth>/api/slack/link`, where they sign
  in to Stella (Google or an email link), confirm, and their Slack user is
  linked to their Stella account (`slack_identities`). `/stella connect`,
  `/stella disconnect` and `/stella status` manage it. So does the App Home tab.
- **Conversations:** each Slack thread is its own Stella conversation, and a
  person's DM with Stella is one more. These run in the cloud on the
  requester's account, so they read the requester's memory like any new chat
  and show in their Stella apps as "Slack · #channel". A thread belongs to
  whoever started it. Their later replies in it (no mention needed) continue
  the conversation. Other people's messages there are context only.
- **Context:** messages the Events API delivers are cached briefly
  (`slack_messages`), and a request's prompt carries the thread so far from
  that cache. The rate-limited history API is read once at most, for a mention
  inside a thread Stella hasn't seen.
- **Replies:** the conversation object mirrors itself into the thread
  (`relay.ts`). That covers Stella's replies (including agent results posted
  after the request turn ended), one progress checklist per request with a
  Stop button, files her agents produce, and 👀 on the request until all its
  work is done. In shared channels the prompt asks Stella to keep the person's
  private information out of replies.

## Set up an app

1. Create a Slack app from `app-manifest.dev.json` (dev backend) or
   `app-manifest.prod.json`. If you self-host, swap the auth domain first.
2. Put its credentials on cloud-builder:
   `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` (pipe each
   into `bunx wrangler secret put NAME`, `--env production` for prod).
   `OAUTH_STATE_SECRET` must also be set.
3. Apply the D1 migration (`migrations/0009_slack.sql`) and deploy
   cloud-builder.
4. In the app's Event Subscriptions, retry verification of the request URL.
5. Install into a workspace by opening `<auth>/api/slack/install`.
   Don't use "Install to Workspace" in Slack's settings, because that skips
   storing the token.

Listing in the Slack Marketplace later only needs Slack's review. The app is
already a distributed OAuth app.
