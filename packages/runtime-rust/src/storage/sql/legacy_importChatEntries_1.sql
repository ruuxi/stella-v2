UPDATE conversation SET next_seq = COALESCE(
      (SELECT MAX(seq) FROM entry WHERE entry.conversation_id = conversation.id),
      0
    ) + 1;
