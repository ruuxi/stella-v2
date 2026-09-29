UPDATE thread SET next_seq = COALESCE(
      (SELECT MAX(seq) FROM thread_entry WHERE thread_entry.thread_id = thread.id),
      0
    ) + 1;
