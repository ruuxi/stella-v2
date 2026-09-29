WITH ordered AS (
      SELECT
        m.session_id AS conversation_id,
        m.id AS id,
        m.type AS type,
        m.role AS role,
        m.device_id, m.request_id, m.target_device_id,
        m.run_id, m.agent_type,
        p.data_json AS payload,
        CASE
          WHEN json_valid(m.data_json)
          THEN json_extract(m.data_json, '$.channelEnvelope')
          ELSE NULL
        END AS channel_envelope,
        {visible_sql} AS visible,
        m.created_at, m.updated_at,
        ROW_NUMBER() OVER (
          PARTITION BY m.session_id ORDER BY {order_clause}
        ) AS seq
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id AND p.ord = 0
    )
    INSERT OR IGNORE INTO entry (
      conversation_id, seq, id, type, role, visible, turn_seq,
      device_id, request_id, target_device_id, run_id, agent_type,
      payload, channel_envelope, search_text, created_at, updated_at
    )
    SELECT
      conversation_id, seq, id, type, role, visible,
      MAX(CASE WHEN type = 'user_message' AND visible = 1 THEN seq END) OVER (
        PARTITION BY conversation_id ORDER BY seq
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ),
      device_id, request_id, target_device_id, run_id, agent_type,
      payload, channel_envelope,
      CASE
        WHEN type IN ('user_message', 'assistant_message')
          AND json_valid(payload)
          AND json_type(payload, '$.text') = 'text'
        THEN json_extract(payload, '$.text')
      END,
      created_at, updated_at
    FROM ordered
    WHERE EXISTS (SELECT 1 FROM conversation WHERE conversation.id = ordered.conversation_id);
