import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { listCanonicalConversationFilePaths } from "../../../desktop/electron/services/canonical-conversation-file-paths.js";
import { resolveCanonicalConversationFilePaths } from "../../../desktop/electron/services/canonical-conversation-file-paths.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("canonical Computer file grants", () => {
  it("rejects linked leaf symlinks and accepts real directory aliases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "canonical-files-"));
    try {
      await fs.mkdir(path.join(root, "outputs"));
      const file = path.join(root, "outputs", "report.txt");
      await fs.writeFile(file, "synthetic");
      const leaf = path.join(root, "linked.txt");
      await fs.symlink(file, leaf);
      expect(await resolveCanonicalConversationFilePaths([leaf])).toEqual(
        new Set(),
      );
      await fs.symlink(path.join(root, "outputs"), path.join(root, "alias"));
      const alias = path.join(root, "alias", "report.txt");
      const allowed = await resolveCanonicalConversationFilePaths([alias]);
      expect(allowed.has(alias)).toBe(true);
      expect(allowed.has(await fs.realpath(file))).toBe(true);
      expect(allowed.has(leaf)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("grants only runtime assistant links for the exact host owner and conversation", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE thread(id TEXT, conversation_id TEXT);
        CREATE TABLE computer_agent_cloud_thread_owners(thread_id TEXT, owner_scope TEXT, owner_generation TEXT);
        CREATE TABLE thread_entry(thread_id TEXT, type TEXT, role TEXT, payload TEXT, created_at INTEGER, seq INTEGER, blob_id INTEGER);
        CREATE TABLE blob(id INTEGER, content TEXT);`);
      const add = (
        id: string,
        owner: string,
        conversation: string,
        role: string,
        file: string,
        payloadRole = role,
      ) => {
        db.prepare("INSERT INTO thread VALUES (?,?)").run(id, conversation);
        db.prepare(
          "INSERT INTO computer_agent_cloud_thread_owners VALUES (?,?,'generation:1')",
        ).run(id, owner);
        db.prepare(
          "INSERT INTO thread_entry VALUES (?, 'message', ?, ?, 1, 1, NULL)",
        ).run(
          id,
          role,
          JSON.stringify({
            message: {
              role: payloadRole,
              content: [
                { type: "text", text: `[file](${file})` },
                {
                  type: "toolCall",
                  name: "Read",
                  arguments: { path: "/private/tool-path.txt" },
                },
              ],
            },
          }),
        );
      };
      add("valid", "owner:a", "conv:a", "assistant", "/outputs/report.xlsx");
      add(
        "foreign-owner",
        "owner:b",
        "conv:a",
        "assistant",
        "/private/other-owner.txt",
      );
      add(
        "foreign-conv",
        "owner:a",
        "conv:b",
        "assistant",
        "/private/other-conversation.txt",
      );
      add("user", "owner:a", "conv:a", "user", "/private/user-supplied.txt");
      add(
        "tool",
        "owner:a",
        "conv:a",
        "toolResult",
        "/private/tool-result.txt",
      );
      add(
        "mismatch",
        "owner:a",
        "conv:a",
        "assistant",
        "/private/mismatch.txt",
        "user",
      );
      const sql = db as unknown as SqliteDatabase;
      expect(
        listCanonicalConversationFilePaths(sql, "conv:a", "owner:a"),
      ).toEqual(["/outputs/report.xlsx"]);
      expect(listCanonicalConversationFilePaths(sql, "conv:a", null)).toEqual(
        [],
      );
      expect(
        listCanonicalConversationFilePaths(sql, "unknown", "owner:a"),
      ).toEqual([]);
      // The exact blob, not a shortened payload projection, owns the link.
      db.prepare("INSERT INTO blob VALUES (1, ?)").run(
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "[late link](/outputs/exact.pptx)" },
            ],
          },
        }),
      );
      db.exec("UPDATE thread_entry SET blob_id=1 WHERE thread_id='valid'");
      expect(
        listCanonicalConversationFilePaths(sql, "conv:a", "owner:a"),
      ).toEqual(["/outputs/exact.pptx"]);
      db.exec(
        "DELETE FROM computer_agent_cloud_thread_owners WHERE thread_id='valid'",
      );
      expect(
        listCanonicalConversationFilePaths(sql, "conv:a", "owner:a"),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
