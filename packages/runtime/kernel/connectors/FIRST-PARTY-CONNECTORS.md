# First-party developer-data & GitHub connectors

This document describes the first-party connector **adapter layer** added in
`packages/runtime/kernel/connectors/first-party-connectors.ts` and the
operational steps (OAuth-app registration, credential/env provisioning) needed
to move each connector from _Composio-backed fallback_ to the server-authoritative
shared first-party execution core.

## What shipped (code)

A declarative registry of adapters for the connectors Stella owns:

| id               | Name             | Auth                                     | Composio toolkit (fallback) | Category        |
| ---------------- | ---------------- | ---------------------------------------- | --------------------------- | --------------- |
| `github`         | GitHub           | OAuth (hosted web callback)              | `GITHUB`                    | developer tools |
| `supabase`       | Supabase         | OAuth (Mgmt API, backend exchange)       | `SUPABASE`                  | developer tools |
| `snowflake`      | Snowflake        | OAuth (account-scoped, backend exchange) | `SNOWFLAKE`                 | data warehouse  |
| `firecrawl`      | Firecrawl        | API key (Bearer)                         | `FIRECRAWL`                 | web scraping    |
| `tavily`         | Tavily           | API key (Bearer)                         | `TAVILY`                    | web search      |
| `exa`            | Exa              | API key (`x-api-key`)                    | `EXA`                       | web search      |
| `serpapi`        | SerpAPI          | API key (query `api_key`)                | `SERPAPI`                   | web search      |
| `perplexityai`   | Perplexity AI    | API key (Bearer)                         | `PERPLEXITYAI`              | AI              |
| `posthog`        | PostHog          | API key (Bearer, personal key)           | `POSTHOG`                   | analytics       |
| `0codekit`       | 0CodeKit         | API key (`auth` header)                  | `0CODEKIT`                  | developer tools |
| `ably`           | Ably             | API key (Basic)                          | `ABLY`                      | developer tools |
| `abuseipdb`      | AbuseIPDB        | API key (`Key` header)                   | `ABUSEIPDB`                 | security        |
| `abstract`       | Abstract         | API key (query `api_key`)                | `ABSTRACT`                  | developer tools |
| `peopledatalabs` | People Data Labs | API key (`X-Api-Key`)                    | `PEOPLEDATALABS`            | data enrichment |
| `44api`          | 44API            | API key (`X-API-Key`)                    | `44API`                     | taxes           |

Each adapter carries: a **stable id** (equal to the lowercased Composio toolkit
slug), the **auth model**, **required scopes / credential field**, a curated set
of **representative actions** (real Composio action slugs), and the
**authoritative Composio fallback toolkit**.

`firstPartyConnectorStatus()` returns a credential/scope-aware status:
`ready` / `missing_credential` / `missing_scopes` / `missing_oauth_app`.

### Composio-owned tools → native capabilities (aliases, not connectors)

Composio Search, Browser Tool, and Codeinterpreter are **not** wrapped as
third-party connectors. They are mapped to Stella's own native capabilities and
marked `aliased_deprecated` in `NATIVE_CAPABILITY_ALIASES`:

| Composio tool   | slug              | Native capability  | Native tool                    |
| --------------- | ----------------- | ------------------ | ------------------------------ |
| Composio Search | `COMPOSIO_SEARCH` | web search         | `web`                          |
| Browser Tool    | `BROWSER_TOOL`    | browser automation | `stella-browser`               |
| Codeinterpreter | `CODEINTERPRETER` | shell / sandbox    | `exec_command` (+ `node_repl`) |

Rationale: parity via native tools is defensible and avoids emulating
proprietary Composio APIs. Prefer the native tool in all cases.

## Execution boundaries (shared-core reconciliation)

- The shared core has landed in the backend. These runtime descriptors do not
  load credentials or issue provider requests; server-side provider manifests
  and fixed-origin handlers are required before migration.
