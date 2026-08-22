# First-party connector execution core

Shared foundation that lets Stella-owned OAuth and API-key provider adapters
coexist with Composio and migrate **connector-by-connector**. Public connector
IDs, action schemas, and the Store surface are unchanged; only the backend
_executor_ moves.

This is Wave 1A (shared OAuth transactions, hosted callback, encrypted vault,
adapter/route registry, rollout controls). Provider-family adapters (Google
Workspace, Microsoft, social, SaaS) plug into the seams listed at the bottom.

## Invariants (enforced in code + tests)

- **Stable identity** — `gmail` stays `gmail`; the executor (`composio` /
  `first_party`) is an implementation detail resolved server-side per call.
- **Tokens stay server-side** — refresh/access tokens live only in
  `oauth_credentials`, encrypted with the existing versioned AES-256-GCM key
  ring (`data/secrets_crypto.ts`). API keys use the same encryption pattern in
  the owner-scoped `api_key_credentials` vault. No public/query surface returns
  ciphertext or plaintext; only backend execution actions decrypt in-process.
- **Credential-aware status** — an OAuth connector is "connected" only when a
  bound, active account's granted scopes cover every required scope group. An
  API-key connector additionally requires an active owner envelope plus both
  provider enablement and independent representative-call verification.
- **No unsafe execution** — the first-party run path never dual-executes, never
  auto-retries an ambiguous write, and never silently falls back to Composio.
  Shadow mode is read-only readiness evaluation.
- **Fail closed** — the global env kill switch defaults off; a provider is only
  usable when both present and in the emergency allowlist (the built-in `mock`
  provider is dev/test-only and self-enabling under its own flag).

## Module map

```
connectors/
  env.ts                 # secret-free env registry + kill switch/allowlist readers
  errors.ts              # provider-neutral error taxonomy + HTTP status mapping
  routing.ts             # pure route resolver + rollout modes + fallback matrix
  rollouts.ts            # connector_rollouts CRUD (admin/internal)
  audit.ts               # metadata-only connector_audit_events + purge
  execute.ts             # first-party run pipeline + single-flight refresh
  executors/first_party.ts  # fixed-origin provider dispatch + mock handler
  run.ts                 # public run action + catalog schema lookup
  oauth/
    providers.ts         # static provider manifests, scope groups, PKCE/URL builders
    client_credentials.ts# versioned client-secret ring resolution (env only)
    attempts.ts          # one-time state/PKCE connect attempts (create/consume/purge)
    vault.ts             # encrypted credential custody + refresh leasing + rotation
    accounts.ts          # accounts, scope-aware status, bindings, disconnect/revoke
    callback.ts          # hosted callback: exchange + identity + transactional commit
    token_set.ts         # pure token-set (de)serialize + scope union + refresh preserve
    connect.ts           # authenticated connect-start (mutation)
  api_keys/
    providers.ts         # reviewed fixed origins, auth placement, action schemas
    vault.ts             # encrypted owner-scoped connect/status/disconnect lifecycle
    execute.ts           # single-attempt fixed-origin execution + redaction
  hosted_connect/
    origin.ts            # SSRF-safe per-owner origin binding + fixed-path URLs
    providers.ts         # customer-hosted descriptors + token/verify gating
    vault.ts             # encrypted token + bound-origin lifecycle (1Password Connect)
    execute.ts           # single-attempt bound-origin execution + redaction
http_routes/connector_oauth.ts  # hosted GET callback + admin rollout POST
http_routes/native_oauth.ts     # Store connect/status/run + API-key lifecycle
```

## Production environment variables (names only — set in the Convex deployment)

Set in the production deployment (`benevolent-minnow-586`); never in source,
`.env.local`, build artifacts, or desktop config.

