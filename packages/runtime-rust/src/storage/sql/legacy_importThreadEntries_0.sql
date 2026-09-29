WITH ordered AS (
      SELECT
        e.thread_key, e.entry_id, e.entry_type, e.timestamp_iso,
        e.created_at, e.data_json,
        ROW_NUMBER() OVER (
          PARTITION BY e.thread_key ORDER BY {order_clause}
        ) AS seq
      FROM runtime_thread_entries e
    )
    INSERT OR IGNORE INTO thread_entry (
      thread_id, seq, id, type, role, custom_type, payload, blob_id,
      est_tokens, image_count, image_bytes, timestamp_iso, created_at
    )
    SELECT
      thread_key, seq, entry_id, entry_type,
      CASE WHEN entry_type = 'message' AND json_valid(data_json)
           THEN json_extract(data_json, '$.message.role') END,
      CASE WHEN entry_type = 'custom_message' AND json_valid(data_json)
           THEN json_extract(data_json, '$.customType') END,
      data_json, NULL,
      CASE
        WHEN entry_type NOT IN ('message', 'custom_message') THEN 0
        ELSE CAST(COALESCE(
          CASE WHEN json_valid(data_json)
               THEN json_extract(data_json, '$.__stellaContextPressure.estimatedTokens') END,
          (length(COALESCE(data_json, '')) + 2) / 3
        ) AS INTEGER)
      END,
      CAST(COALESCE(
        CASE WHEN json_valid(data_json)
             THEN json_extract(data_json, '$.__stellaContextPressure.imageCount') END,
        0
      ) AS INTEGER),
      CAST(COALESCE(
        CASE WHEN json_valid(data_json)
             THEN json_extract(data_json, '$.__stellaContextPressure.imageDecodedBytes') END,
        0
      ) AS INTEGER),
      timestamp_iso, created_at
    FROM ordered
    WHERE EXISTS (SELECT 1 FROM thread WHERE thread.id = ordered.thread_key);
