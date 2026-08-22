<!-- stella first-party connector adapters: CRM / recruiting / sales -->

# First-party CRM / recruiting / sales adapters

Narrow, official-API adapters for HubSpot, Gong, Ashby, Pipedrive, Salesforce,
Apollo, Attio, People Data Labs, and 21RISK. Each adapter is a data-only
description of a provider's representative read/write actions and how each maps
to a single REST request. These files are migration metadata and contract-test
fixtures. Production execution belongs to the backend shared connector core;
`connect-service` does not dispatch them or race them with Composio.

## Architecture

- `types.ts` — the narrow `ConnectorAdapter` / `ConnectorAdapterAction`
  interface (id, auth, baseUrl, scopes, per-action JSON schema + pure
  `buildRequest`).
- one file per provider — the action catalog.
- `registry.ts` — lookup surface (`getConnectorAdapter`,
  `getConnectorAdapterAction`, `buildConnectorAdapterRequest`, ...).

Integration points (additive, gated):

- Backend `connectors/execute.ts` is the only first-party dispatcher. The local
  adapter builders are never an alternate runtime execution path.
- `native-integrations.ts` surfaces adapter actions in `getNativeConnectorTools`
  and `getNativeConnectorCatalogActions` for production-ready adapter providers
  (so `connect.actions` / `connect.schema` and the generated skill list them).

## Production traffic is OFF until activation

`PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS`
(`native-oauth-provider-config.ts`) is intentionally **empty**. While a provider
is not on that allowlist:

- its catalog entry stays `oauth-catalog` / `localExecution: "incomplete"`,
- native execution is refused, and
- the Composio broker remains the sole executor (fallback preserved).

Do **not** add an id to the allowlist until a real connect and a representative
tool call have both passed against the provider's official API.

## Activation checklist (per provider)

1. Register the Stella developer app / obtain credentials (see status below).
2. Set production Convex env vars (names below). Never commit secrets.
3. Enable the provider manifest and configure a backend rollout only after live
   validation; do not add a competing local execution route.
4. Verify: connect the account, then run representative backend actions.

### OAuth providers — env var names

The backend resolves a versioned secret ring from deployment env only.

For each uppercase provider key, configure:

- `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_ID`
- `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRETS_JSON`
- `STELLA_CONNECTOR_OAUTH_<KEY>_CLIENT_SECRET_VERSION`

Then add the lowercase provider key to
`STELLA_CONNECTOR_OAUTH_ENABLED_PROVIDERS`. This is necessary but not sufficient
for activation; rollout remains `composio_only` until live validation passes.

Salesforce, Gong, and Pipedrive use provider-issued tenant origins confined to
allowlisted HTTPS host suffixes. HubSpot and Attio use fixed API origins.

### API-key providers

Ashby, Apollo, People Data Labs, and 21RISK authenticate with the **user's own
API key** (no Stella developer app / secret required). They remain
Composio-served today; native activation additionally needs a catalog entry and
an api-key credential-dialog flow (auth hints of type `api_key`). Auth shape per
provider:

- `ashby` — HTTP Basic, key as username, blank password (store
  `base64(apiKey + ":")`, scheme `basic`). All endpoints POST.
- `apollo` — `X-Api-Key` header (`authHeaderName`).
- `people_data_labs` — `X-Api-Key` header. Read-only enrichment/search.
- `21risk` — API key; OData read-only. **Confirm the tenant OData base path**
  (currently `https://api.21risk.com` + `/odata/<Entity>`) before activation.
  Composio toolkit slug is `_21RISK`; the Stella id is `21risk` (leading
  underscores are not valid catalog ids).

## Registration / review status

See the branch report for the live registration and review state. No payments
were made and no 2FA was bypassed. Any obtained credentials are stored only in
the production Convex environment, never in the repository.