| Name                                                                    | Purpose                                                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED`                        | Global kill switch. `1`/`true` enables first-party execution. Default off.                               |
| `STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS`                              | Comma-separated emergency allowlist of provider keys. Empty = fail closed.                               |
| `STELLA_CONNECTOR_API_KEY_VERIFIED_PROVIDERS`                           | Independent allowlist for API-key providers with a completed representative-call verification.           |
| `STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS`                    | Independent allowlist for customer-hosted connect providers (1Password Connect) with a completed representative-call verification. |
| `STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL`                                | Sole origin used to build callbacks, e.g. `https://connect.stella.sh`. Until set, connect-start refuses. |
| `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_ID`                                | Provider OAuth client id. `<KEY>` = manifest key upper-cased, `-`→`_` (e.g. `GOOGLE_WORKSPACE`).         |
| `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRETS_JSON`                      | Versioned secret ring `{"1":"...","2":"..."}` for zero-downtime rotation.                                |
| `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRET_VERSION`                    | Active client-secret version. In-flight attempts record the version used.                                |
| `STELLA_CONNECTOR_AUDIT_RETENTION_DAYS`                                 | Bounded audit/metadata retention. Default 90, capped at 400.                                             |
| `STELLA_SECRETS_MASTER_KEYS_JSON` / `STELLA_SECRETS_MASTER_KEY_VERSION` | Reused envelope-encryption key ring (already required by `secrets_crypto.ts`).                           |
| `STELLA_CONNECTOR_OAUTH_ALLOW_MOCK`                                     | **Never set in production.** Registers the built-in test/dev `mock` provider.                            |

## Microsoft Entra registration (Outlook, Teams, Excel)

The provider key is `microsoft`. One delegated Entra grant backs the three
stable connector IDs `outlook`, `microsoft_teams`, and `excel`; each connector's
status is still evaluated against its own required scope group. Connecting any
member requests the reviewed union so a successful grant can bind every
scope-satisfied member of the family.

Create a **Web** app registration in the intended Entra tenant and configure the
exact hosted callback:

```text
${STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL}/api/connectors/oauth/callback
```

Configure these delegated Microsoft Graph permissions (not application
permissions):

| Family   | Delegated permissions                                                                           |
| -------- | ----------------------------------------------------------------------------------------------- |
| Identity | `User.Read`, plus OIDC `openid profile email offline_access` requested by the authorize flow    |
| Outlook  | `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`                                            |
| Teams    | `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`, `ChannelMessage.Send` |
| Excel    | `Files.ReadWrite`                                                                               |

The code uses the `common` v2.0 authority, PKCE, a versioned confidential-client
secret, and fixed `https://graph.microsoft.com` requests. The corresponding
production env names are:

```text
STELLA_CONNECTOR_OAUTH_MICROSOFT_CLIENT_ID
STELLA_CONNECTOR_OAUTH_MICROSOFT_CLIENT_SECRETS_JSON
STELLA_CONNECTOR_OAUTH_MICROSOFT_CLIENT_SECRET_VERSION
```

Use the supported Entra portal flow while signed in as `contact@fromyou.ai`.
Depending on tenant policy, an administrator may have to create the app, add or
consent to `ChannelMessage.Read.All`, or approve the complete delegated grant.
This is an external prerequisite, not a reason to enable first-party routing
without verification. Do not add `microsoft` to the production provider
allowlist, change a connector rollout away from `composio_only`, or disable its
Composio fallback until a real account has completed callback and one
representative read and write per connector have succeeded.

While an allowed Composio fallback remains, a preferred-mode connect-link can
fall back to Composio only when first-party setup fails before authorization.
Likewise, Composio remains the reported connection while a partial first-party
grant is missing connector scopes; the status response also exposes the partial
account status and missing scope groups. No provider call is dual-executed, and
an error after first-party dispatch is never retried through Composio.

Current external verification blocker: `contact@fromyou.ai` is not yet a
Microsoft identity. The supported Microsoft signup flow accepted verification
of that mailbox, then required account-profile country/region and date-of-birth
data before it would create the identity. No verified date of birth is available
to this repository workflow, so it must not be guessed. The exact unblock is to
finish that supported account-profile step with owner-confirmed data or provision
`contact@fromyou.ai` as a member in an existing work/school tenant. The resulting
account must also be allowed to register applications (tenant setting or the
Application Developer role), and a tenant administrator must grant any consent
the tenant policy requires. Until then there is no Entra client ID/secret,
callback, or representative first-party Graph call to verify.

When credentials exist, set production values only with a redacted
`convex env set --prod` flow; never place or print the secret in source, shell
history, test output, or documentation.

The publisher owns narrow compatibility schemas for reviewed actions only when
Composio's tools API omits a compilable schema. If Composio returns a valid
schema, that upstream schema remains authoritative.

The reviewed slugs are:

