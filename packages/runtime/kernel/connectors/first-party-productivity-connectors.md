# First-party productivity & collaboration connectors — readiness & registration ledger

Scope: **Notion, Slack, Airtable, Asana, Linear, Jira, ClickUp, Slackbot, monday.com, Canvas LMS.**

This ledger is the narrow, human-readable contract that pairs with
`first-party-productivity-connectors.ts` after reconciliation with the backend
shared first-party execution core. It records, per
connector: the official-API adapter that already exists in
`native-oauth-provider-config.ts`, the auth model, scopes, the production env
var names its credentials must use, app-registration/review status, and the
exact blockers that keep every connector on the Composio fallback today.

## Execution policy (why nothing is routed to production yet)

- `PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS` (in
  `native-oauth-provider-config.ts`) is intentionally **empty**, so
  `isNativeOAuthLocalExecutionProductionReady(id)` is `false` for all ten
  connectors. Native OAuth _configs_ exist, but backend provider-family
  manifests/handlers and verified production rollouts remain dormant.
- Therefore `firstPartyProductivityConnectorExecutionOwner(id)` returns
  **`"composio"`** for every connector — the Composio fallback owns all reads
  and writes. There is exactly one owner at a time, so writes are never
  dual-dispatched.
- Flipping a connector to native execution is a **separate, deliberate** change
  (add the id to `PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS`) that must only
  happen after (a) the shared core lands, (b) the OAuth app + secret are
  provisioned in production Convex, and (c) a real connect + tool-call has been
  verified. Do not enable it speculatively.

## Production credential naming (architecture-consistent)

The desktop runtime resolves OAuth config via
`STELLA_NATIVE_OAUTH_<ID>_*` env keys; the confidential client secret is held by
the backend token-exchange path. Names are derived by
`firstPartyProductivityConnectorProdEnv(id)`:

- Public client id (safe): `STELLA_NATIVE_OAUTH_<ID>_CLIENT_ID`
- Confidential secret (**production Convex env only**):
  `STELLA_NATIVE_OAUTH_<SECRET_PROVIDER>_CLIENT_SECRET`
- Backend-exchange ready flag: `STELLA_NATIVE_OAUTH_<SECRET_PROVIDER>_BACKEND_READY=1`
- Hosted callback ready flag: `STELLA_NATIVE_OAUTH_<SECRET_PROVIDER>_EXTERNAL_CALLBACK_READY=1`

`<SECRET_PROVIDER>` equals the connector id except where an app is shared:
**jira → `ATLASSIAN`**. Secrets must never be committed, logged, or stored
anywhere but production Convex env.

## Per-connector status

Legend — Auth: `oauth2` (user), `oauth2_bot` (bot token), env-gated = native
config only resolves once its client id (and, for Canvas, install URL) is
present. Owner today = `composio` for all.

| Connector | Auth       | Official API           | Callback                                 | Token exchange                | Default client id in config? | Composio fallback |
| --------- | ---------- | ---------------------- | ---------------------------------------- | ----------------------------- | ---------------------------- | ----------------- |
| notion    | oauth2     | api.notion.com/v1      | hosted `stella.sh/oauth/notion/callback` | backend (`notion`)            | yes                          | NOTION            |
| slack     | oauth2     | slack.com/api          | (backend-owned)                          | Composio boundary             | n/a                          | SLACK             |
| airtable  | oauth2     | api.airtable.com/v0    | hosted `…/airtable/callback`             | backend (`airtable`)          | yes                          | AIRTABLE          |
| asana     | oauth2     | app.asana.com/api/1.0  | loopback `127.0.0.1:48743`               | backend (`asana`)             | yes                          | ASANA             |
| linear    | oauth2     | api.linear.app         | loopback `127.0.0.1:48743`               | backend (`linear`)            | yes                          | LINEAR            |
| jira      | oauth2     | api.atlassian.com      | hosted `…/atlassian/callback`            | backend (`atlassian`, shared) | yes (shared Atlassian app)   | JIRA              |
| clickup   | oauth2     | api.clickup.com/api/v2 | hosted `…/clickup/callback`              | backend (`clickup`)           | **env-gated**                | CLICKUP           |
| slackbot  | oauth2_bot | slack.com/api          | (backend-owned)                          | Composio boundary             | n/a                          | SLACKBOT          |
| monday    | oauth2     | api.monday.com/v2      | hosted `…/monday/callback`               | backend (`monday`)            | yes                          | MONDAY            |
| canvas    | oauth2     | `<install-url>/api/v1` | hosted `…/canvas/callback`               | backend (`canvas`)            | **env-gated**                | CANVAS            |

`airtable` and `linear` are confidential clients with `usesPkce: false`; their
token exchange is explicitly backend-owned so no client secret can be embedded
or used on-device. They remain disabled until the corresponding shared-core
provider manifests and production credentials are verified.

