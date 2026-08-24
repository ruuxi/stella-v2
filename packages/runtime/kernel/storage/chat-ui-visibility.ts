import type { SqliteDatabase } from "./shared.js";

const CHAT_MESSAGE_TYPES = "'user_message', 'assistant_message'";
const BACKFILL_BATCH_SIZE = 10_000;

const visibilitySql = (payloadExpression: string) => `
  CASE
    WHEN json_valid(${payloadExpression})
      AND (
        COALESCE(json_extract(${payloadExpression}, '$.metadata.ui.visibility'), '') = 'hidden'
        OR COALESCE(json_extract(${payloadExpression}, '$.metadata.trigger.kind'), '') = 'workspace_creation_request'
      )
    THEN 0
    ELSE 1
  END
`;

/**
 * Materialize chat visibility once at write time so every transcript page is
 * an indexed keyset query. SQLite stays authoritative; this is a derived
 * projection maintained by triggers and safely rebuilt for existing rows.
 */
export function ensureChatUiVisibilityIndex(db: SqliteDatabase): void {
  const columns = db.prepare("PRAGMA table_info(message)").all() as Array<{
    name?: string;
  }>;
  if (!columns.some((column) => column.name === "ui_visible")) {
    db.exec("ALTER TABLE message ADD COLUMN ui_visible INTEGER");
  }

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_message_ui_visible_insert
    AFTER INSERT ON message
    WHEN NEW.type IN (${CHAT_MESSAGE_TYPES})
    BEGIN
      UPDATE message SET ui_visible = 1 WHERE rowid = NEW.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_message_ui_visible_type_update
    AFTER UPDATE OF type ON message
    BEGIN
      UPDATE message
      SET ui_visible = CASE
        WHEN NEW.type NOT IN (${CHAT_MESSAGE_TYPES}) THEN NULL
        WHEN EXISTS (
          SELECT 1
          FROM part
          WHERE part.message_id = NEW.id
            AND part.ord = 0
            AND ${visibilitySql("part.data_json")} = 0
        ) THEN 0
        ELSE 1
      END
      WHERE rowid = NEW.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_part_ui_visible_insert
    AFTER INSERT ON part
    WHEN NEW.ord = 0
    BEGIN
      UPDATE message
      SET ui_visible = CASE
        WHEN EXISTS (
          SELECT 1
          FROM part
          WHERE part.message_id = NEW.message_id
            AND part.ord = 0
            AND ${visibilitySql("part.data_json")} = 0
        ) THEN 0
        ELSE 1
      END
      WHERE id = NEW.message_id
        AND type IN (${CHAT_MESSAGE_TYPES});
    END;

    CREATE TRIGGER IF NOT EXISTS trg_part_ui_visible_update
    AFTER UPDATE OF data_json, ord, message_id ON part
    BEGIN
      UPDATE message
      SET ui_visible = CASE
        WHEN EXISTS (
          SELECT 1
          FROM part
          WHERE part.message_id = message.id
            AND part.ord = 0
            AND ${visibilitySql("part.data_json")} = 0
        ) THEN 0
        ELSE 1
      END
      WHERE id IN (OLD.message_id, NEW.message_id)
        AND type IN (${CHAT_MESSAGE_TYPES});
    END;

    CREATE TRIGGER IF NOT EXISTS trg_part_ui_visible_delete
    AFTER DELETE ON part
    WHEN OLD.ord = 0
    BEGIN
      UPDATE message
      SET ui_visible = CASE
        WHEN EXISTS (
          SELECT 1
          FROM part
          WHERE part.message_id = OLD.message_id
            AND part.ord = 0
            AND ${visibilitySql("part.data_json")} = 0
        ) THEN 0
        ELSE 1
      END
      WHERE id = OLD.message_id
        AND type IN (${CHAT_MESSAGE_TYPES});
    END;
  `);

  const selectBatchEnd = db.prepare(`
    SELECT MAX(rowid) AS end_rowid
    FROM (
      SELECT rowid
      FROM message
      WHERE type IN (${CHAT_MESSAGE_TYPES})
        AND ui_visible IS NULL
      ORDER BY rowid ASC
      LIMIT ?
    )
  `);
  const updateBatch = db.prepare(`
    UPDATE message
    SET ui_visible = CASE
      WHEN EXISTS (
        SELECT 1
        FROM part
        WHERE part.message_id = message.id
          AND part.ord = 0
          AND ${visibilitySql("part.data_json")} = 0
      ) THEN 0
      ELSE 1
    END
    WHERE type IN (${CHAT_MESSAGE_TYPES})
      AND ui_visible IS NULL
      AND rowid <= ?
  `);

  while (true) {
    const batch = selectBatchEnd.get(BACKFILL_BATCH_SIZE) as {
      end_rowid?: number | null;
    };
    if (typeof batch.end_rowid !== "number") break;
    db.exec("BEGIN IMMEDIATE");
    try {
      updateBatch.run(batch.end_rowid);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_session_visible_created
      ON message(session_id, ui_visible, created_at, id)
      WHERE type IN (${CHAT_MESSAGE_TYPES});
  `);
  if (columns.some((column) => column.name === "ordering_sequence")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_message_session_visible_sequence
        ON message(session_id, ui_visible, ordering_sequence)
        WHERE type IN (${CHAT_MESSAGE_TYPES});
    `);
  }
}
