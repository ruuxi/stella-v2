import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeRepair,
  applyRepairPlan,
  assertOfflineDatabasePath,
  assertNoActiveDatabaseHolders,
  classifyCertifiedStubCheckpoint,
  listDatabaseHolders,
  runImmediateTransaction,
  writeDurableJson,
} from "../../../../runtime/scripts/repair-stub-compaction-checkpoint.mjs";
import { initializeDesktopDatabase } from "@stella/runtime/kernel/storage/database-init";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";

const scriptPath = path.resolve(
  import.meta.dirname,
  "../../../../runtime/scripts/repair-stub-compaction-checkpoint.mjs",
);
const stubSummary = "## Topic\nCompacted conversation checkpoint.";
const validShortSummary = `## Topic
Stella release audit.
## Key Points
Build, lint and tests passed; raw history remains safe.
## Current State
Ready for independent review.
## Open Items
Await approval; no edits pending.`;
const healthySummary = validShortSummary;
const dependentSummaryA = `## Topic\n${"dependent branch alpha ".repeat(12)}\n## Key Points\n- alpha\n## Current State\n- active\n## Open Items\n- none`;
const dependentSummaryB = `## Topic\n${"dependent branch beta ".repeat(12)}\n## Key Points\n- beta\n## Current State\n- active\n## Open Items\n- none`;

type Entry = {
  entryId: string;
  parentEntryId: string | null;
  entryType: "message" | "custom_message" | "compaction";
  data?: unknown;
};

type JsonReport = {
  mode: "dry-run" | "apply";
  status: string;
  mutated: boolean;
  backupPath?: string;
  authorizationToken: string;
  fingerprints: {
    before?: string;
    after?: string;
    current?: string;
    restored?: string;
  };
  affectedOverlayIds?: string[];
  reparents?: Array<{
    entryId: string;
    fromParentEntryId: string | null;
    toParentEntryId: string | null;
  }>;
};

const temporaryDirectories: string[] = [];

