import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import type {
  CloudConversationCacheAuthority,
  CloudConversationCacheReplaceInput,
} from "@stella/contracts/cloud-conversation-cache";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { CloudConversationCacheStore } from "../../../desktop/electron/services/cloud-conversation-cache-store.js";

const roots = new Set<string>();

const createDatabase = (file?: string) => {
  const root = file
    ? path.dirname(file)
    : mkdtempSync(path.join(tmpdir(), "stella-cloud-cache-"));
  roots.add(root);
  const databasePath = file ?? path.join(root, "cache.sqlite");
  const db = new DatabaseSync(databasePath, {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  return { db, databasePath, store: new CloudConversationCacheStore(db) };
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const A1: CloudConversationCacheAuthority = {
  accountScope: "account:a",
  ownerGeneration: "generation:a:1",
  conversationId: "conversation:a",
};

const lifecycle = (authority: CloudConversationCacheAuthority) => ({
  accountScope: authority.accountScope,
  ownerGeneration: authority.ownerGeneration,
});

const version = (snapshot: {
  epoch: number;
  headSeq: number;
  floorSeq: number;
  revision: number;
}) => ({
  epoch: snapshot.epoch,
  headSeq: snapshot.headSeq,
  floorSeq: snapshot.floorSeq,
  revision: snapshot.revision,
});

const message = (seq: number, text = `message-${seq}`) => ({
  kind: "message" as const,
  seq,
  turnId: `turn-${Math.floor(seq / 2)}`,
  createdAtMs: seq + 1,
  role: seq % 2 === 0 ? ("user" as const) : ("assistant" as const),
  hidden: false,
  payload: { content: text },
});

const replacement = (
  authority: CloudConversationCacheAuthority,
  records: unknown[],
  overrides: Partial<CloudConversationCacheReplaceInput> = {},
): CloudConversationCacheReplaceInput => ({
  ...authority,
  expected: null,
  epoch: 1,
  headSeq: records.length ? (records.at(-1) as { seq: number }).seq : -1,
  floorSeq: 0,
  title: "Cached conversation",
  records,
  ...overrides,
});

describe("derived cloud conversation SQLite cache", () => {
  test("survives a process restart and enforces exact epoch/head/floor/revision CAS", () => {
    const first = createDatabase();
    first.store.activateAuthority(lifecycle(A1));
    const applied = first.store.replace(
      replacement(A1, [message(0), message(1)]),
    );
    expect(applied).toMatchObject({
      status: "applied",
      version: { epoch: 1, headSeq: 1, floorSeq: 0, revision: 1 },
    });
    first.db.close();

    const restarted = createDatabase(first.databasePath);
    restarted.store.activateAuthority(lifecycle(A1));
    const recovered = restarted.store.read(A1);
    expect(recovered).toMatchObject({
      ...A1,
      epoch: 1,
      headSeq: 1,
      floorSeq: 0,
      revision: 1,
      records: [message(0), message(1)],
    });

    const advanced = restarted.store.replace(
      replacement(A1, [message(0), message(1), message(2)], {
        expected: version(recovered!),
      }),
    );
    expect(advanced).toMatchObject({
      status: "applied",
      version: { headSeq: 2, revision: 2 },
    });
    expect(
      restarted.store.replace(
        replacement(A1, [message(0), message(1)], {
          expected: version(recovered!),
        }),
      ),
    ).toMatchObject({
      status: "conflict",
      current: { headSeq: 2, revision: 2 },
    });
    restarted.db.close();
  });

  test("rolls back a failed replacement without exposing a partial cache", () => {
    const context = createDatabase();
    context.store.activateAuthority(lifecycle(A1));
    expect(context.store.replace(replacement(A1, [message(0)])).status).toBe(
      "applied",
    );
    const before = context.store.read(A1)!;
    context.db.exec(`
      CREATE TRIGGER fail_cloud_cache_insert
      BEFORE INSERT ON cloud_conversation_cache_records
      WHEN NEW.seq = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected cache failure');
      END;
    `);

    expect(() =>
      context.store.replace(
        replacement(A1, [message(0), message(1)], {
          expected: version(before),
        }),
      ),
    ).toThrow("injected cache failure");
    context.db.exec("DROP TRIGGER fail_cloud_cache_insert;");
    expect(context.store.read(A1)).toEqual(before);
    context.db.close();
  });

  test("purges A-B-A account switches and stale owner generations", () => {
    const context = createDatabase();
    const B1 = {
      accountScope: "account:b",
      ownerGeneration: "generation:b:1",
      conversationId: "conversation:b",
    };
    const A2 = { ...A1, ownerGeneration: "generation:a:2" };

    context.store.activateAuthority(lifecycle(A1));
    context.store.replace(replacement(A1, [message(0)]));
    expect(
      context.store.activateAuthority(lifecycle(B1)).purgedConversations,
    ).toBe(1);
    expect(context.store.read(A1)).toBeNull();
    context.store.replace(replacement(B1, [message(0, "B")], { epoch: 3 }));

    expect(
      context.store.activateAuthority(lifecycle(A1)).purgedConversations,
    ).toBe(1);
    expect(context.store.read(B1)).toBeNull();
    expect(context.store.read(A1)).toBeNull();
    context.store.replace(
      replacement(A1, [message(0, "rebuilt A")], { epoch: 4 }),
    );

    expect(
      context.store.activateAuthority(lifecycle(A2)).purgedConversations,
    ).toBe(1);
    expect(context.store.read(A1)).toBeNull();
    expect(context.store.read(A2)).toBeNull();
    context.db.close();
  });

  test("rebuilds cleanly after complete cache loss", () => {
    const first = createDatabase();
    first.store.activateAuthority(lifecycle(A1));
    first.store.replace(replacement(A1, [message(0)]));
    first.db.close();
    rmSync(first.databasePath, { force: true });

    const rebuilt = createDatabase(first.databasePath);
    rebuilt.store.activateAuthority(lifecycle(A1));
    expect(rebuilt.store.read(A1)).toBeNull();
    expect(
      rebuilt.store.replace(
        replacement(A1, [message(0, "canonical rebuild")], { epoch: 9 }),
      ).status,
    ).toBe("applied");
    expect(rebuilt.store.read(A1)?.records).toEqual([
      message(0, "canonical rebuild"),
    ]);
    rebuilt.db.close();
  });

  test("rejects secrets/extra fields, gaps, and oversized raw journal rows at the storage boundary", () => {
    const context = createDatabase();
    context.store.activateAuthority(lifecycle(A1));
    expect(() =>
      context.store.replace({
        ...replacement(A1, [message(0)]),
        accessToken: "must-not-cross-ipc",
      }),
    ).toThrow("invalid shape");
    expect(() =>
      context.store.replace(
        replacement(A1, [
          {
            ...message(0),
            payload: {
              content: "ordinary journal text",
              nested: { access_token: "synthetic-secret" },
            },
          },
        ]),
      ),
    ).toThrow("secret-bearing field");
    expect(() =>
      context.store.replace(
        replacement(A1, [
          {
            kind: "card",
            seq: 0,
            turnId: "turn-card",
            createdAtMs: 1,
            card: {
              type: "integration",
              credentials: { providerToken: "synthetic-secret" },
            },
          },
        ]),
      ),
    ).toThrow("secret-bearing field");
    expect(() =>
      context.store.replace(replacement(A1, [message(0), message(2)])),
    ).toThrow("gapless");
    expect(() =>
      context.store.replace(
        replacement(A1, [
          { ...message(0), payload: { content: "x", dropped: undefined } },
        ]),
      ),
    ).toThrow("non-JSON");
    expect(() =>
      context.store.replace(
        replacement(A1, [message(0)], { headSeq: -1, floorSeq: 1 }),
      ),
    ).toThrow("head/floor");
    expect(() =>
      context.store.replace(
        replacement(A1, [message(0, "x".repeat(600 * 1024))]),
      ),
    ).toThrow("too large");
    expect(context.store.read(A1)).toBeNull();
    context.db.close();
  });

  test("purges a stored row that gains a nested secret-bearing field", () => {
    const context = createDatabase();
    context.store.activateAuthority(lifecycle(A1));
    expect(context.store.replace(replacement(A1, [message(0)])).status).toBe(
      "applied",
    );

    const poisoned = JSON.stringify({
      ...message(0),
      payload: {
        content: "ordinary journal text",
        provider_token: "synthetic-secret",
      },
    });
    context.db
      .prepare(
        `UPDATE cloud_conversation_cache_records
         SET record_json = ?, record_bytes = ?
         WHERE account_scope = ? AND owner_generation = ? AND conversation_id = ?`,
      )
      .run(
        poisoned,
        Buffer.byteLength(poisoned, "utf8"),
        A1.accountScope,
        A1.ownerGeneration,
        A1.conversationId,
      );

    expect(context.store.read(A1)).toBeNull();
    expect(
      context.db
        .prepare(
          `SELECT COUNT(*) AS count FROM cloud_conversation_cache_meta
           WHERE account_scope = ? AND owner_generation = ? AND conversation_id = ?`,
        )
        .get(A1.accountScope, A1.ownerGeneration, A1.conversationId),
    ).toEqual({ count: 0 });
    context.db.close();
  });

  test("bounds the table and deletes a corrupt window instead of returning it", () => {
    const context = createDatabase();
    context.store.activateAuthority(lifecycle(A1));
    for (let index = 0; index < 9; index += 1) {
      const authority = { ...A1, conversationId: `conversation:${index}` };
      context.store.replace(
        replacement(authority, [message(0, String(index))]),
      );
    }
    expect(
      context.db
        .prepare("SELECT COUNT(*) AS count FROM cloud_conversation_cache_meta")
        .get(),
    ).toEqual({ count: 8 });
    expect(
      context.store.read({ ...A1, conversationId: "conversation:0" }),
    ).toBeNull();

    const newest = { ...A1, conversationId: "conversation:8" };
    context.db
      .prepare(
        `UPDATE cloud_conversation_cache_records
         SET record_json = '{broken'
         WHERE account_scope = ? AND owner_generation = ? AND conversation_id = ?`,
      )
      .run(newest.accountScope, newest.ownerGeneration, newest.conversationId);
    expect(context.store.read(newest)).toBeNull();
    expect(
      context.db
        .prepare(
          `SELECT COUNT(*) AS count FROM cloud_conversation_cache_meta
           WHERE conversation_id = ?`,
        )
        .get(newest.conversationId),
    ).toEqual({ count: 0 });
    context.db.close();
  });
});
