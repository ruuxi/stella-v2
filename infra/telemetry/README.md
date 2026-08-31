# Stella telemetry lake

This directory defines the Cloudflare data plane for Stella's metadata-only
telemetry. It uses **Cloudflare Pipelines Streams**, not the unrelated
Cloudflare Stream video product.

```text
Stella producers
    -> authenticated telemetry Worker
    -> private Pipelines Stream binding
    -> strict SQL projection
    -> R2 Data Catalog / Iceberg / Parquet
    -> R2 SQL
```

The ingestion Worker is the only public edge. The Pipelines HTTP endpoint is
disabled, so no Cloudflare API token is embedded in a desktop or mobile build.

Current producers are Electron main, the detached runtime worker, Cloud
Builder, and Convex. Desktop/runtime delivery is an authenticated, bounded,
durable at-least-once spool; the example R2 SQL queries deduplicate on
`event_id`. Cloud Builder uses a private named-entrypoint service binding and
never blocks turn delivery on analytics.

Convex mirrors OpenCode's Tail Worker pattern through its native Log Streams:
authoritative billing/tool transactions emit a closed `_stella_metric:` JSON
line, and a deployment-specific HMAC-signed webhook delivers logs to
`/v1/convex-logs`. The Worker ignores every non-marker log and pseudonymizes the
already-hashed owner key before writing to Pipelines. Convex `usage_logs` remain
the operational billing/diagnostic record; there is intentionally no duplicate
analytics outbox table in Convex. Convex Log Streams are best-effort, so lake
counts and costs are observability estimates, not billing authority. Billing,
credits, disputes, and exact financial reconciliation must read Convex's
transactional records.

## Layout

- `schema/v1.json` is the closed, flattened Pipeline record schema. It mirrors
  `packages/contracts/telemetry/events.ts`. It intentionally has no arbitrary
  message, metadata, attributes, prompt, response, URL, path, stack, or tool
  argument column.
- `modules/environment-v1` creates one immutable version of the R2 bucket,
  catalog, stream, sink, and SQL pipeline.
- `stacks/development` and `stacks/production` keep credentials and state
  isolated. They create distinct buckets and catalogs.
- `queries` contains bounded R2 SQL and Cloudflare GraphQL operations queries.
- `scripts` validates, plans, applies, and configures catalog maintenance.
- `runbooks/operations.md` covers deployment, verification, alerting, and
  recovery.

## Prerequisites

- Terraform 1.6 or later.
- Cloudflare provider 5.19 or later (constrained below 6.0).
- A Workers Paid account with Pipelines and R2 enabled.
- `CLOUDFLARE_API_TOKEN`: IaC token with Pipelines Write, R2 Storage Write, and
  R2 Data Catalog Write.
- `TF_VAR_cloudflare_account_id`.
- Bucket-scoped R2 credentials in `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` for the `stella-terraform-state` remote backend.

By default Terraform creates a dedicated, environment-scoped sink token with
only R2 bucket-item write and R2 Data Catalog write permissions. The deploying
token therefore also needs Account API Tokens Write. If policy forbids token
creation, pass an existing token as `TF_VAR_catalog_sink_token` instead.
Whether created or supplied, the sink token enters Terraform state; the state
backend must be encrypted and access-controlled.

Production and development must use different sink and maintenance tokens.
Never expose either token to Stella clients or check it into `tfvars`.

## Validate and plan

```bash
./infra/telemetry/scripts/validate.sh

export CLOUDFLARE_API_TOKEN='...'
export TF_VAR_cloudflare_account_id='...'
export AWS_ACCESS_KEY_ID='...'
export AWS_SECRET_ACCESS_KEY='...'
# Optional only when Terraform may not create account tokens:
# export TF_VAR_catalog_sink_token='...'

cp infra/telemetry/stacks/development/backend.hcl.example \
  infra/telemetry/stacks/development/backend.hcl
# Replace <CLOUDFLARE_ACCOUNT_ID> in the ignored backend.hcl.

./infra/telemetry/scripts/stack.sh development plan -out=development.tfplan
terraform -chdir=infra/telemetry/stacks/development show development.tfplan
```

The helper never auto-approves. To apply a reviewed saved plan:

```bash
export TELEMETRY_TERRAFORM_APPLY=yes
./infra/telemetry/scripts/stack.sh development apply development.tfplan
```

No command in this directory deploys as part of validation.

## Connect the Worker

After apply, obtain the exact binding object:

```bash
./infra/telemetry/scripts/stack.sh development output -json worker_binding
./infra/telemetry/scripts/stack.sh production output -json worker_binding
```

Place each environment's value in the corresponding `pipelines` array in
`workers/telemetry/wrangler.jsonc`. The binding name used by the Worker and the
generated object is `EVENTS_PIPELINE`. Then run the Worker's type generation and
tests before its deployment.

## Table maintenance

Provider 5.19-5.23 exposes R2 Data Catalog maintenance configuration as
read-only. Run the repeatable post-apply convergence helper after each stack is
provisioned:

```bash
export R2_CATALOG_MAINTENANCE_TOKEN='...'
./infra/telemetry/scripts/configure-maintenance.sh development
./infra/telemetry/scripts/configure-maintenance.sh production
```

This enables 128 MiB compaction. Development expires snapshots older than 7
days while retaining at least 10; production expires snapshots older than 30
days while retaining at least 20. Re-running the helper converges the settings.

## Immutable versioning

Cloudflare does not allow a Stream schema or Pipeline SQL to be edited in place,
and a Data Catalog sink cannot be recreated against an existing Iceberg table.
Destructive lifecycle guards intentionally reject accidental replacement.

For a schema change:

1. Copy `schema/v1.json` and `modules/environment-v1` to version 2.
2. Add fields only after updating and reviewing the shared TypeScript contract
   and Worker flattener. Do not add generic payload columns.
3. Change the table and all resource names to `v2`.
4. Apply v2 beside v1, bind the Worker to v2, and verify delivery.
5. Retire v1 only after its Stream backlog is empty and the retention decision
   is documented.

Never delete Iceberg data or metadata objects directly from R2. Catalog changes
must go through the catalog.

## Cloudflare constraints captured here

- Pipelines is open beta. Current account defaults are 20 Streams, 20 sinks,
  and 20 Pipelines; each request is limited to 5 MB and each Stream to 5 MB/s.
- R2 Data Catalog sinks are Parquet-only. This module uses zstd and a 300-second
  rolling interval to reduce small-file pressure.
- R2 Data Catalog does not currently support non-default jurisdictions. The
  bucket uses the default jurisdiction and only a best-effort location hint.
- R2 SQL is read-only and beta. Queries must filter on `__ingest_ts` for
  partition pruning and should avoid unbounded scans.

Current product references:

- <https://developers.cloudflare.com/pipelines/>
- <https://developers.cloudflare.com/pipelines/reference/terraform/>
- <https://developers.cloudflare.com/pipelines/platform/limits/>
- <https://developers.cloudflare.com/pipelines/streams/writing-to-streams/>
- <https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/>
- <https://developers.cloudflare.com/r2-data-catalog/table-maintenance/>
- <https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/>
