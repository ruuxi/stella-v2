import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import fs from "node:fs/promises";
import path from "node:path";

/** Do not turn a linked symlink into a new phone file grant. Include the
 * real path of regular files so macOS /var and /private/var aliases work.
 */
export const resolveCanonicalConversationFilePaths = async (
  paths: readonly string[],
): Promise<Set<string>> => {
  const allowed = new Set<string>();
  for (const filePath of paths) {
    try {
      const resolved = path.resolve(filePath);
      if (!(await fs.lstat(resolved)).isFile()) continue;
      const real = await fs.realpath(resolved);
      allowed.add(resolved);
      allowed.add(real);
    } catch {
      /* Missing or inaccessible files grant nothing. */
    }
  }
  return allowed;
};

/** Runtime-owned assistant links, fenced to the authenticated computer owner.
 * The renderer's replaceable cloud cache and user/tool messages are not grants.
 */
export const listCanonicalConversationFilePaths = (
  db: SqliteDatabase,
  conversationId: string,
  ownerScope: string | null,
): string[] => {
  if (!ownerScope || !conversationId.trim()) return [];
  const rows = db
    .prepare(
      `
    SELECT COALESCE(b.content, candidate.payload) AS payload FROM (
    SELECT e.payload, e.blob_id FROM thread_entry e
    JOIN thread t ON t.id = e.thread_id
    JOIN computer_agent_cloud_thread_owners o ON o.thread_id = t.id
    WHERE t.conversation_id = ? AND o.owner_scope = ?
      AND length(trim(o.owner_generation)) > 0
      AND e.type = 'message' AND e.role = 'assistant'
    ORDER BY e.created_at DESC, e.seq DESC LIMIT 500
    ) candidate LEFT JOIN blob b ON b.id = candidate.blob_id
  `,
    )
    .all(conversationId, ownerScope) as Array<{ payload: string | null }>;
  const paths = new Set<string>();
  for (const row of rows) {
    try {
      const message = JSON.parse(row.payload ?? "null")?.message;
      if (message?.role !== "assistant" || !Array.isArray(message.content))
        continue;
      for (const part of message.content) {
        if (part?.type !== "text" || typeof part.text !== "string") continue;
        for (const filePath of extractLocalFileLinkPaths(part.text))
          paths.add(filePath);
      }
    } catch {
      /* A malformed journal row grants nothing. */
    }
  }
  return [...paths];
};
