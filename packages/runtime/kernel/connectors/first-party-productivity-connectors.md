# First-party productivity & collaboration connectors — readiness & registration ledger

Scope: **Notion, Slack, Airtable, Asana, Linear, Jira, ClickUp, Slackbot, monday.com, Canvas LMS, and 7shifts.**

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
  `isNativeOAuthLocalExecutionProductionReady(id)` is `false` for all eleven
  connectors. Native OAuth _configs_ and disabled backend provider-family
  manifests/handlers exist, but verified production rollouts remain dormant.
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

The desktop runtime still describes OAuth apps via
`STELLA_NATIVE_OAUTH_<ID>_*` env keys; the confidential client secret is held by
the backend token-exchange path. Runtime names are derived by
`firstPartyProductivityConnectorProdEnv(id)`. The shared backend core uses its
own versioned credential ring:

- Public client id (safe): `STELLA_NATIVE_OAUTH_<ID>_CLIENT_ID`
- Backend client id: `STELLA_CONNECTOR_OAUTH_<PROVIDER>_CLIENT_ID`
- Versioned secret ring (**production Convex env only**):
  `STELLA_CONNECTOR_OAUTH_<PROVIDER>_CLIENT_SECRETS_JSON`
- Active secret version: `STELLA_CONNECTOR_OAUTH_<PROVIDER>_CLIENT_SECRET_VERSION`
- Public callback origin: `STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL`
- Emergency provider allowlist: `STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS`

`<SECRET_PROVIDER>` equals the connector id except where an app is shared:
**jira → `ATLASSIAN`**. Secrets must never be committed, logged, or stored
anywhere but production Convex env.

## Per-connector status

Legend — Auth: `oauth2` (user), `oauth2_bot` (bot token), env-gated = native
config only resolves once its client id (and, for Canvas, install URL) is
present. Owner today = `composio` for all.

| Connector | Auth       | Official API           | Callback                | Token exchange                | Default client id in config? | Composio fallback |
| --------- | ---------- | ---------------------- | ----------------------- | ----------------------------- | ---------------------------- | ----------------- |
| notion    | oauth2     | api.notion.com/v1      | shared backend callback | backend (`notion`)            | yes                          | NOTION            |
| slack     | oauth2     | slack.com/api          | shared backend callback | backend (`slack`, shared)     | n/a                          | SLACK             |
| airtable  | oauth2     | api.airtable.com/v0    | shared backend callback | backend (`airtable`)          | yes                          | AIRTABLE          |
| asana     | oauth2     | app.asana.com/api/1.0  | shared backend callback | backend (`asana`)             | yes                          | ASANA             |
| linear    | oauth2     | api.linear.app         | shared backend callback | backend (`linear`)            | yes                          | LINEAR            |
| jira      | oauth2     | api.atlassian.com      | shared backend callback | backend (`atlassian`, shared) | yes (shared Atlassian app)   | JIRA              |
| clickup   | oauth2     | api.clickup.com/api/v2 | shared backend callback | backend (`clickup`)           | **env-gated**                | CLICKUP           |
| slackbot  | oauth2_bot | slack.com/api          | shared backend callback | backend (`slack`, shared)     | n/a                          | SLACKBOT          |
| monday    | oauth2     | api.monday.com/v2      | shared backend callback | backend (`monday`)            | yes                          | MONDAY            |
| canvas    | oauth2     | `<install-url>/api/v1` | shared backend callback | backend (`canvas`)            | **env-gated**                | CANVAS            |
| 7shifts   | api_key    | api.7shifts.com/v2     | n/a                     | approved partner API token    | n/a                          | 7SHIFTS           |

The shared callback is
`<STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL>/api/connectors/oauth/callback`.
`airtable` currently combines PKCE with server-side confidential-client
authentication; `linear` uses server-side confidential-client authentication
without PKCE. Both remain disabled until those settings are checked against the
recovered provider registrations and production credentials.

### Scopes (runtime configuration; backend manifests are action-narrowed)

- **notion** — no scopes (Notion capabilities are set on the integration, not
  via OAuth scope). The narrow native planners inject the required
  `Notion-Version` request header.
- **airtable** — `data.recordComments:read/write`, `data.records:read/write`,
  `schema.bases:read/write`, `user.email:read`,
  `workspacesAndBases:read/write`, `webhook:manage`.
- **asana** — default (full) scope; Asana grants account access without granular
  scopes on the classic OAuth app.
- **linear** — `read`, `write` (comma-separated).
- **jira** (shared Atlassian 3LO app) — `offline_access`, `read:me`,
  `read:jira-user`, `read:jira-work`, `write:jira-work`, `manage:jira-project`,
  plus the Confluence scopes for the shared app. Before activation, add an
  account-owned cloud-id selection resolved via
  `/oauth/token/accessible-resources`; the request planner currently requires
  that server-owned routing value.
