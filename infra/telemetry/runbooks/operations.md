# Telemetry operations runbook

## Normal deployment

1. Validate locally with `scripts/validate.sh`.
2. Export environment-specific IaC and catalog sink tokens.
3. Save a plan with `scripts/stack.sh <environment> plan -out=<file>`.
4. Review every replacement. Any replacement of the bucket, catalog, Stream,
   sink, or Pipeline is a stop condition; version the module instead.
5. Apply the saved plan with the guarded helper.
6. Run `scripts/configure-maintenance.sh <environment>`.
7. Put the Terraform `worker_binding` output into the matching Worker
   environment, regenerate Worker bindings, run Worker tests, then deploy it.
8. Submit one contract-valid canary event through the Worker and retain its
   `event_id` and returned request ID.
9. Confirm the canary appears after the sink's roll interval and confirm all
   Pipeline health counters are consistent.

For each Convex deployment, configure a Pro-plan **Webhook Log Stream** whose
URL is the matching telemetry Worker plus `/v1/convex-logs`. Copy the generated
HMAC secret into that Worker's `CONVEX_LOG_STREAM_SECRET` Wrangler secret. Never
reuse the development secret in production. The Worker accepts the current
Convex log-stream schema, ignores ordinary logs, and returns 202 for batches
that contain no Stella metric markers.

Development must be proven before production. A development token or Stream ID
must never be copied into production.

## Verification

Retrieve resource identifiers:

```bash
./infra/telemetry/scripts/stack.sh production output
```

Query a recent bounded window:

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN='...'
bunx wrangler r2 sql query \
  "$(terraform -chdir=infra/telemetry/stacks/production output -raw warehouse_name)" \
  "SELECT event_id, event_type, source, __ingest_ts FROM telemetry.events_v1 ORDER BY __ingest_ts DESC LIMIT 20"
```

Use `queries/pipeline-metrics.graphql` against the Cloudflare GraphQL Analytics
API. For each bounded interval reconcile:

```text
Worker accepted records
    ~= Pipeline recordsIn - decodeErrors
    ~= sink recordsWritten
```

Small timing differences are expected around query-window boundaries. Sustained
or increasing differences are not.

## Alerts

Alert on:

- any non-zero `decodeErrors` or user-error count;
- Worker 5xx or `telemetry.pipeline_failed`;
- no sink files after two configured roll intervals while the Worker accepts
  events;
- a sustained `recordsIn - recordsWritten` gap;
- failed catalog compaction or snapshot-expiration jobs;
- Stream ingress or account resource use approaching beta limits.

Cloudflare exposes `pipelinesOperatorAdaptiveGroups`,
`pipelinesSinkAdaptiveGroups`, and `pipelinesUserErrorsAdaptiveGroups` via its
GraphQL Analytics API. Detailed user errors are retained for only 24 hours, so
respond promptly; never copy payload content into an alert.

## Failure triage

### Worker returns 400

The producer violated the shared closed contract. Reproduce against the contract
validator. Do not weaken the Worker or add an arbitrary payload field.

### Worker returns 401 or 503 authentication errors

Check issuer/JWKS health or the service credential in the Worker. Do not bypass
authentication by enabling the Stream HTTP endpoint.

For `/v1/convex-logs`, a 401 means the deployment's webhook HMAC secret and the
Worker secret differ. Rotate/update the Worker secret from the Convex
integration and use the integration health display to trigger a new
verification delivery. A 403 means the signed batch is older than the webhook
replay window; verify clocks and current delivery health before widening that
window.

### Convex usage and lake totals differ

Convex Log Streams are best-effort and may drop or duplicate events. Treat the
deduplicated lake as telemetry only. Reconcile managed inference cost against
Convex `usage_logs` and billing receipts for the same bounded period; those
transactional records are authoritative. Do not issue credits, invoices, or
quota decisions from R2 SQL. A persistent mismatch is a Log Stream or Pipeline
health incident, not a reason to copy row-level analytics into a Convex outbox.

### Worker returns 503 ingestion unavailable

Check the Worker binding's Stream ID, then inspect Stream and Pipeline status.
The client should keep its bounded local spool and retry with backoff.

### Pipeline reports decode errors

Stop the affected producer rollout. Compare the Worker's flattened record keys
and primitive types byte-for-byte with `schema/v1.json`. A Stream accepts an
invalid structured record and drops it later, so a successful send is not proof
that the sink received it.

### R2 SQL is slow or times out

Filter on a narrow `__ingest_ts` window, select named columns, add `LIMIT`, and
check compaction. R2 SQL is analytical and read-only, not an operational database.

## Recovery and rollback

- Worker rollback: restore the last Worker version whose binding and flattened
  output match the active Stream schema.
- Terraform rollback: do not apply a reverse plan that deletes data resources.
  Restore configuration and make an additive versioned change.
- Schema rollback: point the Worker back to the previous versioned Stream only
  while that Stream and Pipeline remain live.
- Sink or catalog incident: preserve the bucket. Never manually remove Iceberg
  metadata or data files.
- Credential incident: rotate the environment-scoped sink/maintenance token,
  update the secret input, plan, and apply. Then revoke the old token.

Deleting a Stream permanently removes buffered events and dependent Pipelines.
Lifecycle guards exist to make that an explicit, reviewed break-glass action.
