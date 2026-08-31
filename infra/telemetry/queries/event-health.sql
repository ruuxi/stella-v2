-- Compare event volume and error volume for a bounded time range.
WITH deduped AS (
  SELECT DISTINCT
    event_id,
    source,
    event_type,
    success,
    installation_id_sha256,
    duration_ms
  FROM telemetry.events_v1
  WHERE __ingest_ts >= TIMESTAMP '{{START_UTC}}'
    AND __ingest_ts < TIMESTAMP '{{END_UTC}}'
)
SELECT
  source,
  event_type,
  success,
  COUNT(*) AS event_count,
  approx_distinct(installation_id_sha256) AS approximate_installations,
  AVG(duration_ms) AS average_duration_ms
FROM deduped
GROUP BY source, event_type, success
ORDER BY event_count DESC
LIMIT 1000;
