ALTER TABLE legacy_chat_cloud_import RENAME TO legacy_chat_cloud_import_fk;
    CREATE TABLE legacy_chat_cloud_import (
      local_conversation_id TEXT PRIMARY KEY,
      cloud_conversation_id TEXT,
      owner_generation TEXT,
      next_turn_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO legacy_chat_cloud_import (
      local_conversation_id, cloud_conversation_id, owner_generation,
      next_turn_index, status, detail, created_at, updated_at
    )
    SELECT
      local_conversation_id, cloud_conversation_id, owner_generation,
      next_turn_index, status, detail, created_at, updated_at
    FROM legacy_chat_cloud_import_fk;
    DROP TABLE legacy_chat_cloud_import_fk;
