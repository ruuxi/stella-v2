import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionStore } from "./session-store.js";

const databases: Database[] = [];

const createStore = () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE thread (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      conversation_id TEXT,
      status TEXT,
      last_used_at INTEGER
    )
  `);
  return { db, store: new SessionStore(db as never) };
};

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("mintThreadKey", () => {
  test("keys a thread by its description slug plus a random tail, never the bare slug", () => {
    const { store } = createStore();
    const first = store.mintThreadKey({ agentType: "general", nameHint: "Create local-notes file" });
    const second = store.mintThreadKey({ agentType: "general", nameHint: "Create local-notes file" });
    expect(first).toMatch(/^create-local-notes-file-[a-z0-9]{6}$/);
    expect(second).toMatch(/^create-local-notes-file-[a-z0-9]{6}$/);
    // Two devices minting the same description must not agree on an id: the
    // cloud keeps one thread-id namespace across every account.
    expect(second).not.toBe(first);
  });

  test("falls back to a tailed task key without a usable description", () => {
    const { store } = createStore();
    expect(store.mintThreadKey({ agentType: "general" })).toMatch(/^task-[a-z0-9]{6}$/);
    expect(store.mintThreadKey({ agentType: "general", nameHint: "legacy-import" })).toMatch(/^task-[a-z0-9]{6}$/);
  });

  test("skips a key this device already holds", () => {
    const { db, store } = createStore();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const key = store.mintThreadKey({ agentType: "general", nameHint: "x" });
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      db.prepare("INSERT INTO thread (id, agent_type) VALUES (?, ?)").run(key, "general");
    }
  });
});