- Outlook: `OUTLOOK_LIST_MESSAGES`, `OUTLOOK_GET_MESSAGE`,
  `OUTLOOK_SEND_EMAIL`, `OUTLOOK_CREATE_DRAFT`, `OUTLOOK_LIST_EVENTS`,
  `OUTLOOK_CALENDAR_CREATE_EVENT`.
- Teams: `MICROSOFT_TEAMS_LIST_USER_JOINED_TEAMS`,
  `MICROSOFT_TEAMS_TEAMS_LIST_CHANNELS`,
  `MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES`,
  `MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE`.
- Excel: `EXCEL_LIST_WORKSHEETS`, `EXCEL_GET_RANGE`, `EXCEL_UPDATE_RANGE`,
  `EXCEL_LIST_TABLES`, `EXCEL_ADD_TABLE_ROW`.

## Social & media provider registration (X, YouTube, Meta, Reddit, LinkedIn)

The in-scope social/media connectors resolve through five provider manifests in
`oauth/providers.ts`. As with every family, connector IDs and action schemas are
unchanged; only the executor moves. All five deliberately remain `unverified`,
are disabled unless explicitly allowlisted, keep the default `composio_only`
rollout, and never enable first-party routing until a real account has completed
callback and one representative read has succeeded.

Every app is registered against the single hosted callback:

```text
${STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL}/api/connectors/oauth/callback
```

The intended production origin is `https://connect.stella.sh` (a Convex custom
domain), so the exact redirect URI to configure in each provider console is
`https://connect.stella.sh/api/connectors/oauth/callback`. Use the authorized
`contact@fromyou.ai` identity for every console, and branding of "Stella"
(support/contact `contact@fromyou.ai`, homepage `https://stella.sh`).

| Provider key | Connector IDs                      | Grant model                                    | Notes                                                              |
| ------------ | ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `twitter`    | `twitter`                          | Own X app (OAuth2 PKCE, confidential client)   | Display name "X". Write (`tweet.write`) needs a paid X API tier.   |
| `youtube`    | `youtube`                          | Own Google client, **separate** from Workspace | Distinct GCP project/consent; sensitive scopes need Google review. |
| `meta`       | `facebook`, `instagram`, `metaads` | **One shared Meta user grant** (`social_all`)  | Facebook/Instagram/Meta Ads bind from a single reviewed grant.     |
| `reddit`     | `reddit`                           | Own Reddit "web app"                           | Identity/read/submit need no app review.                           |
| `linkedin`   | `linkedin`                         | Own LinkedIn app (needs a Company Page)        | `w_member_social` requires a reviewed LinkedIn product.            |

`connectorBindings` wire the grant model: each Meta connector requests the
reviewed `social_all` union on connect and is evaluated against its own read
scope group, so one successful grant binds every scope-satisfied member.
Twitter, Reddit, and LinkedIn request their write superset on connect and treat
the read group as "connected"; each write action still self-gates on its own
scopes at execution time. YouTube requests its write group and needs only read
to be connected, and is a separate provider key from `google-workspace`.

Per-provider production env names (`<KEY>` = `TWITTER` / `YOUTUBE` / `META` /
`REDDIT` / `LINKEDIN`), set only via a redacted `convex env set --prod` on
`benevolent-minnow-586`, never in source, `.env.local`, or logs:

```text
STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_ID
STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRETS_JSON      # versioned ring {"1":"..."}
STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRET_VERSION
```

Shared prerequisite for going live on any of them:
`STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL` must be set (until then connect-start
refuses), plus the provider key added to
`STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS` and the global kill switch flipped on.
None of these should change until a real callback + representative read is
verified for that connector.

### External registration state (as of this wave)

- `twitter` — **credentials provisioned.** The prior wave registered the X app
  and set `STELLA_CONNECTOR_OAUTH_TWITTER_CLIENT_ID`, `_CLIENT_SECRETS_JSON`,
  and `_CLIENT_SECRET_VERSION` on `benevolent-minnow-586`. Not yet allowlisted
  or rolled out; write remains gated on the paid X API tier.
- `youtube` — **app not yet created.** The dedicated GCP project
  `stella-youtube-oauth` exists under `contact@fromyou.ai`, but it has no OAuth
  consent screen configured and no OAuth 2.0 client ID. Next step: configure the
  consent screen (branding + the two YouTube scopes) and create a Web client
  with the callback above, then store the client id/secret ring. External
  blocker for production: Google verification of the sensitive YouTube scopes
  (`youtube.readonly`, `youtube.force-ssl`).
