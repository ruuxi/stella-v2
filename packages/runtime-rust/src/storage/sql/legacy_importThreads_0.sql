INSERT OR IGNORE INTO thread (
      id, conversation_id, agent_type, name, status, summary,
      external_session_id, external_delivered_entry_id, group_key, group_label,
      session_id, session_created_at, cwd, parent_session,
      next_seq, search_text, created_at, last_used_at
    )
    SELECT
      t.thread_key, t.conversation_id, t.agent_type, t.name, t.status, t.summary,
      {external_session_id},
      {external_delivered_entry_id},
      {group_key},
      {group_label},
      {session_id},
      {session_created_at},
      {cwd},
      {parent_session},
      1, NULL, t.created_at, t.last_used_at
    FROM runtime_threads t
    {session_join};