const makeDatabase = (
  args: { targetSummary?: string; targetData?: unknown } = {},
) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "stella-v2-repair-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "stella.sqlite");
  const db = new DatabaseSync(dbPath, {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    `INSERT INTO runtime_threads (
       thread_key, conversation_id, agent_type, name, status,
       created_at, last_used_at, summary
     ) VALUES ('thread-1', 'conversation-1', 'orchestrator',
       'Repair fixture', 'active', 1, 1234, ?)`,
  ).run(dependentSummaryB);

  let sequence = 0;
  const insert = db.prepare(`
    INSERT INTO runtime_thread_entries (
      entry_id, thread_key, session_id, parent_entry_id, entry_type,
      timestamp_iso, created_at, insertion_sequence, data_json
    ) VALUES (?, 'thread-1', 'session-1', ?, ?, ?, ?, ?, ?)
  `);
  const add = ({ entryId, parentEntryId, entryType, data }: Entry) => {
    sequence += 1;
    insert.run(
      entryId,
      parentEntryId,
      entryType,
      `2026-07-20T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      sequence,
      sequence,
      data === undefined ? null : JSON.stringify(data),
    );
  };

  add({
    entryId: "m0",
    parentEntryId: null,
    entryType: "message",
    data: { role: "user", content: "oldest durable message" },
  });
  add({
    entryId: "m1",
    parentEntryId: "m0",
    entryType: "message",
    data: { role: "assistant", content: "healthy boundary" },
  });
  add({
    entryId: "healthy",
    parentEntryId: "m1",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "m1",
      summary: healthySummary,
      tokensBefore: 8_000,
    },
  });
  add({
    entryId: "m2",
    parentEntryId: "healthy",
    entryType: "message",
    data: { role: "user", content: "raw message after healthy checkpoint" },
  });
  add({
    entryId: "m3",
    parentEntryId: "m2",
    entryType: "custom_message",
    data: { customType: "fixture", content: "durable custom row" },
  });
  add({
    entryId: "stub",
    parentEntryId: "m3",
    entryType: "compaction",
    data: args.targetData ?? {
      fromEntryId: "m0",
      toEntryId: "m3",
      summary: args.targetSummary ?? stubSummary,
      tokensBefore: 190_576,
    },
  });
  add({
    entryId: "alpha-1",
    parentEntryId: "stub",
    entryType: "message",
    data: { role: "user", content: "alpha root" },
  });
  add({
    entryId: "unrelated",
    parentEntryId: "m2",
    entryType: "message",
    data: { role: "assistant", content: "unrelated branch" },
  });
  add({
    entryId: "dependent-a",
    parentEntryId: "alpha-1",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "alpha-1",
      summary: dependentSummaryA,
      tokensBefore: 191_000,
    },
  });
  add({
    entryId: "bridge-1",
    parentEntryId: "dependent-a",
    entryType: "message",
    data: { role: "assistant", content: "survives between overlays" },
  });
  add({
    entryId: "dependent-a-2",
    parentEntryId: "bridge-1",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "bridge-1",
      summary: `${dependentSummaryA}\nNested continuation.`,
      tokensBefore: 191_500,
    },
  });
  add({
    entryId: "alpha-2",
    parentEntryId: "dependent-a-2",
    entryType: "message",
    data: { role: "user", content: "deep alpha child" },
  });
  add({
    entryId: "alpha-3",
    parentEntryId: "alpha-2",
    entryType: "message",
    data: { role: "assistant", content: "deep alpha grandchild" },
  });
  add({
    entryId: "beta-1",
    parentEntryId: "stub",
    entryType: "custom_message",
    data: { customType: "fixture", content: "beta root" },
  });
  add({
    entryId: "dependent-b",
    parentEntryId: "beta-1",
    entryType: "compaction",
    data: {
      fromEntryId: "m0",
      toEntryId: "beta-1",
      summary: dependentSummaryB,
      tokensBefore: 192_000,
    },
  });
  add({
    entryId: "beta-2",
    parentEntryId: "dependent-b",
    entryType: "message",
    data: { role: "user", content: "deep beta child" },
  });
  add({
    entryId: "beta-3",
    parentEntryId: "beta-2",
    entryType: "message",
    data: { role: "assistant", content: "deep beta grandchild" },
  });

  // Certified v1 also simulated an unrelated NULL insertion_sequence. The v2
  // initializer backfills every NULL and installs a trigger plus partial
  // unique index for future rows, so recreating that post-initialization state
  // would violate the current storage invariant rather than test a supported
  // v2 architecture. The repair still scopes sequence requirements to affected
  // checkpoints and uses parent topology as authority.

  return { db, dbPath, directory };
};

const addSecondRepairTarget = (db: SqliteDatabase) => {
  db.prepare(
    `INSERT INTO runtime_threads (
       thread_key, conversation_id, agent_type, name, status,
       created_at, last_used_at, summary
     ) VALUES ('thread-2', 'conversation-2', 'orchestrator',
       'Second repair fixture', 'active', 1, 1234, ?)`,
  ).run(stubSummary);
  const insert = db.prepare(`
    INSERT INTO runtime_thread_entries (
      entry_id, thread_key, session_id, parent_entry_id, entry_type,
      timestamp_iso, created_at, insertion_sequence, data_json
    ) VALUES (?, 'thread-2', 'session-2', ?, ?, ?, ?, ?, ?)
  `);
  const entries: Entry[] = [
    {
      entryId: "t2-m0",
      parentEntryId: null,
      entryType: "message",
      data: { role: "user", content: "second root" },
    },
    {
      entryId: "t2-m1",
      parentEntryId: "t2-m0",
      entryType: "message",
      data: { role: "assistant", content: "second healthy boundary" },
    },
    {
      entryId: "t2-healthy",
      parentEntryId: "t2-m1",
      entryType: "compaction",
      data: {
        fromEntryId: "t2-m0",
        toEntryId: "t2-m1",
        summary: healthySummary,
        tokensBefore: 8_000,
      },
    },
    {
      entryId: "t2-m2",
      parentEntryId: "t2-healthy",
      entryType: "message",
      data: { role: "user", content: "second raw message" },
    },
    {
      entryId: "stub-2",
      parentEntryId: "t2-m2",
      entryType: "compaction",
      data: {
        fromEntryId: "t2-m0",
        toEntryId: "t2-m2",
        summary: stubSummary,
        tokensBefore: 190_576,
      },
    },
    {
      entryId: "t2-child",
      parentEntryId: "stub-2",
      entryType: "message",
      data: { role: "assistant", content: "second surviving child" },
    },
  ];
  entries.forEach((entry, index) => {
    const sequence = index + 201;
    insert.run(
      entry.entryId,
      entry.parentEntryId,
      entry.entryType,
      `2026-07-20T01:00:${String(index + 1).padStart(2, "0")}.000Z`,
      sequence,
      sequence,
      JSON.stringify(entry.data),
    );
  });
};

const asDatabaseSync = (db: SqliteDatabase) => db as unknown as DatabaseSync;

const parentOf = (db: SqliteDatabase, entryId: string) =>
  db
    .prepare(
      "SELECT parent_entry_id FROM runtime_thread_entries WHERE entry_id = ?",
    )
    .get(entryId)?.parent_entry_id;

const rowCount = (db: SqliteDatabase, entryId: string) =>
  Number(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM runtime_thread_entries WHERE entry_id = ?",
      )
      .get(entryId)?.count,
  );

const danglingParentCount = (db: SqliteDatabase) =>
  Number(
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM runtime_thread_entries AS child
         LEFT JOIN runtime_thread_entries AS parent
           ON parent.entry_id = child.parent_entry_id
         WHERE child.parent_entry_id IS NOT NULL
           AND parent.entry_id IS NULL`,
      )
      .get()?.count,
  );

const chainToRoot = (db: SqliteDatabase, entryId: string) => {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | null = entryId;
  while (current !== null) {
    if (visited.has(current)) throw new Error(`cycle at ${current}`);
    visited.add(current);
    chain.push(current);
    current = (parentOf(db, current) as string | null) ?? null;
  }
  return chain;
};

const databaseSnapshot = (db: SqliteDatabase) => ({
  entries: db
    .prepare(
      `SELECT * FROM runtime_thread_entries
       WHERE thread_key = 'thread-1'
       ORDER BY insertion_sequence, rowid`,
    )
    .all(),
  thread: db
    .prepare("SELECT * FROM runtime_threads WHERE thread_key = 'thread-1'")
    .get(),
});

const durableRawSnapshot = (db: SqliteDatabase) =>
  db
    .prepare(
      `SELECT entry_id, thread_key, session_id, entry_type, timestamp_iso,
              created_at, insertion_sequence, data_json
       FROM runtime_thread_entries
       WHERE thread_key = 'thread-1' AND entry_type <> 'compaction'
       ORDER BY insertion_sequence, rowid`,
    )
    .all();

const backupFiles = (directory: string) =>
  readdirSync(directory).filter(
    (name) =>
      name.startsWith("stub-checkpoint-backup-") && name.endsWith(".json"),
  );

const runCli = (dbPath: string, ...args: string[]) =>
  spawnSync(process.execPath, [scriptPath, "--db", dbPath, ...args], {
    encoding: "utf8",
  });

const parseReport = (stdout: string): JsonReport => JSON.parse(stdout);

const openDatabase = (dbPath: string, readOnly = false) =>
  new DatabaseSync(dbPath, {
    readOnly,
    timeout: 5_000,
  }) as unknown as SqliteDatabase;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("offline stub compaction checkpoint repair", () => {
  it("defaults to a structured dry run without mutating the database", () => {
    const { db, dbPath, directory } = makeDatabase();
    const before = databaseSnapshot(db);
    db.close();

    const result = runCli(dbPath, "--entry", "stub");
    expect(result.status, result.stderr).toBe(0);
    const report = parseReport(result.stdout);
    expect(report).toMatchObject({
      mode: "dry-run",
      status: "ready",
      mutated: false,
      affectedOverlayIds: [
        "stub",
        "dependent-a",
        "dependent-a-2",
        "dependent-b",
      ],
    });
    expect(report.fingerprints.before).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.authorizationToken).toMatch(
      /^stella-offline-plan-v1\.[a-f0-9]{64}$/u,
    );
    expect(report.reparents?.map((item) => item.entryId)).toEqual([
      "alpha-1",
      "bridge-1",
      "alpha-2",
      "beta-1",
      "beta-2",
    ]);

    const verified = openDatabase(dbPath, true);
    expect(databaseSnapshot(verified)).toEqual(before);
    verified.close();
    expect(backupFiles(directory)).toHaveLength(0);
  });

  it("never classifies a valid 195-character contextual summary as corruption", () => {
    expect(validShortSummary).toHaveLength(195);
    const { db, dbPath, directory } = makeDatabase({
      targetSummary: validShortSummary,
    });
    const before = databaseSnapshot(db);
    db.close();

    const result = runCli(dbPath, "--entry", "stub");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "target summary satisfies the runtime acceptance validator",
    );
    const verified = openDatabase(dbPath, true);
    expect(databaseSnapshot(verified)).toEqual(before);
    verified.close();
    expect(backupFiles(directory)).toHaveLength(0);
  });

  it.each([
    ["numeric summary", { summary: 42 }],
    ["object summary", { summary: { topic: "stub" } }],
    ["string tokens", { tokensBefore: "190576" }],
    ["null tokens", { tokensBefore: null }],
    ["NaN tokens", { tokensBefore: Number.NaN }],
    ["infinite tokens", { tokensBefore: Number.POSITIVE_INFINITY }],
    ["numeric from", { fromEntryId: 1 }],
    ["missing to", { toEntryId: undefined }],
  ])(
    "fails closed for malformed classifier field types: %s",
    (_name, patch) => {
      expect(() =>
        classifyCertifiedStubCheckpoint("stub", {
          fromEntryId: "m0",
          toEntryId: "m3",
          summary: stubSummary,
          tokensBefore: 190_576,
          ...patch,
        }),
      ).toThrow(/Refusing/u);
    },
  );

  it.each([
    ["Unicode body", "## Topic\nCompacted résumé checkpoint."],
    ["zero-width format", "## Topic\nCompacted\u200b checkpoint."],
    ["fullwidth heading", "＃＃ Topic\nCompacted checkpoint."],
    ["astral body", "## Topic\nCompacted 🚀 checkpoint."],
    ["extra section", "## Topic\nStub\n## Open Items\nNone"],
  ])(
    "rejects non-certified Unicode or ambiguous stub shapes: %s",
    (_name, summary) => {
      expect(() =>
        classifyCertifiedStubCheckpoint("stub", {
          fromEntryId: "m0",
          toEntryId: "m3",
          summary,
          tokensBefore: 190_576,
        }),
      ).toThrow(/exact certified ASCII stub signature/u);
    },
  );

  it.each([
    ["equal endpoints", "m0", "m0"],
    ["leading range whitespace", " m0", "m3"],
    ["trailing range whitespace", "m0", "m3 "],
    ["empty endpoint", "", "m3"],
    ["invisible endpoint", "m0\u200b", "m3"],
    ["Unicode endpoint", "mémoire", "m3"],
  ])(
    "rejects an ambiguous compaction range: %s",
    (_name, fromEntryId, toEntryId) => {
      expect(() =>
        classifyCertifiedStubCheckpoint("stub", {
          fromEntryId,
          toEntryId,
          summary: stubSummary,
          tokensBefore: 190_576,
        }),
      ).toThrow(/malformed or ambiguous/u);
    },
  );

  it("refuses every write without explicit stopped-app confirmation", () => {
    const { db, dbPath, directory } = makeDatabase();
    const before = databaseSnapshot(db);
    db.close();
    const dryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);

    const result = runCli(
      dbPath,
      "--entry",
      "stub",
      "--apply",
      "--authorization-token",
      dryRun.authorizationToken,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Refusing --apply without --confirm-stella-stopped",
    );

    const verified = openDatabase(dbPath, true);
    expect(databaseSnapshot(verified)).toEqual(before);
    verified.close();
    expect(backupFiles(directory)).toHaveLength(0);
  });

  it("refuses a stale dry-run authorization token without partial mutation", () => {
    const { db, dbPath, directory } = makeDatabase();
    db.close();
    const dryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);
    const raced = openDatabase(dbPath);
    raced
      .prepare(
        "UPDATE runtime_thread_entries SET data_json = ? WHERE entry_id = 'unrelated'",
      )
      .run(JSON.stringify({ role: "assistant", content: "concurrent drift" }));
    const drifted = databaseSnapshot(raced);
    raced.close();

    const result = runCli(
      dbPath,
      "--entry",
      "stub",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      dryRun.authorizationToken,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorization token mismatch");

    const verified = openDatabase(dbPath, true);
    expect(databaseSnapshot(verified)).toEqual(drifted);
    expect(rowCount(verified, "stub")).toBe(1);
    verified.close();
    expect(backupFiles(directory)).toHaveLength(0);
  });

  it("rejects a dry-run authorization token on a byte-identical database copy", () => {
    const { db, dbPath } = makeDatabase();
    db.close();
    const sourceDryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);
    const copyDirectory = mkdtempSync(
      path.join(os.tmpdir(), "stella-v2-repair-copy-"),
    );
    temporaryDirectories.push(copyDirectory);
    const copyPath = path.join(copyDirectory, "stella.sqlite");
    copyFileSync(dbPath, copyPath);
    const copyDryRun = runCli(copyPath, "--entry", "stub");
    expect(copyDryRun.status, copyDryRun.stderr).toBe(0);
    expect(parseReport(copyDryRun.stdout).authorizationToken).not.toBe(
      sourceDryRun.authorizationToken,
    );

    const result = runCli(
      copyPath,
      "--entry",
      "stub",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      sourceDryRun.authorizationToken,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorization token mismatch");
    const verified = openDatabase(copyPath, true);
    expect(rowCount(verified, "stub")).toBe(1);
    verified.close();
  });

  it("rejects cross-entry authorization-token reuse in the same database", () => {
    const { db, dbPath, directory } = makeDatabase();
    addSecondRepairTarget(db);
    db.close();
    const firstDryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);

    const result = runCli(
      dbPath,
      "--entry",
      "stub-2",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      firstDryRun.authorizationToken,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorization token mismatch");
    const verified = openDatabase(dbPath, true);
    expect(rowCount(verified, "stub")).toBe(1);
    expect(rowCount(verified, "stub-2")).toBe(1);
    verified.close();
    expect(backupFiles(directory)).toHaveLength(0);
  });

  it("rejects repair authorization for the inverse restore operation", () => {
    const { db, dbPath } = makeDatabase();
    db.close();
    const repairDryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);
    const applied = runCli(
      dbPath,
      "--entry",
      "stub",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      repairDryRun.authorizationToken,
    );
    expect(applied.status, applied.stderr).toBe(0);
    const backupPath = parseReport(applied.stdout).backupPath!;
    const restoreDryRun = runCli(dbPath, "--restore", backupPath);
    expect(restoreDryRun.status, restoreDryRun.stderr).toBe(0);
    expect(parseReport(restoreDryRun.stdout).authorizationToken).not.toBe(
      repairDryRun.authorizationToken,
    );

    const result = runCli(
      dbPath,
      "--restore",
      backupPath,
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      repairDryRun.authorizationToken,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Authorization token mismatch");
    const verified = openDatabase(dbPath, true);
    expect(rowCount(verified, "stub")).toBe(0);
    verified.close();
  });

  it("refuses installed and live-data paths before any database operation", () => {
    expect(() =>
      assertOfflineDatabasePath(
        path.join(os.homedir(), "stella", "copied-token.sqlite"),
      ),
    ).toThrow("Refusing live Stella path");
    expect(() =>
      assertOfflineDatabasePath(
        path.join(os.homedir(), ".stella", "stella.sqlite"),
      ),
    ).toThrow("Refusing live Stella path");
  });

  it("reparents the full descendant topology while preserving every raw durable row", () => {
    const { db, dbPath, directory } = makeDatabase();
    const rawBefore = durableRawSnapshot(db);
    const backupPath = path.join(directory, "repair-backup.json");
    const result = runImmediateTransaction(asDatabaseSync(db), () => {
      const plan = analyzeRepair(asDatabaseSync(db), "stub");
      return applyRepairPlan(asDatabaseSync(db), dbPath, plan, backupPath);
    });

    expect(result.noop).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
    expect(durableRawSnapshot(db)).toEqual(rawBefore);
    expect(danglingParentCount(db)).toBe(0);
    expect(chainToRoot(db, "alpha-3")).toEqual([
      "alpha-3",
      "alpha-2",
      "bridge-1",
      "alpha-1",
      "m3",
      "m2",
      "healthy",
      "m1",
      "m0",
    ]);
    expect(chainToRoot(db, "beta-3")).toEqual([
      "beta-3",
      "beta-2",
      "beta-1",
      "m3",
      "m2",
      "healthy",
      "m1",
      "m0",
    ]);
    for (const entryId of [
      "stub",
      "dependent-a",
      "dependent-a-2",
      "dependent-b",
    ]) {
      expect(rowCount(db, entryId)).toBe(0);
    }
    expect(
      db
        .prepare(
          "SELECT summary FROM runtime_threads WHERE thread_key = 'thread-1'",
        )
        .get()?.summary,
    ).toBe(healthySummary);
    const backup = JSON.parse(readFileSync(backupPath, "utf8"));
    expect(backup.fingerprintBefore).toMatch(/^[a-f0-9]{64}$/u);
    expect(backup.fingerprintAfter).toMatch(/^[a-f0-9]{64}$/u);
    db.close();
  });

  it("rolls the entire SQLite transaction back when post-write verification fails", () => {
    const { db, dbPath, directory } = makeDatabase();
    db.exec(`
      CREATE TRIGGER corrupt_unrelated_during_repair
      AFTER DELETE ON runtime_thread_entries
      WHEN OLD.entry_id = 'stub'
      BEGIN
        UPDATE runtime_thread_entries
        SET data_json = '{"corrupted":true}'
        WHERE entry_id = 'unrelated';
      END;
    `);
    const before = databaseSnapshot(db);
    const failedBackupPath = path.join(
      directory,
      "failed-verification-backup.json",
    );

    expect(() =>
      runImmediateTransaction(asDatabaseSync(db), () => {
        const plan = analyzeRepair(asDatabaseSync(db), "stub");
        return applyRepairPlan(
          asDatabaseSync(db),
          dbPath,
          plan,
          failedBackupPath,
        );
      }),
    ).toThrow("Unrelated entry unrelated.data_json changed unexpectedly");

    expect(databaseSnapshot(db)).toEqual(before);
    expect(parentOf(db, "alpha-1")).toBe("stub");
    expect(rowCount(db, "stub")).toBe(1);
    expect(danglingParentCount(db)).toBe(0);
    expect(existsSync(failedBackupPath)).toBe(false);
    db.close();
  });

  it.each([
    ["file", 1],
    ["directory", 2],
  ])("removes an incomplete receipt when %s fsync fails", (_phase, failAt) => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "stella-v2-receipt-fsync-"),
    );
    temporaryDirectories.push(directory);
    const receiptPath = path.join(directory, "receipt.json");
    let fsyncCalls = 0;

    expect(() =>
      writeDurableJson(
        receiptPath,
        { status: "not-authoritative" },
        {
          fsyncSync: () => {
            fsyncCalls += 1;
            if (fsyncCalls === failAt) {
              throw new Error("injected fsync failure");
            }
          },
        },
      ),
    ).toThrow("incomplete artifact removed");
    expect(existsSync(receiptPath)).toBe(false);
  });

  it("reports repeated repair attempts as an idempotent no-op", () => {
    const { db, dbPath, directory } = makeDatabase();
    db.close();
    const dryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);
    const firstApply = runCli(
      dbPath,
      "--entry",
      "stub",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      dryRun.authorizationToken,
    );
    expect(firstApply.status, firstApply.stderr).toBe(0);
    expect(parseReport(firstApply.stdout).status).toBe("committed");
    expect(backupFiles(directory)).toHaveLength(1);

    const afterFirst = openDatabase(dbPath);
    afterFirst
      .prepare(
        `INSERT INTO runtime_thread_entries (
           entry_id, thread_key, session_id, parent_entry_id, entry_type,
           timestamp_iso, created_at, insertion_sequence, data_json
         ) VALUES ('post-repair-message', 'thread-1', 'session-1', 'beta-3',
           'message', '2026-07-20T00:01:00.000Z', 100, 100, ?)`,
      )
      .run(JSON.stringify({ role: "user", content: "later durable append" }));
    const repairedSnapshot = databaseSnapshot(afterFirst);
    afterFirst.close();
    const secondDryRun = runCli(dbPath, "--entry", "stub");
    expect(secondDryRun.status, secondDryRun.stderr).toBe(0);
    expect(parseReport(secondDryRun.stdout)).toMatchObject({
      status: "noop-already-applied",
      mutated: false,
    });

    const secondApply = runCli(
      dbPath,
      "--entry",
      "stub",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      dryRun.authorizationToken,
    );
    expect(secondApply.status, secondApply.stderr).toBe(0);
    expect(parseReport(secondApply.stdout)).toMatchObject({
      status: "noop-already-applied",
      mutated: false,
    });
    expect(backupFiles(directory)).toHaveLength(1);
    const verified = openDatabase(dbPath, true);
    expect(databaseSnapshot(verified)).toEqual(repairedSnapshot);
    verified.close();
  });

  it("refuses a structurally valid checkpoint outside the certified corruption signature", () => {
    const { db, dbPath, directory } = makeDatabase({
      targetSummary: healthySummary,
    });
    const before = databaseSnapshot(db);
    db.close();

    const result = runCli(dbPath, "--entry", "stub");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "target summary satisfies the runtime acceptance validator",
    );
    const verified = openDatabase(dbPath, true);
    expect(databaseSnapshot(verified)).toEqual(before);
    verified.close();
    expect(backupFiles(directory)).toHaveLength(0);
  });

  it("restores an applied repair exactly from its durable logical backup", () => {
    const { db, dbPath } = makeDatabase();
    const original = databaseSnapshot(db);
    db.close();
    const dryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);
    const applied = runCli(
      dbPath,
      "--entry",
      "stub",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      dryRun.authorizationToken,
    );
    expect(applied.status, applied.stderr).toBe(0);
    const backupPath = parseReport(applied.stdout).backupPath;
    expect(backupPath).toBeTruthy();

    const restoreDryRun = runCli(dbPath, "--restore", backupPath!);
    expect(restoreDryRun.status, restoreDryRun.stderr).toBe(0);
    const restoreReport = parseReport(restoreDryRun.stdout);
    const restored = runCli(
      dbPath,
      "--restore",
      backupPath!,
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      restoreReport.authorizationToken,
    );
    expect(restored.status, restored.stderr).toBe(0);

    const verified = openDatabase(dbPath, true);
    expect(databaseSnapshot(verified)).toEqual(original);
    expect(danglingParentCount(verified)).toBe(0);
    verified.close();
  });

  it("rejects a tampered receipt before restore readiness or writes", () => {
    const { db, dbPath } = makeDatabase();
    db.close();
    const dryRun = parseReport(runCli(dbPath, "--entry", "stub").stdout);
    const applied = runCli(
      dbPath,
      "--entry",
      "stub",
      "--apply",
      "--confirm-stella-stopped",
      "--authorization-token",
      dryRun.authorizationToken,
    );
    expect(applied.status, applied.stderr).toBe(0);
    const backupPath = parseReport(applied.stdout).backupPath!;
    const receipt = JSON.parse(readFileSync(backupPath, "utf8"));
    receipt.counts.storedInTargetRange.message += 1;
    writeFileSync(backupPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    const result = runCli(dbPath, "--restore", backupPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Repair receipt digest mismatch");
    const verified = openDatabase(dbPath, true);
    expect(rowCount(verified, "stub")).toBe(0);
    verified.close();
  });

  it("refuses an active database holder even with stopped-app confirmation", async () => {
    const { db, dbPath } = makeDatabase();
    db.close();
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`,
        dbPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", () => resolve());
    });
    try {
      expect(
        listDatabaseHolders(dbPath).some(
          (item: { pid: number }) => item.pid === holder.pid,
        ),
      ).toBe(true);
      expect(() => assertNoActiveDatabaseHolders(dbPath)).toThrow(
        "Refusing apply while database holders are active",
      );
    } finally {
      holder.kill("SIGTERM");
      await new Promise<void>((resolve) =>
        holder.once("exit", () => resolve()),
      );
    }
  });

  it("validates every dependent range even when a descendant sorts before the target", () => {
    const { db } = makeDatabase();
    db.prepare(
      "UPDATE runtime_thread_entries SET data_json = ? WHERE entry_id = 'dependent-b'",
    ).run(
      JSON.stringify({
        fromEntryId: "m2",
        toEntryId: "beta-1",
        summary: dependentSummaryB,
        tokensBefore: 192_000,
      }),
    );
    db.prepare(
      "UPDATE runtime_thread_entries SET insertion_sequence = -1 WHERE entry_id = 'dependent-b'",
    ).run();

    db.exec("BEGIN IMMEDIATE");
    expect(() => analyzeRepair(asDatabaseSync(db), "stub")).toThrow(
      /Dependent compaction dependent-b starts from an incompatible range/u,
    );
    db.exec("ROLLBACK");
    db.close();
  });
});
