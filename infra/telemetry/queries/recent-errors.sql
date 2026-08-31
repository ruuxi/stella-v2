WITH deduped AS (
  SELECT DISTINCT ON (event_id)
    __ingest_ts,
    occurred_at_ms,
    event_id,
    event_type,
    source,
    component,
    release,
    severity,
    error_class,
    error_code,
    fingerprint,
    recovered
  FROM telemetry.events_v1
  WHERE __ingest_ts >= TIMESTAMP '{{START_UTC}}'
    AND __ingest_ts < TIMESTAMP '{{END_UTC}}'
    AND event_type = 'app.error'
    AND severity IN ('error', 'fatal')
  ORDER BY event_id, __ingest_ts DESC
)
SELECT
  __ingest_ts,
  occurred_at_ms,
  event_id,
  event_type,
  source,
  component,
  release,
  severity,
  error_class,
  error_code,
  fingerprint,
  recovered
FROM deduped
ORDER BY __ingest_ts DESC
LIMIT 500;