- `meta` — **blocked at login.** `developers.facebook.com` redirects to a Meta
  login wall for this session; creating the app needs the owner's Meta login and
  2FA (must not be entered here). Downstream: Meta Business verification and app
  review for `pages_*`, `instagram_*`, and `ads_*` permissions.
- `reddit` — **app not yet created.** `reddit.com/prefs/apps` is signed in; no
  Stella OAuth app is present. A "web app" with the callback above yields a
  client id/secret with no review needed for identity/read/submit.
- `linkedin` — **app not yet created.** `linkedin.com/developers/apps` is signed
  in and shows no app ("create your first app"). Creating one needs a LinkedIn
  Company Page, and `w_member_social` requires review of the "Share on LinkedIn"
  / Community Management product.

## Developer/data/utility reconciliation

GitHub and Supabase are registered in `oauth/providers.ts` with hosted PKCE
flows, versioned client-secret custody, stable identity resolution, fixed API
origins, exact connector/action ownership, and representative read/write
executors. Their manifests deliberately remain `unverified`; they are disabled
unless explicitly included in `STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS`, and
the default rollout remains `composio_only`.

Reviewed native actions:

- GitHub: list/get/search repositories, list pull requests, search issues, and
  create an issue.
- Supabase: list/get projects, list organizations, and create a project.

The reviewed API-key execution catalog is below. `executor_ready` means the
connector has a fixed-origin descriptor, exact action schemas, a request
planner, and first-party dispatch. It does **not** mean that production routing
is active: execution still independently requires the global kill switch, the
provider in both deployment allowlists, an active owner-scoped encrypted
credential, a verified representative call, and a first-party rollout.

| Connector        | Fixed API origin                 | Credential placement                | Contract restriction                                                                                  |
| ---------------- | -------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `firecrawl`      | `https://api.firecrawl.dev`      | `Authorization: Bearer`             | v2 reviewed actions only                                                                              |
| `exa`            | `https://api.exa.ai`             | `X-Api-Key`                         | reviewed search/content/answer actions only                                                           |
| `serpapi`        | `https://serpapi.com`            | `api_key` query parameter           | credential injected only after planning                                                               |
| `ashby`          | `https://api.ashbyhq.com`        | HTTP Basic, empty username          | reviewed candidate/job actions only                                                                   |
| `tavily`         | `https://api.tavily.com`         | `Authorization: Bearer`             | reviewed search/extract/map/crawl actions only                                                        |
| `perplexityai`   | `https://api.perplexity.ai`      | `Authorization: Bearer`             | search and chat-completions actions only                                                              |
| `posthog`        | `https://us.posthog.com`         | `Authorization: Bearer`             | US Cloud only; EU and self-hosted origins remain unsupported                                          |
| `ably`           | `https://rest.ably.io`           | HTTP Basic `keyName:keySecret` pair | pair format is validated; it is never split into request input                                        |
| `abuseipdb`      | `https://api.abuseipdb.com`      | `Key` header                        | report uses explicit form encoding; other reviewed actions use no body                                |
| `peopledatalabs` | `https://api.peopledatalabs.com` | `X-Api-Key`                         | v5 reviewed person/company actions only                                                               |
| `apollo`         | `https://api.apollo.io`          | `X-Api-Key`                         | documented `/api/v1` people/org/contact/single-task actions only                                      |
| `2chat`          | `https://api.p.2chat.io`         | `X-User-API-Key`                    | reviewed `/open` WhatsApp actions only                                                                |
| `7shifts`        | `https://api.7shifts.com`        | `Authorization: Bearer`             | long-lived access-token model; supports exact `SEVENSHIFTS_*` and existing `7SHIFTS_*` public actions |
| `abyssale`       | `https://api.abyssale.com`       | `X-API-KEY`                         | reviewed template/generation actions only                                                             |
| `0codekit`       | `https://prod.0codekit.com`      | `auth` header                       | reviewed PDF actions only                                                                             |
| `abstract`       | product-specific (below)         | `api_key` query parameter           | each public action is compile-time bound to one official origin and one encrypted credential slot     |
| `44api`          | `https://api.44api.dev`          | `X-API-Key`                         | exact public `44API_*` names are preserved and canonically mapped internally                          |
| `21risk`         | `https://21risk.com`             | `Authorization: Bearer`             | OData v5 read-only; only verified entity paths (`reports`, `organizations`)                           |

