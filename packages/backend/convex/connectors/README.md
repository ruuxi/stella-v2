# First-party connector / OAuth execution core

Shared foundation that lets Stella-owned OAuth provider adapters coexist with
Composio and migrate **connector-by-connector**. Public connector IDs, action
schemas, and the Store surface are unchanged; only the backend *executor* moves.

This is Wave 1A (shared OAuth transactions, hosted callback, encrypted vault,
adapter/route registry, rollout controls). Provider-family adapters (Google
Workspace, Microsoft, social, SaaS) plug into the seams listed at the bottom.

## Invariants (enforced in code + tests)

- **Stable identity** — `gmail` stays `gmail`; the executor (`composio` /
  `first_party`) is an implementation detail resolved server-side per call.
- **Tokens stay server-side** — refresh/access tokens live only in
  `oauth_credentials`, encrypted with the existing versioned AES-256-GCM key
  ring (`data/secrets_crypto.ts`). No public/query surface returns ciphertext or
  plaintext; only the callback/refresh actions decrypt in-process.
- **Scope-aware status** — a connector is "connected" only when a bound, active
  account's granted scopes are a superset of every required scope group. Token
  presence alone is never "connected".
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
http_routes/connector_oauth.ts  # hosted GET callback + admin rollout POST
```

## Production environment variables (names only — set in the Convex deployment)

Set in the production deployment (`benevolent-minnow-586`); never in source,
`.env.local`, build artifacts, or desktop config.

| Name | Purpose |
| --- | --- |
| `STELLA_FIRST_PARTY_CONNECTOR_EXECUTION_ENABLED` | Global kill switch. `1`/`true` enables first-party execution. Default off. |
| `STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS` | Comma-separated emergency allowlist of provider keys. Empty = fail closed. |
| `STELLA_CONNECTOR_OAUTH_PUBLIC_BASE_URL` | Sole origin used to build callbacks, e.g. `https://connect.stella.sh`. Until set, connect-start refuses. |
| `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_ID` | Provider OAuth client id. `<KEY>` = manifest key upper-cased, `-`→`_` (e.g. `GOOGLE_WORKSPACE`). |
| `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRETS_JSON` | Versioned secret ring `{"1":"...","2":"..."}` for zero-downtime rotation. |
| `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRET_VERSION` | Active client-secret version. In-flight attempts record the version used. |
| `STELLA_CONNECTOR_AUDIT_RETENTION_DAYS` | Bounded audit/metadata retention. Default 90, capped at 400. |
| `STELLA_SECRETS_MASTER_KEYS_JSON` / `STELLA_SECRETS_MASTER_KEY_VERSION` | Reused envelope-encryption key ring (already required by `secrets_crypto.ts`). |
| `STELLA_CONNECTOR_OAUTH_ALLOW_MOCK` | **Never set in production.** Registers the built-in test/dev `mock` provider. |

## Rollout modes (`connector_rollouts.mode`)

Set via `POST /api/admin/connectors/rollouts` (admin secret) or
`internal.connectors.rollouts.setConnectorRollout`. Absence of a row = default
`composio_only`. Every change bumps `routeVersion` (recorded in audit).

| Mode | Behavior |
| --- | --- |
| `composio_only` | Current path. A first-party account may coexist but is unused. |
| `shadow` | Composio executes; first-party does read-only readiness comparison. Never dual-executes. |
| `first_party_canary` | Deterministic owner-hash cohort (`canaryPercent`) with a ready account runs first-party; others stay Composio. |
| `first_party_preferred` | First-party when a bound account has the required scopes; otherwise prompt connect (writes never silently fall back to Composio). |
| `first_party_only` | Composio connect/run for this connector is refused; first-party is authoritative. |
| `disabled` | Emergency refusal of both executors. |

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
  both `secrets` and `oauth_credentials`. Client-secret rotation uses the
  versioned JSON ring so in-flight attempts survive.

## Data lifecycle

- Owner deletion drains `oauth_connect_attempts`, `oauth_provider_accounts`,
  `oauth_credentials`, `connector_account_bindings`, and
  `connector_audit_events` (`account_deletion.ts`). `connector_rollouts` is
  global config and intentionally not owner-scoped.
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
