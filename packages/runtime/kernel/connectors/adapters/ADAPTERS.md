<!-- stella first-party connector adapters: CRM / recruiting / sales -->

# First-party CRM / recruiting / sales adapters

Narrow, official-API adapters for HubSpot, Gong, Ashby, Pipedrive, Salesforce,
Apollo, Attio, People Data Labs, and 21RISK. Each adapter is a data-only
description of a provider's representative read/write actions and how each maps
to a single REST request. Execution reuses the existing native path
(`callApiConnector`) in `connect-service` — there is **no second execution
core**, and a mutation is dispatched exactly once (native adapter path *or* the
Composio broker fallback, never both).

## Architecture

- `types.ts` — the narrow `ConnectorAdapter` / `ConnectorAdapterAction`
  interface (id, auth, baseUrl, scopes, per-action JSON schema + pure
  `buildRequest`).
- one file per provider — the action catalog.
- `registry.ts` — lookup surface (`getConnectorAdapter`,
  `getConnectorAdapterAction`, `buildConnectorAdapterRequest`, ...).

Integration points (additive, gated):

- `connect-service.ts › callNativeConnector` dispatches a named adapter action
  through `callNativeOAuthApiPath` when the entry is a **production-ready**
  `oauth-catalog` provider that has an adapter. Unknown actions fall through to
  the generic `<ID>_API_REQUEST` escape hatch.
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
3. Add the id to `PRODUCTION_READY_LOCAL_OAUTH_PROVIDER_IDS`.
4. Verify: connect the account, run one read and one write adapter action.

### OAuth providers — env var names

Backend token exchange uses `tokenExchange: { type: "backend" }`; the backend
resolves the client secret. Names follow the existing
`STELLA_NATIVE_OAUTH_<PROVIDER>_*` convention (`envKey`).

| Provider   | id          | Client id env                              | Client secret env (Convex)                     | Readiness flag                                   |
|------------|-------------|--------------------------------------------|------------------------------------------------|--------------------------------------------------|
| HubSpot    | `hubspot`   | `STELLA_NATIVE_OAUTH_HUBSPOT_CLIENT_ID`    | `STELLA_NATIVE_OAUTH_HUBSPOT_CLIENT_SECRET`    | `STELLA_NATIVE_OAUTH_HUBSPOT_BACKEND_READY=1`    |
| Gong       | `gong`      | `STELLA_NATIVE_OAUTH_GONG_CLIENT_ID`       | `STELLA_NATIVE_OAUTH_GONG_CLIENT_SECRET`       | `STELLA_NATIVE_OAUTH_GONG_BACKEND_READY=1`       |
| Pipedrive  | `pipedrive` | (bundled) `..._PIPEDRIVE_CLIENT_ID` to override | `STELLA_NATIVE_OAUTH_PIPEDRIVE_CLIENT_SECRET` | `STELLA_NATIVE_OAUTH_PIPEDRIVE_BACKEND_READY=1`  |
| Salesforce | `salesforce`| `STELLA_NATIVE_OAUTH_SALESFORCE_CLIENT_ID` | `STELLA_NATIVE_OAUTH_SALESFORCE_CLIENT_SECRET` | `STELLA_NATIVE_OAUTH_SALESFORCE_BACKEND_READY=1` |
| Attio      | `attio`     | `STELLA_NATIVE_OAUTH_ATTIO_CLIENT_ID`      | `STELLA_NATIVE_OAUTH_ATTIO_CLIENT_SECRET`      | `STELLA_NATIVE_OAUTH_ATTIO_BACKEND_READY=1`      |

Salesforce executes against the token's instance URL (`resourceUrl` captured at
connect time), not the login host. HubSpot, Gong, Pipedrive, and Attio use a
fixed API base.

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
