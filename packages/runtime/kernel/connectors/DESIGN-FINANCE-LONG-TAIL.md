# Design, finance, and long-tail connector readiness

This is the reconciliation ledger for the authoritative pages 1-2 set. The
canonical owner is enforced by `first-party-connector-ownership.ts`; metadata
may be reused across modules, but only the owner family may add a connector to
an execution registry.

All entries retain their Composio fallback. No rollout or production OAuth
allowlist is enabled by this work. An OAuth provider remains `unverified` until
its hosted callback and a representative read/write call succeed.

| Connector        | Owner                | Auth    | Implemented                                                                                                           | Activation blocker                                                                    |
| ---------------- | -------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Figma            | design/finance/ops   | OAuth   | Runtime catalog; backend manifest, scopes, fixed-origin executor                                                      | OAuth app secret, hosted callback, representative read/write                          |
| Stripe           | design/finance/ops   | OAuth   | Runtime auth reconciled to Stripe Connect OAuth; backend manifest and form executor                                   | Connect platform credentials, hosted callback, representative read/write              |
| 1Password        | design/finance/ops   | API key | Runtime planner and deferred backend request catalog                                                                  | Per-user API-key vault; validated per-connection Connect HTTPS origin; real call      |
| Abyssale         | design/finance/ops   | API key | Runtime planner and deferred fixed-origin backend request catalog                                                     | Per-user API-key vault and real call                                                  |
| People Data Labs | developer/data       | API key | Canonical developer-data metadata and deferred fixed-origin backend request catalog                                   | Per-user API-key vault, catalog publication, plan-entitled real call                  |
| 21risk           | CRM/recruiting/sales | API key | Runtime planner and deferred backend request catalog; action names normalized to shared-core-safe `TWENTY_ONE_RISK_*` | Tenant OData origin/base-path confirmation, API-key vault, real call                  |
| 2chat            | social               | API key | Social-owned metadata plus deferred fixed-origin backend request catalog                                              | Per-user API-key vault and real call                                                  |
| 7shifts          | design/finance/ops   | API key | Runtime planner and deferred fixed-origin backend request catalog                                                     | Per-user API-key vault, provider API access, real call                                |
| Apollo           | CRM/recruiting/sales | API key | Runtime planner and deferred fixed-origin backend request catalog                                                     | Per-user API-key vault, plan-entitled real call                                       |
| Ashby            | CRM/recruiting/sales | API key | Runtime planner and deferred fixed-origin backend request catalog                                                     | Per-user API-key vault and real call                                                  |
| Gong             | CRM/recruiting/sales | OAuth   | Runtime catalog; expanded backend scopes and fixed/validated-origin executor                                          | OAuth app credentials, hosted callback, representative read/write                     |
| Pipedrive        | CRM/recruiting/sales | OAuth   | Runtime catalog; expanded backend scopes and executor                                                                 | OAuth app credentials/scopes, hosted callback, representative read/write              |
| Attio            | CRM/recruiting/sales | OAuth   | Runtime catalog; expanded backend scopes and executor                                                                 | OAuth app credentials, hosted callback, representative read/write                     |
| HubSpot          | CRM/recruiting/sales | OAuth   | Runtime catalog; expanded backend contacts/deals scopes and executor                                                  | OAuth app credentials/scopes, hosted callback, representative read/write              |
| Salesforce       | CRM/recruiting/sales | OAuth   | Runtime catalog; expanded backend API executor with resource-origin validation                                        | Connected app credentials, hosted callback/instance origin, representative read/write |

## Safety and rollout contract

- OAuth execution always derives its origin from a server manifest or a
  validated provider-issued tenant origin. Call input cannot select a host or
  supply authentication headers.
- Deferred API-key request catalogs contain only relative paths and static,
  non-secret headers. They are not registered with the OAuth executor and
  cannot execute until a server-side per-user API-key vault exists.
- The shared action catalog accepts only letter-leading `UPPER_SNAKE_CASE`
  action names. The public `21risk` connector id and `_21RISK` Composio toolkit
  id are unchanged.
- Routing remains Composio-authoritative until credentials, callback behavior,
  representative provider calls, audit redaction, and rollback are verified in
  the target environment.