- **clickup** — `task:read/write`, `team:read`, `space:read`, `folder:read`,
  `list:read` (ClickUp ignores granular scopes at authorize time).
- **monday** — `me:read`, `boards:read/write`, `docs:read/write`,
  `workspaces:read/write`, `users:read/write`, `account:read`,
  `notifications:write`, `updates:read/write`, `assets:read`, `tags:read`,
  `teams:read/write`, `departments:read/write`, `webhooks:read/write`.
- **canvas** — `/api/v1/users/self/profile` supplies identity; institution
  developer keys grant broader access. Per-instance `url:`-style scopes are set
  when the key is provisioned.
- **slack / slackbot** — served via the Composio boundary; one Slack app/grant
  covers both (user-token scopes for `slack`, bot-token scopes for `slackbot`).
- **7shifts** — approved partner token; no OAuth scopes. Requests require a
  fixed API-version header and explicit company identifiers.

## Representative reads/writes

The server action catalog intentionally exposes only one canonical read and one
canonical write per connector. It uses exact Composio slugs, classifies the
operation server-side, validates the stored action schema before dispatch, and
then builds a provider-specific request against a fixed manifest origin. It does
not accept arbitrary URLs or authorization headers. The authoritative names are
exported as `FIRST_PARTY_PRODUCTIVITY_ACTIONS` in the runtime and
`PRODUCTIVITY_PROVIDER_CONNECTOR_ACTIONS` in the backend.

## App registration / review status

- **No production activation evidence was available.** Existing runtime client
  ids are not proof that the apps, callbacks, secrets, grants, or API calls are
  production-ready. No provider account or deployment was changed.
- Existing Notion, Airtable, Asana, Linear, monday, and Atlassian registrations
  must be recovered and verified rather than re-created speculatively, to avoid
  disrupting currently shipping Composio-backed flows.
- **Redirect URI to register/verify:** the shared backend callback described
  above. Historical desktop loopback/provider-specific callbacks are not the
  shared core's redirect URI.
- **Review requirements:** Slack/Slackbot (public distribution → Slack app
  review), Canvas (per-institution developer-key approval), monday (marketplace
  listing for public availability), Notion & Jira (verification/listing
  recommended for general availability, not required to function). ClickUp,
  Airtable, Asana, Linear have no formal public-review gate for OAuth apps.

## Blockers (why registration + routing were not completed this session)

1. **Provider-family backend registrations remain disabled.** Fixed-origin
   manifests and narrow handlers are registered in code with `unverified`
   status, but the environment allowlist stays closed and no rollout was added.
2. **Do-not-route + no-dual-execute guardrails.** Production routing is
   forbidden until a real connect + tool-call is verified, which depends on (1)
   and provider setup. Until then the Composio fallback remains the single
   execution owner.
3. **Live-app risk.** Several connectors' client ids are already baked into
   shipping config; mutating those apps' settings speculatively (with no way to
   verify end-to-end) risks disrupting current Composio-backed flows.
4. **Provider-specific execution gaps.** Slack still needs explicit user-token
   versus bot-token extraction, Jira needs account-owned cloud selection, and
   Canvas needs a tenant-bound backend origin instead of the placeholder
   `canvas.instructure.com` manifest before any native route can be enabled.

## Runbook to finish (when prod access + provider handlers are available)

For each connector, in order:

1. Recover and verify the existing Stella-branded OAuth app; confirm redirect
   URIs match the table without creating a duplicate registration.
2. Provision the backend versioned credential-ring variables listed above in
   the **production** deployment (secret never leaves prod Convex).
3. Add the provider to the emergency allowlist only for controlled validation.
4. Verify provider-specific requirements, including Notion's version header,
   Slack user-vs-bot token semantics, and Canvas's tenant origin.
5. Verify a real connect + one read and one write via the native path.
6. Only then add the id to `PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS`.
7. Submit any free/public review requests that gate general availability.

## Registration audit — 2026-08-22

The consolidated implementation contains disabled catalogs, OAuth configuration,
provider-family executors, and adapters for all 17 connectors in this family.
No family provider is production-routed: Composio remains the sole execution
owner, and no connector may be enabled before its own real connect and
representative-call evidence passes.

Provider-console registration is currently blocked on an authorized
`contact@fromyou.ai` browser session. The available personal Google session must
not be used to create company-owned provider applications. Resume the runbook
above after Rahul completes the required sign-in or 2FA. This shared gate applies
to Notion, Slack, Airtable, HubSpot, Gong, Asana, Ashby, Pipedrive, Linear,
Salesforce, Jira/Atlassian, ClickUp, Slackbot, monday, Canvas, Attio, and 7shifts;
provider-specific payment, tenant-admin, or review gates are evaluated only
after authorized account access exists.
