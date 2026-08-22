# First-party developer-data & GitHub connectors

This document describes the first-party connector **adapter layer** added in
`packages/runtime/kernel/connectors/first-party-connectors.ts` and the
operational steps (OAuth-app registration, credential/env provisioning) needed
to move each connector from _Composio-backed fallback_ to the server-authoritative
shared first-party execution core.

## What shipped (code)

A declarative registry of adapters for the connectors Stella owns:

| id                 | Name             | Auth                                     | Composio toolkit (fallback) | Category        |
| ------------------ | ---------------- | ---------------------------------------- | --------------------------- | --------------- |
| `github`           | GitHub           | OAuth (device flow)                      | `GITHUB`                    | developer tools |
| `supabase`         | Supabase         | OAuth (Mgmt API, backend exchange)       | `SUPABASE`                  | developer tools |
| `snowflake`        | Snowflake        | OAuth (account-scoped, backend exchange) | `SNOWFLAKE`                 | data warehouse  |
| `firecrawl`        | Firecrawl        | API key (Bearer)                         | `FIRECRAWL`                 | web scraping    |
| `tavily`           | Tavily           | API key (Bearer)                         | `TAVILY`                    | web search      |
| `exa`              | Exa              | API key (`x-api-key`)                    | `EXA`                       | web search      |
| `serpapi`          | SerpAPI          | API key (query `api_key`)                | `SERPAPI`                   | web search      |
| `perplexityai`     | Perplexity AI    | API key (Bearer)                         | `PERPLEXITYAI`              | AI              |
| `posthog`          | PostHog          | API key (Bearer, personal key)           | `POSTHOG`                   | analytics       |
| `ably`             | Ably             | API key (Basic)                          | `ABLY`                      | developer tools |
| `abuseipdb`        | AbuseIPDB        | API key (`Key` header)                   | `ABUSEIPDB`                 | security        |
| `abstract`         | Abstract         | API key (query `api_key`)                | `ABSTRACT`                  | developer tools |
| `people_data_labs` | People Data Labs | API key (`X-Api-Key`)                    | `PEOPLE_DATA_LABS`          | data enrichment |
| `44api`            | 44API            | API key (Bearer)                         | `44API`                     | taxes           |

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

Credentials must never be committed. They belong in **prod Convex env** under
the architecture-consistent names below. The runtime already reads these via
`applyEnvOverrides()` (`envKey(id, SUFFIX)` →
`STELLA_NATIVE_OAUTH_<ID>_<SUFFIX>`).

### OAuth connectors

| Connector   | Ships client id?                          | Convex env to set                                                                                             | Notes                                                                                                                                                                                             |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`    | Yes (`Ov23liHtoBx5A9dr9ZVE`, device flow) | none required for device flow                                                                                 | Public client id; device flow needs no secret. Native activation still requires a server handler and representative-call verification.                                                            |
| `supabase`  | Yes (`560813d3-…`)                        | `STELLA_NATIVE_OAUTH_SUPABASE_CLIENT_ID` (override), backend client-secret for the `supabase` token exchange  | Uses backend token exchange (`tokenExchange: backend`). Register the Stella OAuth app in the Supabase dashboard, then store the secret in the backend provider config.                            |
| `snowflake` | No (account-scoped)                       | `STELLA_NATIVE_OAUTH_SNOWFLAKE_ACCOUNT_URL` (or `_HOST`/`_RESOURCE_URL`), `_CLIENT_ID`, backend client-secret | The provider config returns `null` until an account URL is provided, so status is correctly `missing_oauth_app` until then. Snowflake OAuth is per-account; there is no single global Stella app. |

Per-provider env suffixes supported by `applyEnvOverrides`: `CLIENT_ID`,
`SCOPES`, `RESOURCE_URL`, `TOKEN_URL`/`TOKEN_ENDPOINT`, `AUTHORIZATION_URL`,
`CALLBACK_URL`, `CALLBACK_ID`, `CALLBACK_MODE`, `TOKEN_EXCHANGE`,
`TOKEN_EXCHANGE_PROVIDER`, `USES_PKCE`, `TOKEN_AUTH`, etc.

### API-key connectors

API-key connectors authenticate **per user**. In the current Composio-fallback
model, the user connects their own account/key through Composio's auth flow — no
global Convex secret is required. If/when native execution is enabled, the key
is stored per-connection under the adapter's `tokenKey`
(`native-apikey:<id>`) via the connector credential dialog; no global secret is
introduced. **Do not** pre-provision shared paid API keys (per task constraints:
no paid plans).

### Account / app registration (contact@fromyou.ai)

Where a Stella-owned OAuth app or account is needed, use the
`contact@fromyou.ai` Google identity (browser `authuser=1`, "Viviora Team") via
the Google account chooser. Never enter passwords or complete 2FA manually.

Registration status is tracked as blockers in the task report; GitHub (device
flow) and Supabase already carry shipped client ids.

## Known constraints / findings

- **44API keeps its public toolkit id** (`44api` / `44API`) while first-party
  action names use the safe `FORTYFOUR_API_*` prefix. This satisfies the backend
  `SAFE_ACTION_NAME` gate without changing Store identity.
- **Snowflake** OAuth is account-scoped; the native provider config is
  intentionally `null` (status `missing_oauth_app`) until an account URL env is
  set. This is correct, not a bug.
- Representative actions are a curated subset; the authoritative, current action
  set for any connector is resolved at runtime through Composio
  (`connect.actions` / `connect.schema`).
