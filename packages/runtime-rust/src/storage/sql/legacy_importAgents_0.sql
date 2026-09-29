INSERT OR IGNORE INTO agent (
      thread_id, conversation_id, storage_mode, owner_generation,
      agent_type, description, prompt,
      prompt_created_at, agent_depth, max_agent_depth, parent_agent_id,
      model_config_json, tool_workspace_root, status, started_at,
      completed_at, result, error, updated_at, root_run_id,
      attempt_generation, cloud_terminal_receipt_generation,
      terminal_lifecycle_receipt_generation, descendant_boundary_state_json,
      record_revision
    )
    SELECT
      thread_id, conversation_id,
      {storage_mode}, {owner_generation},
      agent_type, description,
      {prompt}, {prompt_created_at},
      agent_depth, max_agent_depth, parent_agent_id,
      {model_config_json}, {tool_workspace_root},
      status, started_at, completed_at, result, error, updated_at,
      {root_run_id},
      {attempt_generation},
      {cloud_terminal_receipt_generation},
      {terminal_lifecycle_receipt_generation},
      {descendant_boundary_state_json},
      {record_revision}
    FROM runtime_agents;