### Scopes (current adapter configuration)

- **notion** — no scopes (Notion capabilities are set on the integration, not
  via OAuth scope). Native API calls also require a `Notion-Version` request
  header, which the generic API-request tool does not inject yet; add a default
  header before enabling native execution.
- **airtable** — `data.recordComments:read/write`, `data.records:read/write`,
  `schema.bases:read/write`, `user.email:read`,
  `workspacesAndBases:read/write`, `webhook:manage`.
- **asana** — default (full) scope; Asana grants account access without granular
  scopes on the classic OAuth app.
- **linear** — `read`, `write` (comma-separated).
- **jira** (shared Atlassian 3LO app) — `offline_access`, `read:me`,
  `read:jira-user`, `read:jira-work`, `write:jira-work`, `manage:jira-project`,
  plus the Confluence scopes for the shared app. Cloud id is resolved via
  `/oauth/token/accessible-resources`.
- **clickup** — `task:read/write`, `team:read`, `space:read`, `folder:read`,
  `list:read` (ClickUp ignores granular scopes at authorize time).
- **monday** — `me:read`, `boards:read/write`, `docs:read/write`,
  `workspaces:read/write`, `users:read/write`, `account:read`,
  `notifications:write`, `updates:read/write`, `assets:read`, `tags:read`,
  `teams:read/write`, `departments:read/write`, `webhooks:read/write`.
- **canvas** — `/auth/userinfo` today; institution developer keys grant broader
  access. Per-instance `url:`-style scopes are set when the key is provisioned.
- **slack / slackbot** — served via the Composio boundary; one Slack app/grant
  covers both (user-token scopes for `slack`, bot-token scopes for `slackbot`).

## Representative reads/writes

When native execution is enabled, each OAuth-catalog connector exposes a generic
`<ID>_API_REQUEST` tool (path + method + query + JSON body) against its official
API base, so both reads and writes are reachable. **Linear** additionally
exposes `LINEAR_RUN_QUERY_OR_MUTATION` for its GraphQL API. Slack/Slackbot use
the Composio `*_RUN_ACTION` tool. These are inert until the allowlist flip above.

## App registration / review status

- **Browser access confirmed.** The external (real) browser reaches provider
  developer consoles; the `contact@fromyou.ai` Google account (Viviora Team,
  `authuser=1`) is available for "Continue with Google" logins. No password/2FA
  entry was performed. (Linear web has a desktop-deeplink + workspace-scoped
  settings friction; Notion shows a Google-login wall, not a hard block.)
- **Existing apps.** notion, airtable, asana, linear, monday already carry real
  client ids in `native-oauth-provider-config.ts`, and jira rides the shared
  Atlassian 3LO app — i.e. developer apps appear to already exist. These must be
  **recovered/verified** (owner = fromyou.ai/Viviora, Stella branding, correct
  redirect URIs) rather than re-created, to avoid breaking the client ids that
  ship today.
- **Redirect URIs to register/verify** (per connector): the hosted callbacks in
  the table above, plus the loopback `http://127.0.0.1:48743/callback` for
  asana and linear.
- **Review requirements:** Slack/Slackbot (public distribution → Slack app
  review), Canvas (per-institution developer-key approval), monday (marketplace
  listing for public availability), Notion & Jira (verification/listing
  recommended for general availability, not required to function). ClickUp,
  Airtable, Asana, Linear have no formal public-review gate for OAuth apps.

## Blockers (why registration + routing were not completed this session)

1. **Provider-family backend registrations remain disabled.** The shared core
   is present, but these providers still need fixed-origin manifests/handlers,
   production credentials, and live verification.
2. **Do-not-route + no-dual-execute guardrails.** Production routing is
   forbidden until a real connect + tool-call is verified, which depends on (1)
   and provider setup. Until then the Composio fallback remains the single
   execution owner.
3. **Live-app risk.** Several connectors' client ids are already baked into
   shipping config; mutating those apps' settings speculatively (with no way to
   verify end-to-end) risks disrupting current Composio-backed flows.

## Runbook to finish (when prod access + provider handlers are available)

For each connector, in order:

1. Recover/verify (or create, Stella-branded) the OAuth app under
   `contact@fromyou.ai` via Google login; confirm redirect URIs match the table.
2. `bun x convex env set STELLA_NATIVE_OAUTH_<ID>_CLIENT_ID <redacted>` and
   `… STELLA_NATIVE_OAUTH_<SECRET_PROVIDER>_CLIENT_SECRET <redacted>` against
   the **production** deployment (secret never leaves prod Convex).
3. Set `…_BACKEND_READY=1` and `…_EXTERNAL_CALLBACK_READY=1` for the provider.
4. For Notion, add and verify the required `Notion-Version` default header.
5. Verify a real connect + one read and one write via the native path.
6. Only then add the id to `PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS`.
7. Submit any free/public review requests that gate general availability.
