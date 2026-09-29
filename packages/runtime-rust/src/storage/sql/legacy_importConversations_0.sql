INSERT OR IGNORE INTO conversation (
      id, kind, title, status, next_seq, created_at, updated_at
    )
    SELECT
      id,
      CASE WHEN length(id) = 26 AND id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*' THEN 'chat' ELSE 'derived' END,
      COALESCE(title, ''),
      COALESCE(status, 'active'),
      1,
      created_at,
      updated_at
    FROM session;