No descriptor accepts a caller-supplied origin, path authority, authentication
header, or request encoding. The only accepted authentication placements are
the enumerated placements above. The executor performs one request, follows no
redirect, redacts every credential representation, and never retries a write.

### Abstract multi-product credential contract

Abstract remains one public connector (`abstract`) and preserves its exact public
action IDs. It uses three owner-scoped encrypted credential slots; neither an
action input nor a connect request can choose an origin:

| Public action                 | Fixed API origin                          | Credential slot    |
| ----------------------------- | ----------------------------------------- | ------------------ |
| `ABSTRACT_VALIDATE_EMAIL`     | `https://emailvalidation.abstractapi.com` | `email_validation` |
| `ABSTRACT_VALIDATE_PHONE`     | `https://phonevalidation.abstractapi.com` | `phone_validation` |
| `ABSTRACT_GET_IP_GEOLOCATION` | `https://ipgeolocation.abstractapi.com`   | `ip_geolocation`   |

Connect/status responses contain only slot names, labels, connection state,
generation, and timestamps. The protected desktop main-process prompt submits a
key directly to the authenticated vault endpoint. Raw keys, encrypted envelopes,
and authentication headers never enter renderer or runtime-worker state. A
connector-level status is `incomplete` until all three slots are active, while
execution readiness is action-specific and requires only the action's compiled
slot. Disconnect physically deletes all three slot rows. Abstract remains absent
from deployment allowlists and has no rollout row; Composio/default routing stays
authoritative until each product receives a representative live verification.

### Apollo action contract

Apollo keeps the fixed `https://api.apollo.io` origin and injects the owner
credential only as `X-Api-Key`. The existing Stella public action IDs remain
unchanged; in particular, `APOLLO_PEOPLE_ENRICH` remains the public ID while it
maps to Apollo's current People Enrichment route. The reviewed mappings are:

| Public action                | Provider request                       | Placement / semantics                                                                 |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `APOLLO_PEOPLE_SEARCH`       | `POST /api/v1/mixed_people/api_search` | documented query parameters; zero-credit People API Search                            |
| `APOLLO_ORGANIZATION_SEARCH` | `POST /api/v1/mixed_companies/search`  | documented query parameters; credit-consuming organization search                     |
| `APOLLO_PEOPLE_ENRICH`       | `POST /api/v1/people/match`            | documented query parameters; identifying input required; phone reveal needs a webhook |
| `APOLLO_CREATE_CONTACT`      | `POST /api/v1/contacts`                | reviewed public contact fields in a JSON body                                         |
| `APOLLO_CREATE_TASK`         | `POST /api/v1/tasks`                   | one task for one `contact_id`; reviewed JSON body                                     |

