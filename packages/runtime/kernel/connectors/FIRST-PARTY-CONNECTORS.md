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
| `0codekit`       | 0CodeKit         | API key (Bearer)                         | `0CODEKIT`                  | developer tools |
| `ably`           | Ably             | API key (Basic)                          | `ABLY`                      | developer tools |
| `abuseipdb`      | AbuseIPDB        | API key (`Key` header)                   | `ABUSEIPDB`                 | security        |
| `abstract`       | Abstract         | API key (query `api_key`)                | `ABSTRACT`                  | developer tools |
| `peopledatalabs` | People Data Labs | API key (`X-Api-Key`)                    | `PEOPLEDATALABS`            | data enrichment |
| `44api`          | 44API            | API key (Bearer)                         | `44API`                     | taxes           |

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
- Composio is the **single authoritative executor** for every action here today.
- GitHub and Supabase now have static backend OAuth manifests and fixed-origin
  server executors for their reviewed representative actions. Both manifests
  remain `unverified`, are disabled unless explicitly allowlisted, and have no
  production rollout. This is code readiness, not live-provider parity.
- The Store publisher now admits the reviewed developer/data/utility toolkits
  using the auth schemes reported by Composio. API-key toolkits remain
  Composio-managed; Stella does not ingest or custody their keys natively.
- The API-key developer/data connectors `firecrawl`, `tavily`, `exa`,
  `serpapi`, `perplexityai`, `posthog`, `ably`, and `abuseipdb` now carry
  server-side **fixed-origin request planners**
  (`connectors/executors/api_key.ts` `DEFERRED_API_KEY_PROVIDERS` /
  `buildApiKeyProviderRequest`) alongside `peopledatalabs`, and are recorded as
  their canonical `developer_data` owner in
  `first-party-connector-ownership.ts` (`planner_ready`). These planners emit
  only relative paths and static, non-secret headers; they are **not** wired
  into the executor dispatch and cannot run until the per-user API-key vault and
  placement-aware injection land, so no key is custodied and Composio stays
  authoritative. `snowflake` (account-scoped origin), `abstract` (per-product
  host), and `44api` (digit-leading `44API_*` actions) remain `metadata_only`
  pending their own origin/action-shape resolution.
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

| Connector   | Shared-core env required                                                                                                                                          | Notes                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`    | `STELLA_CONNECTOR_OAUTH_GITHUB_CLIENT_ID`, `_CLIENT_SECRETS_JSON`, `_CLIENT_SECRET_VERSION`                                                                       | Hosted OAuth callback, PKCE, fixed `api.github.com` executor. Requires provider-app registration and representative live read/write verification before allowlisting or rollout. |
| `supabase`  | `STELLA_CONNECTOR_OAUTH_SUPABASE_CLIENT_ID`, `_CLIENT_SECRETS_JSON`, `_CLIENT_SECRET_VERSION`                                                                     | Hosted Management API OAuth, PKCE, fixed `api.supabase.com` executor. Dynamic `scope` is intentionally omitted because Supabase app permissions are configured out of band.      |
| `snowflake` | Not yet defined in the shared core; future setup must include account origin, client id, versioned secret ring, and a validated account-origin allowlist strategy | Snowflake OAuth and SQL API URLs are account-scoped. Runtime metadata alone is not sufficient for safe server execution.                                                         |

### API-key connectors

API-key connectors authenticate **per user**. In the current Composio-fallback
model, the user connects their own account/key through Composio's auth flow — no
global Convex secret is required. Native activation is blocked until the shared
backend has encrypted per-user API-key custody, an authenticated connect UI,
provider-specific injection, and representative live-call verification.
Declarative `tokenKey` metadata is not credential custody. Do not pre-provision
shared or paid API keys.

## Known constraints / findings

- **44API keeps its exact toolkit compatibility**: public id `44api`, display /
  upstream prefix `44API`, and exact action prefix `44API_*`. The identifier
  guard admits that digit-leading action shape only for the `44api` connector.
- **Snowflake** OAuth is account-scoped; the native provider config is
  intentionally `null` (status `missing_oauth_app`) until an account URL env is
  set. This is correct, not a bug.
- Representative actions are a curated subset; the authoritative, current action
  set for any connector is resolved at runtime through Composio
  (`connect.actions` / `connect.schema`).
