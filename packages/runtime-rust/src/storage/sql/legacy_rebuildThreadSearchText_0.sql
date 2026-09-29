UPDATE thread SET search_text = TRIM(
      thread.id || char(10) || thread.name
      || char(10) || COALESCE(thread.summary, '')
      || char(10) || COALESCE((SELECT description FROM agent WHERE agent.thread_id = thread.id), '')
      || char(10) || COALESCE((SELECT result FROM agent WHERE agent.thread_id = thread.id), '')
      || char(10) || COALESCE((SELECT error FROM agent WHERE agent.thread_id = thread.id), '')
    )
    WHERE thread.agent_type != 'orchestrator'
      AND thread.id NOT LIKE '%::subagent::%';
