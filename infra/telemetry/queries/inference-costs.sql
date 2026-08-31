-- Replace the two timestamps before running. Filtering on __ingest_ts enables
-- Iceberg partition pruning; occurred_at_ms preserves client event-time.
-- Clients are at-least-once. Deduplicate by the stable event id before
-- counting tokens or cost so a lost HTTP acknowledgement cannot double bill
-- an analytical report.
--
-- Convex billing is authoritative for Stella-managed inference. Runtime
-- observations for provider='stella' describe the same managed call and are
-- excluded here; non-managed/BYOK runtime observations remain included.
WITH deduped AS (
  SELECT DISTINCT
    event_id,
    source,
    provider,
    model,
    success,
    input_tokens,
    output_tokens,
    reasoning_tokens,
    cached_input_tokens,
    cost_micro_cents,
    duration_ms
  FROM telemetry.events_v1
  WHERE event_type = 'inference.completed'
    AND (source = 'convex-backend' OR provider <> 'stella')
    AND __ingest_ts >= TIMESTAMP '{{START_UTC}}'
    AND __ingest_ts < TIMESTAMP '{{END_UTC}}'
)
SELECT
  source,
  provider,
  model,
  success,
  COUNT(*) AS inference_count,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(reasoning_tokens) AS reasoning_tokens,
  SUM(cached_input_tokens) AS cached_input_tokens,
  SUM(cost_micro_cents) / 100000000.0 AS cost_usd,
  AVG(duration_ms) AS average_duration_ms
FROM deduped
GROUP BY source, provider, model, success
ORDER BY cost_usd DESC
LIMIT 500;