- Composio remains the default authoritative executor. A first-party API-key
  executor is selected only by the shared rollout resolver after all readiness
  gates pass; requests are never dual-executed.
- GitHub and Supabase now have static backend OAuth manifests and fixed-origin
  server executors for their reviewed representative actions. Both manifests
  remain `unverified`, are disabled unless explicitly allowlisted, and have no
  production rollout. This is code readiness, not live-provider parity.
- The API-key lifecycle now has encrypted owner-scoped custody, authenticated
  connect/status/disconnect, exact schemas, fixed-origin dispatch, and
  placement-aware credential injection for `firecrawl`, `tavily`, `exa`,
  `serpapi`, `perplexityai`, `posthog` (US Cloud), `ably`, `abuseipdb`,
  `peopledatalabs`, `44api`, `7shifts`, `abyssale`, `0codekit`, `2chat`,
  `abstract`, `apollo`, `ashby`, and `21risk`. Abstract binds each action to an
  official product origin and a matching encrypted product credential slot.
  These are `executor_ready`, not activated: every call
  still needs independent deployment enablement, representative-call
  verification, an active encrypted owner credential, and rollout selection.
- `1password` and `snowflake` remain `planner_ready` and
  Composio-owned. Their remaining blockers are documented in the backend
  connector README; no descriptor or readiness claim fakes an executable
  credential model.
