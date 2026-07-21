#!/usr/bin/env node
// Repair a certified stub compaction checkpoint without deleting raw thread
// history. This is an OFFLINE utility; it is not imported by the runtime.
// Dry-run is the default. Apply requires Stella to be stopped, verifies that
// no Electron/Bun/other process still holds the DB or its WAL sidecars, takes
// BEGIN IMMEDIATE before authoritative reads, and writes a durable logical
// backup that can be reversed with --restore.
//
// RUNTIME REQUIREMENT: run this script — and its vitest suite
// (packages/desktop-ui/tests/runtime/scripts/repair-stub-compaction-checkpoint.test.ts) —
// under real Node >= 22 (e.g. /opt/homebrew/bin/node), NOT Bun. Bun 1.3.x
// does not ship the `node:sqlite` module this script depends on.
//
// Repair:
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db /offline/copy/stella.sqlite --entry <stub-entry-id>
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite --entry <stub-entry-id> \
//     --apply --confirm-stella-stopped --expect-fingerprint <dry-run-sha256>
//
// Restore a repair from its JSON backup (dry-run first, then apply):
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite --restore <backup.json>
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db ~/.stella/stella.sqlite --restore <backup.json> \
//     --apply --confirm-stella-stopped --expect-fingerprint <dry-run-sha256>

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CERTIFIED_STUB_MAX_SUMMARY_CHARS = 200;
const CERTIFIED_STUB_MIN_TOKENS_BEFORE = 10_000;
const BACKUP_VERSION = 2;
const REPORT_VERSION = 1;
const LSOF_PATH = "/usr/sbin/lsof";
const REQUIRED_ENTRY_COLUMNS = [
  "entry_id",
  "thread_key",
  "session_id",
  "parent_entry_id",
  "entry_type",
  "timestamp_iso",
  "created_at",
  "data_json",
  "insertion_sequence",
];

const fail = (message) => {
  throw new Error(message);
};

const quoteIdentifier = (value) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    fail(`Unsafe SQLite identifier: ${value}`);
  }
  return `"${value}"`;
};

const readFlag = (args, name) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for --${name}.`);
  }
  return value;
};

const hasFlag = (args, name) => args.includes(`--${name}`);

const expandHome = (value) => {
  if (!value?.startsWith("~")) return value;
  if (value !== "~" && !value.startsWith("~/")) {
    fail(`Unsupported home-relative path: ${value}`);
  }
  return path.join(os.homedir(), value.slice(value === "~" ? 1 : 2));
};

export const resolveExistingRegularFile = (input, label) => {
  if (!input) fail(`Missing ${label}.`);
  const expanded = expandHome(input);
  const absolute = path.resolve(expanded);
  if (!fs.existsSync(absolute)) fail(`${label} not found: ${absolute}`);
  const resolved = fs.realpathSync(absolute);
  if (!fs.statSync(resolved).isFile())
    fail(`${label} is not a regular file: ${resolved}`);
  return resolved;
};

const parseLsofRecords = (stdout) => {
  const holders = [];
  let current = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      if (current) holders.push(current);
      current = { pid: Number(value), command: "unknown", user: "unknown" };
    } else if (tag === "c" && current) current.command = value;
    else if (tag === "u" && current) current.user = value;
  }
  if (current) holders.push(current);
  return holders.filter((holder) => Number.isInteger(holder.pid));
};

export const listDatabaseHolders = (dbPath, ignoredPids = [process.pid]) => {
  if (process.platform !== "darwin") {
    fail("Active-writer verification is currently supported only on macOS.");
  }
  if (!fs.existsSync(LSOF_PATH))
    fail(`Required active-writer verifier not found: ${LSOF_PATH}`);
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(
    (candidate) => fs.existsSync(candidate),
  );
  const result = spawnSync(LSOF_PATH, ["-Fpcu", "--", ...candidates], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error)
    fail(`Could not inspect database holders: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    fail(`lsof failed (${result.status}): ${result.stderr.trim()}`);
  }
  const ignored = new Set(ignoredPids);
  return parseLsofRecords(result.stdout).filter(
    (holder) => !ignored.has(holder.pid),
  );
};

export const assertNoActiveDatabaseHolders = (
  dbPath,
  ignoredPids = [process.pid],
) => {
  const holders = listDatabaseHolders(dbPath, ignoredPids);
  if (holders.length === 0) return;
  fail(
    `Refusing apply while database holders are active: ${holders
      .map((holder) => `${holder.command} pid=${holder.pid}`)
      .join(", ")}. Quit Stella and its worker, then retry.`,
  );
};

const tableColumns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => String(row.name));

const assertSchema = (db) => {
  const entryColumns = tableColumns(db, "runtime_thread_entries");
  const threadColumns = tableColumns(db, "runtime_threads");
  for (const column of REQUIRED_ENTRY_COLUMNS) {
    if (!entryColumns.includes(column))
      fail(`Database is missing runtime_thread_entries.${column}.`);
  }
  if (
    !threadColumns.includes("thread_key") ||
    !threadColumns.includes("summary")
  ) {
    fail("Database has an incompatible runtime_threads schema.");
  }
  return { entryColumns, threadColumns };
};