The executor no longer uses the legacy `/v1/mixed_people/search` route or
silently changes `APOLLO_CREATE_TASK` into a bulk `contact_ids` operation at
`/v1/tasks/bulk_create`. Search and enrichment arrays are serialized to the
bracketed query names in Apollo's current OpenAPI contract. Primary references:
[People API Search](https://docs.apollo.io/reference/people-api-search),
[Organization Search](https://docs.apollo.io/reference/organization-search),
[People Enrichment](https://docs.apollo.io/reference/people-enrichment),
[Create a Contact](https://docs.apollo.io/reference/create-a-contact), and
[Create a Task](https://docs.apollo.io/reference/create-a-task). The public
parameter contract was cross-checked against the
[Apollo connector catalog](https://docs.composio.dev/toolkits/apollo). Apollo
remains code-ready but disabled and independently unverified; this reconciliation
does not add it to either deployment allowlist or select a first-party rollout.

### 21RISK action contract

21RISK is a risk & compliance / audit product (21RISK ApS). Its integration
surface is a read-only OData v4 API keyed by a per-user API key. The contract was
verified against primary evidence rather than inferred from connector names:

- **Origin (fixed):** `https://21risk.com`. `https://www.21risk.com` issues a 307
  redirect to the apex, so the executor targets the apex directly and never
  follows the redirect.
- **Base path:** `/odata/v5/<entity>` with standard OData system query options
  (`$top`/`$skip`/`$count`/`$filter`/`$select`/`$orderby`/`$expand`).
- **Auth:** `Authorization: Bearer <api-key>` (Basic `base64(user:<api-key>)` is
  also accepted). API keys are prefixed `21RISK.ND.`. This is quoted verbatim from
  the apex OData service's own 401 challenge:
  `{"message":"Invalid auth header. Please provide \"Bearer <api-key>\" ... API-key should start with 21RISK.ND.xxxx"}`.

Reviewed first-party mappings (curated subset):

| Public action                       | Provider request              | Notes                              |
| ----------------------------------- | ----------------------------- | ---------------------------------- |
| `TWENTY_ONE_RISK_GET_REPORTS`       | `GET /odata/v5/reports`       | audit reports; OData query options |
| `TWENTY_ONE_RISK_GET_ORGANIZATIONS` | `GET /odata/v5/organizations` | organizations; OData query options |

Only these two entity paths are executed first-party because their exact,
case-sensitive OData entity-set names are attested by primary evidence (the
published integration surface and the live apex service). 21RISK's entity sets
are **not** uniformly cased or pluralized (e.g. `reports` vs `auditor`), so the
executor never derives an entity path from the action label. The remaining
public-catalog actions (`GET_COMPLIANCE`, `GET_PROPERTIES`, `GET_RISK_MODELS`,
`GET_ITEMS`, `GET_ITEMS_PER_MONTH`, `GET_RISKMODEL_CATEGORIES`) stay
Composio-served; confirming their exact entity-set names requires the OData
`$metadata` document, which is auth-gated behind a valid `21RISK.ND.` key (the
service validates the key before routing, so unauthenticated enumeration is not
possible). Primary references: the live apex OData service, the
[21RISK documentation](https://21risk.com/docs), and the
[21RISK connector catalog](https://docs.composio.dev/tools/_21risk) (public
action names cross-check only). 21RISK remains code-ready but disabled and
independently unverified; this reconciliation does not add it to either
deployment allowlist or select a first-party rollout.

These connectors remain planner-only and are deliberately absent from API-key
descriptors and first-party dispatch:

| Connector   | Remaining gap                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snowflake` | The SQL API requires an account-specific origin, and the reviewed Snowflake contract has OAuth/key-pair/PAT semantics rather than a proven single static API key for this product surface. The existing relative SQL planners and strict `*.snowflakecomputing.com` origin validator are non-executable until account-origin capture and the credential model are designed. |

That Snowflake disposition follows the primary [SQL API endpoint
contract](https://docs.snowflake.com/en/developer-guide/sql-api/about-endpoints)
and [authentication
contract](https://docs.snowflake.com/en/developer-guide/sql-api/authenticating):
the statement URL is account-scoped and the accepted models are OAuth, key-pair
JWT, or PAT. None is silently treated as the single opaque API-key model used by
this lifecycle.

API keys are intentionally not modeled as OAuth tokens. There is no expiry,
refresh token, scope grant, or refresh retry. Replacement uses an optimistic
credential generation; disconnect physically deletes the encrypted envelope;
and a provider 401/403 generation-safely destroys the rejected envelope and
requires the user to reconnect. Provider execution performs one network attempt.
Read failures may tell the caller that an explicit retry is safe, while an
uncertain write returns `ambiguous_write` and is never replayed automatically.
Connect and disconnect are owner-rate-limited sensitive actions; clients do
not automatically retry either mutation.

## Customer-hosted connect profiles (1Password Connect)

`connectors/hosted_connect/` is a sibling of `api_keys/` for providers whose
HTTPS origin is **customer-hosted** and therefore supplied per owner rather than
compiled into backend code (1Password Connect). A connection profile
(`connector_hosted_profiles`) binds one owner to one provider's encrypted bearer
token **plus** the exact validated `boundOrigin` that token may ever be sent to.
The token uses the same versioned AES-256-GCM envelope as every other credential;
no public/query surface returns it. The bound origin is not secret and is
surfaced in status so the owner can see which server is bound.

Security model:

- **Origin-only binding** (`hosted_connect/origin.ts`): a candidate is accepted
  only as an absolute `https:` URL with no userinfo, path, query, or fragment.
  It is rejected if the host is a loopback / private / CGNAT / link-local /
  reserved / documentation / multicast / broadcast IP literal (v4 or v6,
  including IPv4-mapped and NAT64), an obviously internal or RFC 6761 special-use
  hostname (`localhost`, single-label names, `.local`, `.internal`, `.test`,
  `.invalid`, …), or a known public DNS-rebinding wildcard resolver
  (`nip.io` / `sslip.io` / `xip.io`). The canonical `URL.origin` is persisted.
- **No token egress outside the bound origin**: request paths are
  server-constructed from the reviewed planner catalog and combined with the
  bound origin via `assertHostedConnectRequestUrl`, which re-validates the origin
  on every call and requires the resulting URL's origin to exactly equal the
  (re-normalized) bound origin. The bearer token is placed only in
  `Authorization`; `redirect: "manual"` means a 3xx (even same-host) is treated
  as a provider failure so the token is never re-sent to a redirected location.
- **DNS-rebinding limitation (Convex/fetch constraints)**: the default Convex
  runtime exposes only global `fetch` — there is no `node:dns` and no way to pin
  the socket to a validated IP, so a hostname that resolves to a private address
  at fetch time cannot be fully prevented here. It is mitigated by rejecting
  unsafe IP literals / internal / rebinding hostnames, re-validating on every
  request, and never following redirects; the residual exposure requires an
  egress proxy or network allowlist and is an external activation requirement.
- **Same lifecycle guarantees as API keys**: one live row per owner/provider;
  replacement is an optimistic-generation overwrite of both token and origin;
  disconnect physically deletes the envelope; a provider 401/403 destroys the
  rejected envelope generation-safely; execution is one network attempt with no
  automatic retry (`ambiguous_write` for uncertain writes); connect/disconnect
  are owner-rate-limited sensitive actions; rotation re-wraps onto the active
  master key; account deletion drains `connector_hosted_profiles`.

Activation is gated exactly like the API-key providers and independently:
`STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS` (deployment enablement) **and**
`STELLA_CONNECTOR_HOSTED_CONNECT_VERIFIED_PROVIDERS` (a separate representative
live-call attestation) must both include the provider key, and a
`connector_rollouts` row must select first-party. Until then Composio stays the
default path and nothing routes natively. Remaining external requirements before
1Password is activated: deployment enablement, a representative live call against
a real customer Connect server, and (to fully close DNS rebinding) an egress
allowlist/proxy.

The Store publisher keeps Composio authoritative for planner-only and
not-enabled toolkits and publishes the auth schemes Composio reports. `44api`
is preserved as the public toolkit id, and its exact upstream `44API_*` action
slugs are accepted only for that connector.
Composio Search, Browser Tool, and Codeinterpreter remain native capability
aliases (`web`, `stella-browser`, and `exec_command`/`node_repl`) rather than
third-party connector executors.

## Rollout modes (`connector_rollouts.mode`)

Set via `POST /api/admin/connectors/rollouts` (admin secret) or
`internal.connectors.rollouts.setConnectorRollout`. Absence of a row = default
`composio_only`. Every change bumps `routeVersion` (recorded in audit).

| Mode                    | Behavior                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `composio_only`         | Current path. A first-party account may coexist but is unused.                                                                    |
| `shadow`                | Composio executes; first-party does read-only readiness comparison. Never dual-executes.                                          |
| `first_party_canary`    | Deterministic owner-hash cohort (`canaryPercent`) with a ready account runs first-party; others stay Composio.                    |
| `first_party_preferred` | First-party when a bound account has the required scopes; otherwise prompt connect (writes never silently fall back to Composio). |
| `first_party_only`      | Composio connect/run for this connector is refused; first-party is authoritative.                                                 |
| `disabled`              | Emergency refusal of both executors.                                                                                              |

The existing Composio route (`/api/native-integrations/connect-link` and
`/run`) consults the rollout and refuses once a connector reaches
`first_party_only`/`disabled`, so the two executors never run the same connector.

### Runbook

- **Migrate a connector**: register the provider app, set the client-id/secret
  envs, add the provider key to `STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS`, flip
  the kill switch on, then advance the rollout `composio_only → shadow →
first_party_canary(1/5/25%) → first_party_preferred → first_party_only`.
- **Rollback**: set the rollout back to `composio_only` (or `disabled` for an
  emergency). Rollback only changes routing — it never deletes accounts/tokens,
  downgrades schema, or removes encryption keys. The global kill switch blocks
  all first-party execution instantly.
- **Key rotation**: add a new master key version and set the active version;
  the existing 6-hour `secret encryption key rotation sweep` cron now re-wraps
  `secrets`, `oauth_credentials`, and `api_key_credentials`. Client-secret
  rotation uses the versioned JSON ring so in-flight attempts survive.

### API-key migration and rollback

The schema changes are additive. Pre-slot `api_key_credentials` rows are read as
the `default` slot and materialize that slot on their next generation-checked
replacement, so no eager credential rewrite or decrypt/re-encrypt backfill is
required. Multi-slot providers have no ambiguous legacy fallback. Existing
Composio connections remain authoritative because an absent rollout still means
`composio_only`; existing desktop-local connector tokens are never imported or
uploaded. Users explicitly submit each required key through the protected API-key
prompt when their connector is selected for first-party setup.

Migration order:

1. Deploy the additive `api_key_credentials` table and lifecycle code with the
   global first-party kill switch off and connector rollouts unchanged.
2. Confirm the master-key ring contains every version needed by existing secret
   envelopes. Do not introduce a provider credential in deployment config.
3. Verify the compiled descriptor, fixed origin, auth placement, catalog schema,
   and one representative provider read and write where supported.
4. Add the provider key to the general enabled-provider allowlist and, only
   after that verification, to the independent API-key verified allowlist.
5. Advance the individual connector rollout gradually. Readiness still requires
   an active owner credential, so no user is routed first party merely because
   an environment flag changed.

Rollback order:

1. Set affected connector rollouts to `composio_only` (or `disabled` when both
   executors must stop). The global kill switch is the immediate all-provider
   stop.
2. Remove the provider from the API-key verified allowlist and then the general
   enabled-provider allowlist. Do not rely on a missing key to trigger OAuth
   refresh or executor fallback; neither exists for this path.
3. Leave `api_key_credentials` (including its optional `credentialSlot`) and all
   referenced master-key versions in place during code rollback. A rollback
   build must retain the additive slot field in its schema even if it restores
   the older executor. The older executor has no Abstract descriptor and will
   not consume those rows. Do not remove a master-key version until the rotation
   sweep reports no envelopes using it.
4. If credentials must be destroyed rather than preserved for a later retry,
   use the authenticated disconnect flow per owner (account deletion also drains
   the table). Only remove the table in a later, separately reviewed migration
   after it is empty.

## Data lifecycle

- Owner deletion drains `oauth_connect_attempts`, `oauth_provider_accounts`,
  `oauth_credentials`, `api_key_credentials`, `connector_account_bindings`, and
  `connector_audit_events` (`account_deletion.ts`). `connector_rollouts` is
  global config and intentionally not owner-scoped.
- API-key disconnect drains every owner/provider slot. The encryption-key rotation
  sweep re-wraps each slot independently without changing its slot identity or
  generation.
- Crons: `purge expired connector oauth attempts` (hourly),
  `purge expired connector audit events` (daily).

## Integration points for provider-family adapters

A new provider family (e.g. Google Workspace) implements, without touching the
core:

1. **Manifest** in `oauth/providers.ts` — endpoints, scope groups, PKCE/offline
   semantics, identity mode, `apiOrigin`, `callbackPath`, `verificationStatus`.
   `validateManifest` runs in the test suite. For OIDC providers, add signed
   `id_token` verification (issuer/aud/nonce) in `callback.ts` identity
   resolution (the core currently uses the userinfo endpoint).
2. **Execute handler + operation map** in `executors/first_party.ts` —
   `PROVIDER_HANDLERS[key]` builds fixed-origin requests via `providerFetchJson`;
   `PROVIDER_ACTION_OPERATIONS[key]` declares each action's operation class
   (server-authoritative; decides read-only fallback eligibility).
3. **Canonical actions + scope-group references** published into
   `integration_actions` (shared with Composio) so `run.ts` can resolve and
   validate input schemas.
4. **Env** — client id/secret-ring/version + add the key to the enabled
   allowlist.
5. **Verification/registration** — freeze the action→scope matrix from the
   shipped handler map before provider-console registration; keep the source
   scope registry, consent copy, and verification submission generated from one
   manifest version.

The `mock` provider (`oauth/providers.ts` + `executors/first_party.ts`) is a
complete, minimal reference for all of the above and is exercised end-to-end in
`connectors_core.convex.test.ts`.