- `21risk` is `executor_ready` on a **verified fixed-origin** contract: origin
  `https://21risk.com` (`www` 307-redirects to the apex), `/odata/v5/<entity>`
  reads, and `Authorization: Bearer <api-key>` (keys prefixed `21RISK.ND.`, per
  the apex OData service's own 401 challenge). The first-party executor is a
  curated subset limited to the entity paths verified against the published
  integration surface (`reports`, `organizations`); the remaining OData entities
  (compliance, properties, risk models, items, …) stay Composio-served until the
  auth-gated `$metadata` entity model is confirmed. It is not activated:
  execution still requires deployment enablement, an active encrypted owner
  credential, and rollout selection.
- The planner catalog retains these safety boundaries:
  - **Snowflake account-scoped origin** — `requiresTenantOrigin` plus a
    `tenantOriginSuffix` (`.snowflakecomputing.com`) bound only through
    `resolveDeferredTenantOrigin`, which enforces https, an origin-only URL, and
    a real subdomain of the official suffix and rejects any arbitrary host, the
    bare suffix, look-alikes, downgrades, and credentialed URLs. This closes
    origin confusion only; it does not establish Snowflake's credential model.
  - **Abstract per-product host** — an explicit action→official-host map
    (`fixedApiOriginByAction`, all under `*.abstractapi.com`), resolved by
    `resolveDeferredActionOrigin`; no single or model-chosen base URL.
  - **44API digit-leading actions** — the exact public/upstream `44API_*` slugs
    are preserved; the deferred planner's established `FORTYFOUR_API_*` aliases
    are canonicalized inside the descriptor-backed executor. The public
    contract is unchanged.
- `FIRST_PARTY_LOCAL_EXECUTION_ENABLED` is **empty by design** — the deliberate
  switch that would let a future native dispatcher run. It mirrors the equally
  empty `PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS` in
  `native-oauth-provider-config.ts`.
- This guarantees **no mutation is ever dual-executed** (native path + Composio).
- `firstPartyConnectorCatalogOverlay()` produces `backend-composio` catalog
  entries via the existing `serverCatalog` override seam. It is **not
  auto-applied**: production routing stays with the authoritative Store catalog
  until real actions have been verified.

## Credential / env provisioning (operational handoff)

Credentials must never be committed. The server-authoritative shared core uses
the `STELLA_CONNECTOR_OAUTH_<KEY>_*` secret-ring variables documented in
`packages/backend/convex/connectors/README.md`. The older
`STELLA_NATIVE_OAUTH_<ID>_*` runtime metadata remains disabled and does not make
a connector production-ready.

### OAuth connectors

| Connector   | Shared-core env required                                                                                                                                                                                                                                        | Notes                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`    | `STELLA_CONNECTOR_OAUTH_GITHUB_CLIENT_ID`, `_CLIENT_SECRETS_JSON`, `_CLIENT_SECRET_VERSION`                                                                                                                                                                     | Hosted OAuth callback, PKCE, fixed `api.github.com` executor. Requires provider-app registration and representative live read/write verification before allowlisting or rollout.                                 |
| `supabase`  | `STELLA_CONNECTOR_OAUTH_SUPABASE_CLIENT_ID`, `_CLIENT_SECRETS_JSON`, `_CLIENT_SECRET_VERSION`                                                                                                                                                                   | Hosted Management API OAuth, PKCE, fixed `api.supabase.com` executor. Dynamic `scope` is intentionally omitted because Supabase app permissions are configured out of band.                                      |
| `snowflake` | Not yet provisioned in the shared core; setup must supply the account origin, client id, and versioned secret ring. The planner exists; the account origin is bound only via `resolveDeferredTenantOrigin` under the `.snowflakecomputing.com` suffix allowlist | Snowflake OAuth and SQL API URLs are account-scoped. The narrow suffix binding closes the code blocker; the tenant account origin and OAuth app remain an external per-connection requirement before activation. |

### API-key connectors

API-key connectors authenticate **per user**; no global provider credential is
required. The authenticated first-party prompt stores the credential in the
owner-scoped encrypted Convex vault and returns metadata only. The executor
injects it after relative-path planning into an enumerated header, query, Bearer,
or Basic location and makes one non-redirecting request. Activation remains
blocked until a provider is in both deployment allowlists and a representative
call has been verified. Do not pre-provision shared or paid API keys.

## Known constraints / findings

- **Apollo uses the current documented API v1 routes**: the stable public
  actions map to `POST /api/v1/mixed_people/api_search`,
  `/api/v1/mixed_companies/search`, `/api/v1/people/match`,
  `/api/v1/contacts`, and `/api/v1/tasks`. Search/enrichment filters use
  Apollo's documented query parameter names; contact/task writes use reviewed
  JSON bodies. `APOLLO_CREATE_TASK` retains its public ID but means one task for
  one `contact_id`, matching the public connector contract; it is not redirected
  to the legacy bulk route. `APOLLO_PEOPLE_ENRICH` likewise retains its stable
  Stella ID while mapping to the current People Enrichment endpoint. Exact
  mappings and primary documentation links are in the backend connector README.
  Apollo remains disabled and independently unverified.
- **44API keeps its exact toolkit compatibility**: public id `44api`, display /
  upstream prefix `44API`, and exact action prefix `44API_*`. The identifier
  guard admits that digit-leading action shape only for the `44api` connector,
  and only the deferred planner uses the `FORTYFOUR_API_*` aliases
  (`canonicalizeDeferredActionName`). The public contract is not renamed.
  Official origin `https://api.44api.dev`, credential header `X-API-Key`.
- **7shifts keeps both reviewed catalogs**: the API-key descriptor owns the
  `SEVENSHIFTS_*` access-token actions and the existing exact `7SHIFTS_*`
  public actions. The digit-leading guard admits `7SHIFTS_*` only for connector
  id `7shifts`; other connectors fail closed.
- **Snowflake** OAuth is account-scoped; the native provider config is
  intentionally `null` (status `missing_oauth_app`) until an account URL env is
  set. This is correct, not a bug. The deferred planner never accepts an
  arbitrary origin — `resolveDeferredTenantOrigin` binds only real subdomains of
  `.snowflakecomputing.com`.
- Representative actions are a curated subset; the authoritative, current action
  set for any connector is resolved at runtime through Composio
  (`connect.actions` / `connect.schema`).