const selectColumns = (columns) => columns.map(quoteIdentifier).join(", ");

const parseCompactionData = (row) => {
  let data;
  try {
    data = JSON.parse(row.data_json ?? "{}");
  } catch (error) {
    fail(
      `Entry ${row.entry_id} has invalid data_json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return data && typeof data === "object" ? data : {};
};

const rowMatches = (left, right, columns) =>
  columns.every((column) => Object.is(left?.[column], right?.[column]));

const fingerprintSnapshot = ({ entryColumns, threadColumns, rows, thread }) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        entryColumns,
        threadColumns,
        rows: rows.map((row) =>
          entryColumns.map((column) => row[column] ?? null),
        ),
        thread: threadColumns.map((column) => thread?.[column] ?? null),
      }),
    )
    .digest("hex");

const loadThreadEntries = (db, threadKey, entryColumns) =>
  db
    .prepare(
      `SELECT ${selectColumns(entryColumns)} FROM runtime_thread_entries
       WHERE thread_key = ?
       ORDER BY insertion_sequence ASC, rowid ASC`,
    )
    .all(threadKey);

// v2's database initializer backfills insertion_sequence and installs a
// trigger for new rows. The repair therefore performs no legacy sequence
// migration of its own: parent links remain the topology authority, while a
// safe sequence is required only for checkpoints the repair will delete.

const loadThreadRow = (db, threadKey, threadColumns) =>
  db
    .prepare(
      `SELECT ${selectColumns(threadColumns)} FROM runtime_threads WHERE thread_key = ?`,
    )
    .get(threadKey);

const fingerprintCurrentThread = (db, plan) => {
  const rows = loadThreadEntries(db, plan.target.thread_key, plan.entryColumns);
  const thread = loadThreadRow(db, plan.target.thread_key, plan.threadColumns);
  if (!thread)
    fail(`Missing runtime_threads row for ${plan.target.thread_key}.`);
  return fingerprintSnapshot({
    entryColumns: plan.entryColumns,
    threadColumns: plan.threadColumns,
    rows,
    thread,
  });
};

const buildTopology = (rows) => {
  const byId = new Map(rows.map((row) => [row.entry_id, row]));
  const children = new Map();
  for (const row of rows) {
    if (row.parent_entry_id === null) continue;
    if (!byId.has(row.parent_entry_id)) {
      fail(
        `Thread already has dangling parent ${row.parent_entry_id} referenced by ${row.entry_id}.`,
      );
    }
    const bucket = children.get(row.parent_entry_id) ?? [];
    bucket.push(row);
    children.set(row.parent_entry_id, bucket);
  }
  const state = new Map();
  const visit = (row) => {
    const current = state.get(row.entry_id);
    if (current === "done") return;
    if (current === "visiting") fail(`Cycle detected at ${row.entry_id}.`);
    state.set(row.entry_id, "visiting");
    if (row.parent_entry_id !== null) {
      visit(byId.get(row.parent_entry_id));
    }
    state.set(row.entry_id, "done");
  };
  for (const row of rows) visit(row);
  return { byId, children };
};

const rowsParentsFirst = (rows) => {
  const pending = new Map(rows.map((row) => [row.entry_id, row]));
  const ordered = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter(
      (row) =>
        row.parent_entry_id === null || !pending.has(row.parent_entry_id),
    );
    if (ready.length === 0) fail("Cycle detected in repair row set.");
    for (const row of ready) {
      ordered.push(row);
      pending.delete(row.entry_id);
    }
  }
  return ordered;
};

const ancestorRows = (row, byId) => {
  const ancestors = [];
  const visited = new Set([row.entry_id]);
  let parentId = row.parent_entry_id;
  while (parentId !== null) {
    if (visited.has(parentId)) fail(`Cycle detected at ${parentId}.`);
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) fail(`Missing ancestor ${parentId}.`);
    ancestors.push(parent);
    parentId = parent.parent_entry_id;
  }
  return ancestors;
};

const descendantIds = (entryId, children) => {
  const descendants = new Set();
  const pending = [...(children.get(entryId) ?? [])];
  while (pending.length > 0) {
    const row = pending.pop();
    if (descendants.has(row.entry_id)) continue;
    descendants.add(row.entry_id);
    pending.push(...(children.get(row.entry_id) ?? []));
  }
  return descendants;
};

const nearestSurvivingParentId = (row, affectedIds, byId) => {
  let parentId = row.parent_entry_id;
  while (parentId !== null && affectedIds.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) fail(`Affected ancestor ${parentId} disappeared.`);
    parentId = parent.parent_entry_id;
  }
  return parentId;
};

const countPathRows = (byId, startEntryId, stopEntryId, includeStop) => {
  const counts = { message: 0, customMessage: 0 };
  const visited = new Set();
  let row = byId.get(startEntryId);
  while (row) {
    if (visited.has(row.entry_id)) {
      fail(`Cycle detected while counting path at ${row.entry_id}.`);
    }
    visited.add(row.entry_id);
    if (row.entry_id === stopEntryId && !includeStop) return counts;
    if (row.entry_type === "message") counts.message += 1;
    else if (row.entry_type === "custom_message") counts.customMessage += 1;
    if (row.entry_id === stopEntryId) return counts;
    row =
      row.parent_entry_id === null ? undefined : byId.get(row.parent_entry_id);
  }
  fail(`Path from ${startEntryId} does not reach boundary ${stopEntryId}.`);
};

export const analyzeRepair = (db, entryId) => {
  const { entryColumns, threadColumns } = assertSchema(db);
  const target = db
    .prepare(
      `SELECT ${selectColumns(entryColumns)} FROM runtime_thread_entries WHERE entry_id = ?`,
    )
    .get(entryId);
  if (!target) fail(`No entry with id ${entryId}.`);
  if (target.entry_type !== "compaction")
    fail(`Entry ${entryId} is ${target.entry_type}, not compaction.`);
  if (!Number.isSafeInteger(target.insertion_sequence))
    fail(`Entry ${entryId} lacks a safe insertion_sequence.`);

  const targetData = parseCompactionData(target);
  const summary = String(targetData.summary ?? "");
  const tokensBefore = Number(targetData.tokensBefore ?? 0);
  const fromEntryId = String(targetData.fromEntryId ?? "");
  // This narrow classifier is the certified v1 repair signature: a tiny
  // checkpoint over a genuinely large span, with an explicit durable range.
  // Do not duplicate the online TypeScript summary validator here. The v2
  // runtime now prevents new malformed checkpoints; this offline tool exists
  // only to remove already-persisted rows that match the certified corruption
  // shape. Anything outside it is refused for manual review.
  if (summary.length >= CERTIFIED_STUB_MAX_SUMMARY_CHARS) {
    fail(
      `Refusing: summary is ${summary.length} chars (>= ${CERTIFIED_STUB_MAX_SUMMARY_CHARS}); checkpoint is not certified repairable.`,
    );
  }
  if (tokensBefore < CERTIFIED_STUB_MIN_TOKENS_BEFORE) {
    fail(
      `Refusing: tokensBefore is ${tokensBefore} (< ${CERTIFIED_STUB_MIN_TOKENS_BEFORE}); checkpoint is not certified repairable.`,
    );
  }
  if (!fromEntryId || !String(targetData.toEntryId ?? "")) {
    fail(
      "Refusing: target compaction has no explicit fromEntryId/toEntryId range.",
    );
  }

  const rows = loadThreadEntries(db, target.thread_key, entryColumns);
  const { byId, children } = buildTopology(rows);
  const ancestors = ancestorRows(target, byId);
  const previous = ancestors.find((candidate) => {
    if (candidate.entry_type !== "compaction") return false;
    return (
      String(parseCompactionData(candidate).summary ?? "").length >=
      CERTIFIED_STUB_MAX_SUMMARY_CHARS
    );
  });
  if (!previous)
    fail(
      "No earlier healthy checkpoint exists on the target's authoritative parent path.",
    );
  const previousData = parseCompactionData(previous);
  const previousSummary = String(previousData.summary ?? "");
  const previousTo = byId.get(String(previousData.toEntryId ?? ""));
  if (!previousTo)
    fail(`Previous checkpoint ${previous.entry_id} has an invalid toEntryId.`);

  const descendants = descendantIds(target.entry_id, children);
  const affected = rows.filter(
    (row) =>
      row.entry_id === target.entry_id ||
      (descendants.has(row.entry_id) && row.entry_type === "compaction"),
  );
  if (
    affected.some(
      (candidate) => !Number.isSafeInteger(candidate.insertion_sequence),
    )
  ) {
    fail("An affected checkpoint lacks a safe insertion_sequence.");
  }
  // Validate every dependent checkpoint except the target itself. Filtering
  // by entry_id (not position) matters: `rows` is ordered by
  // insertion_sequence, so a dependent row that sorts BEFORE the target
  // would occupy index 0 and escape a slice(1)-style check.
  for (const candidate of affected.filter(
    (row) => row.entry_id !== target.entry_id,
  )) {
    const data = parseCompactionData(candidate);
    if (String(data.fromEntryId ?? "") !== fromEntryId) {
      fail(
        `Dependent compaction ${candidate.entry_id} starts from an incompatible range.`,
      );
    }
  }
  const affectedIds = new Set(affected.map((row) => row.entry_id));
  const affectedDeletionOrder = [...affected].sort((left, right) => {
    const leftDepth = ancestorRows(left, byId).filter((row) =>
      affectedIds.has(row.entry_id),
    ).length;
    const rightDepth = ancestorRows(right, byId).filter((row) =>
      affectedIds.has(row.entry_id),
    ).length;
    return rightDepth - leftDepth;
  });
  // Every surviving descendant subtree keeps all of its internal edges. Only
  // the boundary edge whose immediate parent will be deleted is rewritten to
  // the nearest surviving ancestor; full-thread verification below then walks
  // and fingerprints every descendant, not merely these boundary children.
  const reparents = rows
    .filter(
      (row) =>
        !affectedIds.has(row.entry_id) &&
        row.parent_entry_id !== null &&
        affectedIds.has(row.parent_entry_id),
    )
    .map((row) => ({
      before: row,
      afterParentEntryId: nearestSurvivingParentId(row, affectedIds, byId),
    }));

  const thread = loadThreadRow(db, target.thread_key, threadColumns);
  if (!thread) fail(`Missing runtime_threads row for ${target.thread_key}.`);
  const removedSummaries = new Set(
    affected.map((row) => String(parseCompactionData(row).summary ?? "")),
  );
  const metadataBelongsToAffectedOverlay =
    typeof thread.summary === "string" && removedSummaries.has(thread.summary);
  const threadSummaryAfter = metadataBelongsToAffectedOverlay
    ? previousSummary
    : thread.summary;

  const latestAffected = affected.reduce((latest, candidate) =>
    candidate.insertion_sequence > latest.insertion_sequence
      ? candidate
      : latest,
  );
  const latestAffectedTo = byId.get(
    String(parseCompactionData(latestAffected).toEntryId ?? ""),
  );
  if (!latestAffectedTo) {
    fail(
      `Affected checkpoint ${latestAffected.entry_id} has an invalid toEntryId.`,
    );
  }
  const targetFrom = byId.get(fromEntryId);
  const targetTo = byId.get(String(targetData.toEntryId));
  if (!targetFrom || !targetTo)
    fail("Target compaction range points outside its thread.");

  const survivingRows = rows
    .filter((row) => !affectedIds.has(row.entry_id))
    .map((row) => {
      const reparent = reparents.find(
        (item) => item.before.entry_id === row.entry_id,
      );
      return reparent
        ? { ...row, parent_entry_id: reparent.afterParentEntryId }
        : row;
    });
  const threadAfter = { ...thread, summary: threadSummaryAfter };
  const fingerprintBefore = fingerprintSnapshot({
    entryColumns,
    threadColumns,
    rows,
    thread,
  });
  const fingerprintAfter = fingerprintSnapshot({
    entryColumns,
    threadColumns,
    rows: survivingRows,
    thread: threadAfter,
  });

  return {
    entryId,
    entryColumns,
    threadColumns,
    target,
    targetData,
    rows,
    affected,
    affectedDeletionOrder,
    affectedIds,
    previous,
    previousSummary,
    reparents,
    thread,
    threadSummaryAfter,
    metadataBelongsToAffectedOverlay,
    fingerprintBefore,
    fingerprintAfter,
    eligibility: {
      classifier: "certified-v1-stub-checkpoint-v1",
      summaryChars: summary.length,
      tokensBefore,
      explicitRange: true,
    },
    counts: {
      storedInTargetRange: countPathRows(
        byId,
        targetTo.entry_id,
        targetFrom.entry_id,
        true,
      ),
      newlyExposedThroughDependentBoundary: countPathRows(
        byId,
        latestAffectedTo.entry_id,
        previousTo.entry_id,
        false,
      ),
    },
  };
};

const backupEntryKey = (entryId) =>
  createHash("sha256").update(entryId).digest("hex").slice(0, 20);

const backupFilePrefix = (entryId) =>
  `stub-checkpoint-backup-${backupEntryKey(entryId)}-`;

const createBackupPath = (dbPath, entryId) =>
  path.join(
    path.dirname(dbPath),
    `${backupFilePrefix(entryId)}${Date.now()}.json`,
  );

const writeDurableJson = (filePath, value) => {
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directoryFd = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
};

const fullRowWhere = (columns) =>
  columns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");

const assertRepairPostconditions = (db, plan) => {
  const current = loadThreadEntries(
    db,
    plan.target.thread_key,
    plan.entryColumns,
  );
  const currentById = new Map(current.map((row) => [row.entry_id, row]));
  for (const deleted of plan.affected) {
    if (currentById.has(deleted.entry_id))
      fail(`Deleted checkpoint ${deleted.entry_id} is still present.`);
  }
  const reparentById = new Map(
    plan.reparents.map((item) => [item.before.entry_id, item]),
  );
  for (const before of plan.rows) {
    if (plan.affectedIds.has(before.entry_id)) continue;
    const after = currentById.get(before.entry_id);
    if (!after) fail(`Unrelated entry ${before.entry_id} disappeared.`);
    const reparent = reparentById.get(before.entry_id);
    for (const column of plan.entryColumns) {
      const expected =
        column === "parent_entry_id" && reparent
          ? reparent.afterParentEntryId
          : before[column];
      if (!Object.is(after[column], expected))
        fail(
          `Unrelated entry ${before.entry_id}.${column} changed unexpectedly.`,
        );
    }
  }
  buildTopology(current);
  const thread = loadThreadRow(db, plan.target.thread_key, plan.threadColumns);
  if (!Object.is(thread?.summary, plan.threadSummaryAfter))
    fail("Thread summary postcondition failed.");
  const fingerprint = fingerprintSnapshot({
    entryColumns: plan.entryColumns,
    threadColumns: plan.threadColumns,
    rows: current,
    thread,
  });
  if (fingerprint !== plan.fingerprintAfter) {
    fail(
      `Repair verification fingerprint mismatch: expected ${plan.fingerprintAfter}, received ${fingerprint}.`,
    );
  }
};

export const applyRepairPlan = (
  db,
  dbPath,
  plan,
  backupPath = createBackupPath(dbPath, plan.entryId),
) => {
  if (!db.isTransaction) {
    fail("applyRepairPlan requires an active BEGIN IMMEDIATE transaction.");
  }
  const targetStillExists = db
    .prepare("SELECT 1 FROM runtime_thread_entries WHERE entry_id = ?")
    .get(plan.entryId);
  if (!targetStillExists) {
    assertRepairPostconditions(db, plan);
    return { backupPath: null, backup: null, noop: true };
  }
  const currentFingerprint = fingerprintCurrentThread(db, plan);
  if (currentFingerprint !== plan.fingerprintBefore) {
    fail(
      `CAS fingerprint conflict: expected ${plan.fingerprintBefore}, received ${currentFingerprint}. Re-run the dry run.`,
    );
  }
  const backup = {
    version: BACKUP_VERSION,
    kind: "stella-stub-checkpoint-repair",
    databasePath: dbPath,
    createdAt: new Date().toISOString(),
    entryColumns: plan.entryColumns,
    threadColumns: plan.threadColumns,
    targetEntryId: plan.entryId,
    deletedEntries: plan.affected,
    reparentedChildren: plan.reparents,
    threadBefore: plan.thread,
    threadSummaryAfter: plan.threadSummaryAfter,
    fingerprintBefore: plan.fingerprintBefore,
    fingerprintAfter: plan.fingerprintAfter,
    counts: plan.counts,
  };

  const updateParent = db.prepare(
    `UPDATE runtime_thread_entries SET parent_entry_id = ?
     WHERE entry_id = ? AND thread_key = ? AND parent_entry_id IS ?`,
  );
  for (const reparent of plan.reparents) {
    const result = updateParent.run(
      reparent.afterParentEntryId,
      reparent.before.entry_id,
      reparent.before.thread_key,
      reparent.before.parent_entry_id,
    );
    if (result.changes !== 1)
      fail(`CAS failed while reparenting ${reparent.before.entry_id}.`);
  }

  const deleteRow = db.prepare(
    `DELETE FROM runtime_thread_entries WHERE ${fullRowWhere(plan.entryColumns)}`,
  );
  // Delete descendants before ancestors based on authoritative parent depth,
  // never insertion order (which is diagnostic ordering, not topology).
  for (const row of plan.affectedDeletionOrder) {
    const result = deleteRow.run(
      ...plan.entryColumns.map((column) => row[column]),
    );
    if (result.changes !== 1)
      fail(`CAS failed while deleting ${row.entry_id}.`);
  }

  if (!Object.is(plan.thread.summary, plan.threadSummaryAfter)) {
    const result = db
      .prepare(
        `UPDATE runtime_threads SET summary = ?
         WHERE thread_key = ? AND summary IS ?`,
      )
      .run(
        plan.threadSummaryAfter,
        plan.target.thread_key,
        plan.thread.summary,
      );
    if (result.changes !== 1)
      fail("CAS failed while updating runtime_threads.summary.");
  }
  assertRepairPostconditions(db, plan);
  // The verified transaction is still uncommitted here. Persist and fsync its
  // reversible preimage before the caller may COMMIT; a backup write failure
  // therefore rolls the SQLite changes back instead of committing unrecoverably.
  writeDurableJson(backupPath, backup);
  return { backupPath, backup, noop: false };
};

const loadBackup = (backupPath) => {
  const value = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  if (
    value?.version !== BACKUP_VERSION ||
    value?.kind !== "stella-stub-checkpoint-repair"
  ) {
    fail(`Unsupported repair backup: ${backupPath}`);
  }
  return value;
};

const analyzeAppliedRepairState = (db, dbPath, backup) => {
  const schema = assertSchema(db);
  if (path.resolve(backup.databasePath) !== dbPath) {
    fail(`Backup belongs to a different database path: ${backup.databasePath}`);
  }
  if (
    JSON.stringify(schema.entryColumns) !==
      JSON.stringify(backup.entryColumns) ||
    JSON.stringify(schema.threadColumns) !==
      JSON.stringify(backup.threadColumns)
  ) {
    fail("Database schema no longer matches the repair receipt.");
  }
  const rows = loadThreadEntries(
    db,
    backup.threadBefore.thread_key,
    backup.entryColumns,
  );
  const byId = new Map(rows.map((row) => [row.entry_id, row]));
  buildTopology(rows);
  for (const deleted of backup.deletedEntries) {
    if (byId.has(deleted.entry_id)) {
      fail(`Previously repaired checkpoint ${deleted.entry_id} reappeared.`);
    }
  }
  for (const reparent of backup.reparentedChildren) {
    const current = byId.get(reparent.before.entry_id);
    if (!current) {
      fail(
        `Previously reparented child ${reparent.before.entry_id} is missing.`,
      );
    }
    for (const column of backup.entryColumns) {
      const expected =
        column === "parent_entry_id"
          ? reparent.afterParentEntryId
          : reparent.before[column];
      if (!Object.is(current[column], expected)) {
        fail(
          `Previously reparented child ${reparent.before.entry_id}.${column} changed unexpectedly.`,
        );
      }
    }
  }
  const thread = loadThreadRow(
    db,
    backup.threadBefore.thread_key,
    backup.threadColumns,
  );
  if (!thread) fail("Previously repaired runtime_threads row is missing.");
  return {
    fingerprint: fingerprintSnapshot({
      entryColumns: backup.entryColumns,
      threadColumns: backup.threadColumns,
      rows,
      thread,
    }),
  };
};

const findAppliedRepair = (db, dbPath, entryId) => {
  const prefix = backupFilePrefix(entryId);
  const candidates = fs
    .readdirSync(path.dirname(dbPath))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .reverse();
  const mismatches = [];
  for (const name of candidates) {
    const backupPath = path.join(path.dirname(dbPath), name);
    let backup;
    try {
      backup = loadBackup(backupPath);
    } catch (error) {
      mismatches.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (
      backup.targetEntryId !== entryId ||
      path.resolve(backup.databasePath) !== dbPath
    ) {
      continue;
    }
    try {
      const appliedState = analyzeAppliedRepairState(db, dbPath, backup);
      return { backupPath, backup, appliedState };
    } catch (error) {
      mismatches.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (mismatches.length > 0) {
    fail(
      `Entry ${entryId} is absent, but its repair receipt does not match current database state: ${mismatches.join("; ")}`,
    );
  }
  return null;
};

export const analyzeRepairOrNoop = (db, dbPath, entryId) => {
  const target = db
    .prepare("SELECT 1 FROM runtime_thread_entries WHERE entry_id = ?")
    .get(entryId);
  if (target) return { status: "repair", plan: analyzeRepair(db, entryId) };
  const applied = findAppliedRepair(db, dbPath, entryId);
  if (applied) {
    return {
      status: "noop",
      entryId,
      backupPath: applied.backupPath,
      backup: applied.backup,
      fingerprintBefore: applied.backup.fingerprintBefore,
      fingerprintAfter: applied.appliedState.fingerprint,
    };
  }
  fail(`No entry with id ${entryId}, and no matching applied repair receipt.`);
};

export const analyzeRestore = (db, dbPath, backup) => {
  const schema = assertSchema(db);
  if (path.resolve(backup.databasePath) !== dbPath) {
    fail(`Backup belongs to a different database path: ${backup.databasePath}`);
  }
  if (
    JSON.stringify(schema.entryColumns) !==
      JSON.stringify(backup.entryColumns) ||
    JSON.stringify(schema.threadColumns) !==
      JSON.stringify(backup.threadColumns)
  ) {
    fail("Database schema no longer matches the repair backup.");
  }
  for (const row of backup.deletedEntries) {
    const existing = db
      .prepare("SELECT 1 FROM runtime_thread_entries WHERE entry_id = ?")
      .get(row.entry_id);
    if (existing)
      fail(`Cannot restore: deleted entry ${row.entry_id} already exists.`);
    const sequenceOwner = db
      .prepare(
        "SELECT entry_id FROM runtime_thread_entries WHERE insertion_sequence = ?",
      )
      .get(row.insertion_sequence);
    if (sequenceOwner)
      fail(
        `Cannot restore: insertion_sequence ${row.insertion_sequence} is occupied.`,
      );
  }
  for (const reparent of backup.reparentedChildren) {
    const current = db
      .prepare(
        `SELECT ${selectColumns(backup.entryColumns)} FROM runtime_thread_entries WHERE entry_id = ?`,
      )
      .get(reparent.before.entry_id);
    if (!current)
      fail(
        `Cannot restore: reparented child ${reparent.before.entry_id} is missing.`,
      );
    for (const column of backup.entryColumns) {
      const expected =
        column === "parent_entry_id"
          ? reparent.afterParentEntryId
          : reparent.before[column];
      if (!Object.is(current[column], expected)) {
        fail(
          `Cannot restore: child ${reparent.before.entry_id}.${column} changed after repair.`,
        );
      }
    }
  }
  const thread = db
    .prepare(
      `SELECT ${selectColumns(backup.threadColumns)} FROM runtime_threads WHERE thread_key = ?`,
    )
    .get(backup.threadBefore.thread_key);
  if (!thread) fail("Cannot restore: runtime_threads row is missing.");
  if (!Object.is(thread.summary, backup.threadSummaryAfter)) {
    fail("Cannot restore: runtime_threads.summary changed after repair.");
  }
  const rows = loadThreadEntries(
    db,
    backup.threadBefore.thread_key,
    backup.entryColumns,
  );
  buildTopology(rows);
  const fingerprint = fingerprintSnapshot({
    entryColumns: backup.entryColumns,
    threadColumns: backup.threadColumns,
    rows,
    thread,
  });
  if (fingerprint !== backup.fingerprintAfter) {
    fail(
      `Cannot restore: database fingerprint changed after repair (expected ${backup.fingerprintAfter}, received ${fingerprint}).`,
    );
  }
  return { schema, thread, fingerprint };
};

export const applyRestorePlan = (db, backup, restorePlan) => {
  if (!db.isTransaction) {
    fail("applyRestorePlan requires an active BEGIN IMMEDIATE transaction.");
  }
  const currentFingerprint = fingerprintSnapshot({
    entryColumns: backup.entryColumns,
    threadColumns: backup.threadColumns,
    rows: loadThreadEntries(
      db,
      backup.threadBefore.thread_key,
      backup.entryColumns,
    ),
    thread: loadThreadRow(
      db,
      backup.threadBefore.thread_key,
      backup.threadColumns,
    ),
  });
  if (currentFingerprint !== restorePlan.fingerprint) {
    fail(
      `Restore CAS fingerprint conflict: expected ${restorePlan.fingerprint}, received ${currentFingerprint}. Re-run the restore dry run.`,
    );
  }
  const insert = db.prepare(
    `INSERT INTO runtime_thread_entries (${selectColumns(backup.entryColumns)})
     VALUES (${backup.entryColumns.map(() => "?").join(", ")})`,
  );
  // Recreate ancestors before dependent checkpoints so restore remains valid
  // if v2 later adds a parent-entry foreign key.
  for (const row of rowsParentsFirst(backup.deletedEntries)) {
    const result = insert.run(
      ...backup.entryColumns.map((column) => row[column]),
    );
    if (result.changes !== 1)
      fail(`Restore insert failed for ${row.entry_id}.`);
  }
  const updateParent = db.prepare(
    `UPDATE runtime_thread_entries SET parent_entry_id = ?
     WHERE entry_id = ? AND thread_key = ? AND parent_entry_id IS ?`,
  );
  for (const reparent of backup.reparentedChildren) {
    const result = updateParent.run(
      reparent.before.parent_entry_id,
      reparent.before.entry_id,
      reparent.before.thread_key,
      reparent.afterParentEntryId,
    );
    if (result.changes !== 1)
      fail(`Restore CAS failed for child ${reparent.before.entry_id}.`);
  }
  if (!Object.is(backup.threadBefore.summary, backup.threadSummaryAfter)) {
    const result = db
      .prepare(
        `UPDATE runtime_threads SET summary = ?
         WHERE thread_key = ? AND summary IS ?`,
      )
      .run(
        backup.threadBefore.summary,
        backup.threadBefore.thread_key,
        backup.threadSummaryAfter,
      );
    if (result.changes !== 1)
      fail("Restore CAS failed for runtime_threads.summary.");
  }

  const restoredRows = loadThreadEntries(
    db,
    backup.threadBefore.thread_key,
    backup.entryColumns,
  );
  buildTopology(restoredRows);
  const restoredById = new Map(restoredRows.map((row) => [row.entry_id, row]));
  for (const row of backup.deletedEntries) {
    if (!rowMatches(restoredById.get(row.entry_id), row, backup.entryColumns)) {
      fail(`Restored entry ${row.entry_id} does not match its backup.`);
    }
  }
  for (const reparent of backup.reparentedChildren) {
    if (
      !rowMatches(
        restoredById.get(reparent.before.entry_id),
        reparent.before,
        backup.entryColumns,
      )
    ) {
      fail(
        `Restored child ${reparent.before.entry_id} does not match its backup.`,
      );
    }
  }
  const restoredThread = loadThreadRow(
    db,
    backup.threadBefore.thread_key,
    backup.threadColumns,
  );
  if (!Object.is(restoredThread?.summary, backup.threadBefore.summary)) {
    fail("Restored runtime_threads.summary does not match its backup.");
  }
  const restoredFingerprint = fingerprintSnapshot({
    entryColumns: backup.entryColumns,
    threadColumns: backup.threadColumns,
    rows: restoredRows,
    thread: restoredThread,
  });
  if (restoredFingerprint !== backup.fingerprintBefore) {
    fail(
      `Restore verification fingerprint mismatch: expected ${backup.fingerprintBefore}, received ${restoredFingerprint}.`,
    );
  }
  return restorePlan;
};

export const buildRepairReport = ({
  dbPath,
  outcome,
  mode,
  status,
  backupPath,
}) => {
  if (outcome.status === "noop") {
    return {
      reportVersion: REPORT_VERSION,
      operation: "repair-stub-compaction-checkpoint",
      mode,
      status: "noop-already-applied",
      databasePath: dbPath,
      targetEntryId: outcome.entryId,
      receiptPath: outcome.backupPath,
      fingerprints: {
        before: outcome.fingerprintBefore,
        current: outcome.fingerprintAfter,
      },
      mutated: false,
    };
  }

  const plan = outcome.plan;
  return {
    reportVersion: REPORT_VERSION,
    operation: "repair-stub-compaction-checkpoint",
    mode,
    status,
    databasePath: dbPath,
    targetEntryId: plan.entryId,
    threadKey: plan.target.thread_key,
    writtenAt: plan.target.timestamp_iso,
    eligibility: plan.eligibility,
    fingerprints: {
      before: plan.fingerprintBefore,
      after: plan.fingerprintAfter,
    },
    fallbackCheckpoint: {
      entryId: plan.previous.entry_id,
      summaryChars: plan.previousSummary.length,
    },
    affectedOverlayIds: plan.affected.map((row) => row.entry_id),
    reparents: plan.reparents.map((item) => ({
      entryId: item.before.entry_id,
      fromParentEntryId: item.before.parent_entry_id,
      toParentEntryId: item.afterParentEntryId,
    })),
    durableHistory: {
      rawRowsDeleted: 0,
      topologyVerified: status === "committed",
      storedInTargetRange: plan.counts.storedInTargetRange,
      newlyExposedThroughDependentBoundary:
        plan.counts.newlyExposedThroughDependentBoundary,
    },
    threadSummary: Object.is(plan.thread.summary, plan.threadSummaryAfter)
      ? { action: "preserve" }
      : { action: "restore-fallback", fromEntryId: plan.previous.entry_id },
    ...(backupPath ? { backupPath } : {}),
    mutated: status === "committed",
    ...(mode === "dry-run"
      ? {
          applyRequirements: [
            "--apply",
            "--confirm-stella-stopped",
            `--expect-fingerprint ${plan.fingerprintBefore}`,
          ],
        }
      : {}),
  };
};

const buildRestoreReport = ({
  dbPath,
  backupPath,
  backup,
  plan,
  mode,
  status,
}) => ({
  reportVersion: REPORT_VERSION,
  operation: "restore-stub-compaction-checkpoint-repair",
  mode,
  status,
  databasePath: dbPath,
  backupPath,
  targetEntryId: backup.targetEntryId,
  fingerprints: {
    current: plan.fingerprint,
    restored: backup.fingerprintBefore,
  },
  entriesRestored: backup.deletedEntries.length,
  childrenRestored: backup.reparentedChildren.length,
  mutated: status === "committed",
  ...(mode === "dry-run"
    ? {
        applyRequirements: [
          "--apply",
          "--confirm-stella-stopped",
          `--expect-fingerprint ${plan.fingerprint}`,
        ],
      }
    : {}),
});

const printReport = (report) => {
  console.log(JSON.stringify(report, null, 2));
};

const assertExpectedFingerprint = (provided, accepted) => {
  if (!provided) {
    fail("Refusing --apply without --expect-fingerprint from a fresh dry run.");
  }
  if (!/^[a-f0-9]{64}$/u.test(provided)) {
    fail("--expect-fingerprint must be a lowercase SHA-256 value.");
  }
  if (!accepted.includes(provided)) {
    fail(
      `CAS fingerprint conflict: expected one of ${accepted.join(", ")}, received ${provided}. Re-run the dry run.`,
    );
  }
};

export const runImmediateTransaction = (db, work) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const runLocked = (db, dbPath, work) =>
  runImmediateTransaction(db, () => {
    assertNoActiveDatabaseHolders(dbPath, [process.pid]);
    return work();
  });

export const main = (argv = process.argv.slice(2)) => {
  const dbPath = resolveExistingRegularFile(readFlag(argv, "db"), "Database");
  const entryId = readFlag(argv, "entry");
  const restoreInput = readFlag(argv, "restore");
  const expectedFingerprint = readFlag(argv, "expect-fingerprint");
  const apply = hasFlag(argv, "apply");
  const confirmedStopped = hasFlag(argv, "confirm-stella-stopped");
  if (Boolean(entryId) === Boolean(restoreInput)) {
    fail("Pass exactly one of --entry <id> or --restore <backup.json>.");
  }
  if (apply && !confirmedStopped) {
    fail("Refusing --apply without --confirm-stella-stopped.");
  }
  if (apply && !expectedFingerprint) {
    fail("Refusing --apply without --expect-fingerprint from a fresh dry run.");
  }
  if (apply) assertNoActiveDatabaseHolders(dbPath);

  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  try {
    if (!apply) db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA foreign_keys = ON");
    if (entryId) {
      if (!apply) {
        const outcome = analyzeRepairOrNoop(db, dbPath, entryId);
        const report = buildRepairReport({
          dbPath,
          outcome,
          mode: "dry-run",
          status: "ready",
        });
        printReport(report);
        return report;
      }
      const result = runLocked(db, dbPath, () => {
        const outcome = analyzeRepairOrNoop(db, dbPath, entryId);
        if (outcome.status === "noop") {
          assertExpectedFingerprint(expectedFingerprint, [
            outcome.fingerprintBefore,
            outcome.fingerprintAfter,
          ]);
          return { outcome, repair: null };
        }
        assertExpectedFingerprint(expectedFingerprint, [
          outcome.plan.fingerprintBefore,
        ]);
        return {
          outcome,
          repair: applyRepairPlan(db, dbPath, outcome.plan),
        };
      });
      const report = buildRepairReport({
        dbPath,
        outcome: result.outcome,
        mode: "apply",
        status: result.repair ? "committed" : "noop-already-applied",
        backupPath: result.repair?.backupPath,
      });
      printReport(report);
      return report;
    }

    const backupPath = resolveExistingRegularFile(restoreInput, "Backup");
    const backup = loadBackup(backupPath);
    if (!apply) {
      const plan = analyzeRestore(db, dbPath, backup);
      const report = buildRestoreReport({
        dbPath,
        backupPath,
        backup,
        plan,
        mode: "dry-run",
        status: "ready",
      });
      printReport(report);
      return report;
    }
    const plan = runLocked(db, dbPath, () => {
      const plan = analyzeRestore(db, dbPath, backup);
      assertExpectedFingerprint(expectedFingerprint, [plan.fingerprint]);
      applyRestorePlan(db, backup, plan);
      return plan;
    });
    const report = buildRestoreReport({
      dbPath,
      backupPath,
      backup,
      plan,
      mode: "apply",
      status: "committed",
    });
    printReport(report);
    return report;
  } finally {
    db.close();
  }
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
