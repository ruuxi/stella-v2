#!/usr/bin/env node
// Repair a certified stub compaction checkpoint without deleting raw thread
// history. This is an OFFLINE utility; it is not imported by the runtime.
// Dry-run is the default. Apply requires Stella to be stopped, verifies that
// no Electron/Bun/other process still holds the DB or its WAL sidecars, takes
// BEGIN IMMEDIATE before authoritative reads, and writes a durable logical
// backup that can be reversed with --restore.
//
// RUNTIME REQUIREMENT: run this script under real Node >= 22
// (e.g. /opt/homebrew/bin/node), NOT Bun. Bun 1.3.x
// does not ship the `node:sqlite` module this script depends on.
//
// Repair:
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db /offline/copy/stella.sqlite --entry <stub-entry-id>
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db /offline/copy/stella.sqlite --entry <stub-entry-id> \
//     --apply --confirm-stella-stopped --authorization-token <dry-run-token>
//
// Restore a repair from its JSON backup (dry-run first, then apply):
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db /offline/copy/stella.sqlite --restore <backup.json>
//   node packages/runtime/scripts/repair-stub-compaction-checkpoint.mjs \
//     --db /offline/copy/stella.sqlite --restore <backup.json> \
//     --apply --confirm-stella-stopped --authorization-token <dry-run-token>

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { validateThreadSummary } from "../kernel/thread-summary-validation.js";

const CERTIFIED_STUB_MAX_SUMMARY_CHARS = 200;
const CERTIFIED_STUB_MIN_TOKENS_BEFORE = 10_000;
const CERTIFIED_STUB_PATTERN = /^## Topic\n[\x20-\x7e]{1,180}$/u;
const CERTIFIED_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BACKUP_VERSION = 4;
const REPORT_VERSION = 3;
const AUTHORIZATION_VERSION = 2;
const AUTHORIZATION_PREFIX = "stella-offline-plan-v2";
const LSOF_PATH = "/usr/sbin/lsof";
const DATABASE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];
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
const REQUIRED_THREAD_COLUMNS = ["thread_key", "summary", "agent_type"];
const MUTATING_SQL_PATTERN = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu;
const PROTECTED_MUTATION_TABLES = new Set([
  "runtime_thread_entries",
  "runtime_threads",
]);
// These are the exact trigger definitions installed by database-init.ts.
// A newly added or locally modified mutating trigger must be reviewed and
// added deliberately; dry-run authorization never blesses an unknown one.
const CERTIFIED_MUTATING_TRIGGER_DIGESTS = new Map([
  [
    "trg_runtime_thread_entries_sequence",
    "ff631f34e62f3ee290526bbd67ef6375cd2f271d9ca1d0dcacaac4463e26b32f",
  ],
  [
    "trg_thread_search_fts_thread_delete",
    "2a9bbda2ee9e3ed91bd05c011e30f621a377f2041d173932298a5399d99d4781",
  ],
  [
    "trg_thread_search_fts_thread_insert",
    "0846849f8d22f83a56db7b0f723903db4a924df7c802e77d738d162b0fd0ab86",
  ],
  [
    "trg_thread_search_fts_thread_update",
    "72aab06d73f24d1c675238f4801e4f326928b4de946fd7aa545d393dc24a57da",
  ],
]);

const fail = (message) => {
  throw new Error(message);
};

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const isCanonicalRecord = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const canonicalize = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("Cannot canonicalize a non-finite number.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") {
    return { $sqliteBigInt: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return {
      $sqliteBlob: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("hex"),
    };
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isCanonicalRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  fail(`Cannot canonicalize value of type ${typeof value}.`);
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256Canonical = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const pathIsWithin = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

/**
 * This utility is deliberately incapable of targeting Rahul's installed
 * Stella tree or its live data root. Operators must first make an offline
 * copy elsewhere; stopped-app confirmation and holder checks remain required
 * for writes to that copy.
 */
const findInodeWithin = (root, targetStat) => {
  if (!fs.existsSync(root)) return undefined;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) continue;
    if (stat.dev === targetStat.dev && stat.ino === targetStat.ino) {
      return current;
    }
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(current)) {
      pending.push(path.join(current, name));
    }
  }
  return undefined;
};

const lstatIfPresent = (candidate) => {
  try {
    return fs.lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
};

export const assertOfflineDatabasePath = (candidate, options = {}) => {
  const protectedRoots = (
    options.protectedRoots ?? [
      path.join(os.homedir(), "stella"),
      path.join(os.homedir(), ".stella"),
    ]
  ).map((root) => path.resolve(root));
  const rejectProtected = (resolved) => {
    const protectedRoot = protectedRoots.find((root) =>
      pathIsWithin(resolved, root),
    );
    if (!protectedRoot) return;
    fail(
      `Refusing live Stella path ${resolved}; copy the database outside ${protectedRoot} before using this offline utility.`,
    );
  };
  const absolute = path.resolve(candidate);
  // Reject lexical live paths before any stat/read against them. Existing
  // offline paths are then resolved once more to catch symlinks into live.
  rejectProtected(absolute);
  const lexicalStat = lstatIfPresent(absolute);
  if (lexicalStat?.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(absolute);
    rejectProtected(path.resolve(path.dirname(absolute), linkTarget));
  }
  let canonical = absolute;
  if (lexicalStat) {
    try {
      canonical = fs.realpathSync(absolute);
    } catch (error) {
      fail(
        `Refusing unresolved filesystem alias ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  rejectProtected(canonical);
  if (lexicalStat) {
    const stat = fs.statSync(canonical, { bigint: true });
    if (stat.nlink > 1n) {
      for (const protectedRoot of protectedRoots) {
        const alias = findInodeWithin(protectedRoot, stat);
        if (alias) {
          fail(
            `Refusing hard-linked alias ${canonical}; the same inode exists under protected Stella path ${alias}.`,
          );
        }
      }
    }
  }
  return canonical;
};

export const assertOfflineDatabaseBundle = (candidate, options = {}) => {
  const dbPath = assertOfflineDatabasePath(candidate, options);
  for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${dbPath}${suffix}`;
    if (!lstatIfPresent(sidecarPath)) continue;
    const canonicalSidecar = assertOfflineDatabasePath(sidecarPath, options);
    if (!fs.statSync(canonicalSidecar).isFile()) {
      fail(`Database sidecar is not a regular file: ${sidecarPath}`);
    }
  }
  return dbPath;
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
  const candidates = [
    dbPath,
    ...DATABASE_SIDECAR_SUFFIXES.map((suffix) => `${dbPath}${suffix}`),
  ].filter((candidate) => fs.existsSync(candidate));
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

const canonicalDdl = (sql) =>
  String(sql)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .trim();

const loadCanonicalSchemaObjects = (db) =>
  db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
         AND sql IS NOT NULL
       ORDER BY type, name, tbl_name`,
    )
    .all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: canonicalDdl(row.sql),
    }));

const assertCertifiedMutatingTriggers = (schemaObjects) => {
  for (const object of schemaObjects) {
    if (
      object.type !== "trigger" ||
      !PROTECTED_MUTATION_TABLES.has(object.table) ||
      !MUTATING_SQL_PATTERN.test(object.sql)
    ) {
      continue;
    }
    const expected = CERTIFIED_MUTATING_TRIGGER_DIGESTS.get(object.name);
    const actual = sha256Canonical(object.sql);
    if (!expected || expected !== actual) {
      fail(
        `Refusing unknown or modified mutating trigger ${object.name} on ${object.table}.`,
      );
    }
  }
};

const assertSchema = (db) => {
  const entryColumns = tableColumns(db, "runtime_thread_entries");
  const threadColumns = tableColumns(db, "runtime_threads");
  for (const column of REQUIRED_ENTRY_COLUMNS) {
    if (!entryColumns.includes(column))
      fail(`Database is missing runtime_thread_entries.${column}.`);
  }
  for (const column of REQUIRED_THREAD_COLUMNS) {
    if (!threadColumns.includes(column)) {
      fail(`Database is missing runtime_threads.${column}.`);
    }
  }
  const schemaObjects = loadCanonicalSchemaObjects(db);
  assertCertifiedMutatingTriggers(schemaObjects);
  return {
    entryColumns,
    threadColumns,
    ddlDigest: sha256Canonical(schemaObjects),
    schemaObjects,
  };
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
  if (!isPlainObject(data)) {
    fail(`Entry ${row.entry_id} data_json must be a JSON object.`);
  }
  return data;
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

const digestQueryRows = (db, sql, parameters = []) => {
  const rows = db.prepare(sql).all(...parameters);
  return {
    count: rows.length,
    digest: sha256Canonical(rows),
  };
};

const digestWholeTable = (db, table) => {
  const identifier = quoteIdentifier(table);
  try {
    return digestQueryRows(db, `SELECT * FROM ${identifier} ORDER BY rowid`);
  } catch {
    const columns = tableColumns(db, table);
    if (columns.length === 0) {
      fail(`Cannot fingerprint out-of-plan table ${table}.`);
    }
    return digestQueryRows(
      db,
      `SELECT * FROM ${identifier} ORDER BY ${selectColumns(columns)}`,
    );
  }
};

const captureOutOfPlanState = (db, plan) => {
  const schema = assertSchema(db);
  const currentSchemaIdentity = schemaIdentity(schema);
  if (
    canonicalJson(currentSchemaIdentity) !== canonicalJson(plan.schemaIdentity)
  ) {
    fail("Database schema changed after the authorized plan was assembled.");
  }
  const plannedIds = [...plan.plannedEntryIds].sort();
  const placeholders = plannedIds.map(() => "?").join(", ");
  const entryWhere = plannedIds.length
    ? `WHERE entry_id NOT IN (${placeholders})`
    : "";
  const otherTables = Object.fromEntries(
    schema.schemaObjects
      .filter(
        (object) =>
          object.type === "table" &&
          !PROTECTED_MUTATION_TABLES.has(object.name),
      )
      .map((object) => [object.name, digestWholeTable(db, object.name)]),
  );
  return {
    schemaIdentity: currentSchemaIdentity,
    entries: digestQueryRows(
      db,
      `SELECT ${selectColumns(schema.entryColumns)}
       FROM runtime_thread_entries ${entryWhere}
       ORDER BY entry_id`,
      plannedIds,
    ),
    threads: digestQueryRows(
      db,
      `SELECT ${selectColumns(schema.threadColumns)}
       FROM runtime_threads
       WHERE thread_key <> ?
       ORDER BY thread_key`,
      [plan.targetThreadKey],
    ),
    otherTables,
  };
};

const assertOutOfPlanUnchanged = (before, after) => {
  if (canonicalJson(before) === canonicalJson(after)) return;
  const changed = [];
  if (
    canonicalJson(before.schemaIdentity) !== canonicalJson(after.schemaIdentity)
  )
    changed.push("sqlite_schema");
  if (canonicalJson(before.entries) !== canonicalJson(after.entries))
    changed.push("runtime_thread_entries outside the planned row set");
  if (canonicalJson(before.threads) !== canonicalJson(after.threads))
    changed.push("runtime_threads outside the target thread");
  const names = new Set([
    ...Object.keys(before.otherTables),
    ...Object.keys(after.otherTables),
  ]);
  for (const name of [...names].sort()) {
    if (
      canonicalJson(before.otherTables[name]) !==
      canonicalJson(after.otherTables[name])
    ) {
      changed.push(name);
    }
  }
  fail(`Out-of-plan database rows changed: ${changed.join(", ")}.`);
};

const databaseIdentity = (dbPath) => {
  const canonicalPath = fs.realpathSync(dbPath);
  const stat = fs.statSync(canonicalPath, { bigint: true });
  return {
    canonicalPath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
  };
};

const authorizationToken = (payload) =>
  `${AUTHORIZATION_PREFIX}.${sha256Canonical(payload)}`;

const schemaIdentity = (schema) => ({
  entryColumns: schema.entryColumns,
  threadColumns: schema.threadColumns,
  ddlDigest: schema.ddlDigest,
});

const repairMutationSet = (plan) => ({
  deleteEntries: plan.affectedDeletionOrder.map((row) => row),
  reparentChildren: plan.reparents.map((item) => ({
    before: item.before,
    afterParentEntryId: item.afterParentEntryId,
  })),
  threadSummary: {
    threadKey: plan.target.thread_key,
    before: plan.thread.summary,
    after: plan.threadSummaryAfter,
  },
});

export const buildRepairAuthorization = (dbPath, plan) => {
  const payload = {
    version: AUTHORIZATION_VERSION,
    purpose: "stella-offline-compaction-checkpoint-mutation",
    operation: "repair",
    database: databaseIdentity(dbPath),
    target: {
      entryId: plan.entryId,
      rowDigest: sha256Canonical(plan.target),
    },
    schema: plan.schemaIdentity,
    preStateFingerprint: plan.fingerprintBefore,
    mutations: repairMutationSet(plan),
  };
  return { payload, token: authorizationToken(payload) };
};

const restoreMutationSet = (backup) => ({
  insertEntries: rowsParentsFirst(backup.deletedEntries),
  reparentChildren: backup.reparentedChildren.map((item) => ({
    entryId: item.before.entry_id,
    beforeParentEntryId: item.afterParentEntryId,
    afterParentEntryId: item.before.parent_entry_id,
  })),
  threadSummary: {
    threadKey: backup.threadBefore.thread_key,
    before: backup.threadSummaryAfter,
    after: backup.threadBefore.summary,
  },
});

export const buildRestoreAuthorization = (
  dbPath,
  backupPath,
  backup,
  restorePlan,
) => {
  const payload = {
    version: AUTHORIZATION_VERSION,
    purpose: "stella-offline-compaction-checkpoint-mutation",
    operation: "restore",
    database: databaseIdentity(dbPath),
    target: {
      entryId: backup.targetEntryId,
      receiptPath: fs.realpathSync(backupPath),
      receiptDigest: backup.receiptDigest,
    },
    schema: restorePlan.schemaIdentity,
    preStateFingerprint: restorePlan.fingerprint,
    mutations: restoreMutationSet(backup),
  };
  return { payload, token: authorizationToken(payload) };
};

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

const parentPathIncludes = (byId, startEntryId, ancestorEntryId) => {
  let current = byId.get(startEntryId);
  while (current) {
    if (current.entry_id === ancestorEntryId) return true;
    current =
      current.parent_entry_id === null
        ? undefined
        : byId.get(current.parent_entry_id);
  }
  return false;
};

const assertCheckpointRangeParentAncestry = (row, range, byId, label) => {
  if (
    row.parent_entry_id === null ||
    !parentPathIncludes(byId, row.parent_entry_id, range.toEntryId)
  ) {
    fail(
      `Refusing: ${label} ${row.entry_id} toEntryId ${range.toEntryId} is not on its authoritative parent chain.`,
    );
  }
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

const strictCompactionRange = (entryId, data) => {
  const { fromEntryId, toEntryId } = data;
  if (
    typeof fromEntryId !== "string" ||
    typeof toEntryId !== "string" ||
    !fromEntryId ||
    !toEntryId ||
    fromEntryId !== fromEntryId.trim() ||
    toEntryId !== toEntryId.trim() ||
    fromEntryId === toEntryId ||
    !CERTIFIED_ENTRY_ID_PATTERN.test(fromEntryId) ||
    !CERTIFIED_ENTRY_ID_PATTERN.test(toEntryId)
  ) {
    fail(
      `Refusing: compaction ${entryId} has a malformed or ambiguous fromEntryId/toEntryId range.`,
    );
  }
  return { fromEntryId, toEntryId };
};

const strictTokensBefore = (entryId, data) => {
  const value = data.tokensBefore;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail(
      `Refusing: compaction ${entryId} tokensBefore must be a finite non-negative safe integer.`,
    );
  }
  return value;
};

const strictSummary = (entryId, data) => {
  if (typeof data.summary !== "string") {
    fail(`Refusing: compaction ${entryId} summary must be a string.`);
  }
  return data.summary;
};

const strictSummaryValidationInput = (entryId, data) => {
  if (!("summaryValidation" in data)) {
    fail(
      `Refusing: legacy compaction ${entryId} is unsupported because it lacks authoritative folded-span and previous-summary validation inputs.`,
    );
  }
  const input = data.summaryValidation;
  const keys = isPlainObject(input) ? Object.keys(input).sort() : [];
  if (
    !isPlainObject(input) ||
    canonicalJson(keys) !==
      canonicalJson(["middleTokens", "previousSummary", "version"]) ||
    input.version !== 1 ||
    typeof input.middleTokens !== "number" ||
    !Number.isFinite(input.middleTokens) ||
    !Number.isSafeInteger(input.middleTokens) ||
    input.middleTokens < 0 ||
    (input.previousSummary !== null &&
      typeof input.previousSummary !== "string")
  ) {
    fail(
      `Refusing: compaction ${entryId} has malformed or ambiguous summaryValidation inputs.`,
    );
  }
  return {
    middleTokens: input.middleTokens,
    previousSummary: input.previousSummary ?? undefined,
  };
};

// v2 now persists both acceptance inputs. Older checkpoints do not contain
// enough information to replay the runtime validator: tokensBefore is the
// whole-thread estimate, not the folded middle span, and the previous summary
// was not recorded. Committed forensic evidence identifies the damaged target
// and a predecessor ID/length, but not the predecessor's exact summary, full
// row digest, or runtime inputs. That is insufficient to authorize a byte-exact
// fallback, so all legacy checkpoints are explicitly unsupported.

const validatePersistedCheckpointSummary = (entryId, data) => {
  const summary = strictSummary(entryId, data);
  const validationInput = strictSummaryValidationInput(entryId, data);
  return {
    summary,
    validationInput,
    runtimeValidation: validateThreadSummary(
      summary,
      validationInput.middleTokens,
      validationInput.previousSummary,
    ),
  };
};

export const classifyCertifiedStubCheckpoint = (entryId, data) => {
  if (!isPlainObject(data)) {
    fail(`Refusing: compaction ${entryId} data must be a plain object.`);
  }
  const summary = strictSummary(entryId, data);
  const tokensBefore = strictTokensBefore(entryId, data);
  const range = strictCompactionRange(entryId, data);
  const validationInput = strictSummaryValidationInput(entryId, data);
  const runtimeValidation = validateThreadSummary(
    summary,
    validationInput.middleTokens,
    validationInput.previousSummary,
  );
  if (runtimeValidation.valid) {
    fail(
      "Refusing: target summary satisfies the runtime acceptance validator and must not be repaired.",
    );
  }
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
  if (!CERTIFIED_STUB_PATTERN.test(summary)) {
    fail(
      "Refusing: target summary does not match the exact certified ASCII stub signature.",
    );
  }
  return {
    summary,
    tokensBefore,
    ...range,
    runtimeValidation,
    validationInput,
  };
};

export const analyzeRepair = (db, entryId) => {
  const schema = assertSchema(db);
  const { entryColumns, threadColumns } = schema;
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
  const {
    summary,
    tokensBefore,
    fromEntryId,
    toEntryId,
    runtimeValidation,
    validationInput,
  } = classifyCertifiedStubCheckpoint(target.entry_id, targetData);
  // The only automatically repairable corruption is the exact certified v1
  // shape: one short ASCII `## Topic` fragment over a large explicit range.
  // The ASCII signature intentionally rejects Unicode normalization tricks,
  // format/invisible code points, extra headings, and ambiguous whitespace.
  const rows = loadThreadEntries(db, target.thread_key, entryColumns);
  const { byId, children } = buildTopology(rows);
  assertCheckpointRangeParentAncestry(
    target,
    { fromEntryId, toEntryId },
    byId,
    "target compaction",
  );
  const ancestors = ancestorRows(target, byId);
  const previous = ancestors.find((candidate) => {
    if (candidate.entry_type !== "compaction") return false;
    const data = parseCompactionData(candidate);
    strictTokensBefore(candidate.entry_id, data);
    strictCompactionRange(candidate.entry_id, data);
    return validatePersistedCheckpointSummary(candidate.entry_id, data)
      .runtimeValidation.valid;
  });
  if (!previous)
    fail(
      "No earlier healthy checkpoint exists on the target's authoritative parent path.",
    );
  const previousData = parseCompactionData(previous);
  const previousSummary = strictSummary(previous.entry_id, previousData);
  const previousRange = strictCompactionRange(previous.entry_id, previousData);
  assertCheckpointRangeParentAncestry(
    previous,
    previousRange,
    byId,
    "fallback compaction",
  );
  const previousTo = byId.get(previousRange.toEntryId);
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
    const range = strictCompactionRange(candidate.entry_id, data);
    strictSummary(candidate.entry_id, data);
    strictTokensBefore(candidate.entry_id, data);
    assertCheckpointRangeParentAncestry(
      candidate,
      range,
      byId,
      "dependent compaction",
    );
    if (range.fromEntryId !== fromEntryId) {
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
  if (thread.agent_type !== "orchestrator") {
    fail(
      `Refusing: certified checkpoint repair only applies to orchestrator threads, received ${thread.agent_type}.`,
    );
  }
  const removedSummaries = new Set(
    affected.map((row) =>
      strictSummary(row.entry_id, parseCompactionData(row)),
    ),
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
    strictCompactionRange(
      latestAffected.entry_id,
      parseCompactionData(latestAffected),
    ).toEntryId,
  );
  if (!latestAffectedTo) {
    fail(
      `Affected checkpoint ${latestAffected.entry_id} has an invalid toEntryId.`,
    );
  }
  const targetFrom = byId.get(fromEntryId);
  const targetTo = byId.get(toEntryId);
  if (!targetFrom || !targetTo)
    fail("Target compaction range points outside its thread.");
  if (!validationInput.previousSummary) {
    fail(
      "Refusing fallback: target summaryValidation.previousSummary is null or empty.",
    );
  }
  if (!Object.is(validationInput.previousSummary, previousSummary)) {
    fail(
      "Refusing fallback: target summaryValidation.previousSummary is not byte-exactly equal to the chosen ancestor summary.",
    );
  }
  if (previousRange.fromEntryId !== fromEntryId) {
    fail(
      "Refusing fallback: target and chosen ancestor have incompatible fromEntryId values.",
    );
  }
  if (
    !parentPathIncludes(byId, targetTo.entry_id, previousTo.entry_id) ||
    !parentPathIncludes(byId, previousTo.entry_id, targetFrom.entry_id)
  ) {
    fail(
      "Refusing fallback: chosen ancestor range is incompatible with the target's authoritative parent topology.",
    );
  }

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
    schemaIdentity: schemaIdentity(schema),
    targetThreadKey: target.thread_key,
    target,
    targetData,
    rows,
    affected,
    affectedDeletionOrder,
    affectedIds,
    previous,
    previousSummary,
    reparents,
    plannedEntryIds: new Set([
      ...affected.map((row) => row.entry_id),
      ...reparents.map((item) => item.before.entry_id),
    ]),
    thread,
    threadSummaryAfter,
    metadataBelongsToAffectedOverlay,
    fingerprintBefore,
    fingerprintAfter,
    eligibility: {
      classifier: "certified-v1-ascii-topic-stub-v3",
      summaryChars: summary.length,
      tokensBefore,
      foldedSpanTokens: validationInput?.middleTokens ?? null,
      previousSummaryChars: validationInput?.previousSummary?.length ?? null,
      explicitRange: true,
      runtimeValidationReason: runtimeValidation.reason,
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

export const writeDurableJson = (filePath, value, options = {}) => {
  const fsyncSync = options.fsyncSync ?? fs.fsyncSync;
  let fd;
  let directoryFd;
  let created = false;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    directoryFd = fs.openSync(path.dirname(filePath), "r");
    fsyncSync(directoryFd);
    fs.closeSync(directoryFd);
    directoryFd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (directoryFd !== undefined) {
      try {
        fs.closeSync(directoryFd);
      } catch {}
    }
    // A receipt is authoritative only after file and directory fsync both
    // succeed. Remove a partial/orphan artifact so discovery cannot later
    // mistake it for a committed repair. Cleanup failure is surfaced too.
    let cleanupError;
    if (created) {
      try {
        fs.rmSync(filePath, { force: true });
        const cleanupDirectoryFd = fs.openSync(path.dirname(filePath), "r");
        try {
          fs.fsyncSync(cleanupDirectoryFd);
        } finally {
          fs.closeSync(cleanupDirectoryFd);
        }
      } catch (candidate) {
        cleanupError = candidate;
      }
    }
    const original = error instanceof Error ? error.message : String(error);
    if (cleanupError) {
      const cleanup =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      fail(
        `Durable receipt write failed (${original}) and orphan cleanup failed (${cleanup}): ${filePath}`,
      );
    }
    fail(
      created
        ? `Durable receipt write failed; incomplete artifact removed: ${original}`
        : `Durable receipt write failed before artifact creation: ${original}`,
    );
  }
};

export const createReceiptDigest = (receiptCore) =>
  sha256Canonical(receiptCore);

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
  options = {},
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
  const outOfPlanBefore = captureOutOfPlanState(db, plan);
  const repairAuthorization = buildRepairAuthorization(dbPath, plan);
  const backupCore = {
    version: BACKUP_VERSION,
    kind: "stella-stub-checkpoint-repair",
    databasePath: dbPath,
    databaseIdentity: databaseIdentity(dbPath),
    createdAt: new Date().toISOString(),
    entryColumns: plan.entryColumns,
    threadColumns: plan.threadColumns,
    schemaIdentity: plan.schemaIdentity,
    targetEntryId: plan.entryId,
    deletedEntries: plan.affected,
    reparentedChildren: plan.reparents,
    threadBefore: plan.thread,
    threadSummaryAfter: plan.threadSummaryAfter,
    fingerprintBefore: plan.fingerprintBefore,
    fingerprintAfter: plan.fingerprintAfter,
    counts: plan.counts,
    repairAuthorizationToken: repairAuthorization.token,
  };
  const backup = {
    ...backupCore,
    receiptDigest: createReceiptDigest(backupCore),
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
  const outOfPlanAfter = captureOutOfPlanState(db, plan);
  assertOutOfPlanUnchanged(outOfPlanBefore, outOfPlanAfter);
  // The verified transaction is still uncommitted here. Persist and fsync its
  // reversible preimage before the caller may COMMIT; a backup write failure
  // therefore rolls the SQLite changes back instead of committing unrecoverably.
  writeDurableJson(backupPath, backup, options.writeOptions);
  return { backupPath, backup, noop: false };
};

export const loadBackup = (backupPath) => {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  } catch (error) {
    fail(
      `Could not parse repair receipt ${backupPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isPlainObject(value) ||
    value?.version !== BACKUP_VERSION ||
    value?.kind !== "stella-stub-checkpoint-repair"
  ) {
    fail(`Unsupported repair backup: ${backupPath}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(value.receiptDigest ?? "")) {
    fail(`Repair receipt has no canonical digest: ${backupPath}`);
  }
  const { receiptDigest, ...receiptCore } = value;
  const actualDigest = createReceiptDigest(receiptCore);
  if (actualDigest !== receiptDigest) {
    fail(
      `Repair receipt digest mismatch: expected ${receiptDigest}, received ${actualDigest}.`,
    );
  }
  if (
    !isPlainObject(value.databaseIdentity) ||
    typeof value.databaseIdentity.canonicalPath !== "string" ||
    typeof value.databaseIdentity.device !== "string" ||
    typeof value.databaseIdentity.inode !== "string" ||
    typeof value.targetEntryId !== "string" ||
    !Array.isArray(value.entryColumns) ||
    !value.entryColumns.every((column) => typeof column === "string") ||
    !Array.isArray(value.threadColumns) ||
    !value.threadColumns.every((column) => typeof column === "string") ||
    !isPlainObject(value.schemaIdentity) ||
    !Array.isArray(value.schemaIdentity.entryColumns) ||
    !value.schemaIdentity.entryColumns.every(
      (column) => typeof column === "string",
    ) ||
    !Array.isArray(value.schemaIdentity.threadColumns) ||
    !value.schemaIdentity.threadColumns.every(
      (column) => typeof column === "string",
    ) ||
    !/^[a-f0-9]{64}$/u.test(value.schemaIdentity.ddlDigest ?? "") ||
    canonicalJson(value.entryColumns) !==
      canonicalJson(value.schemaIdentity.entryColumns) ||
    canonicalJson(value.threadColumns) !==
      canonicalJson(value.schemaIdentity.threadColumns) ||
    !Array.isArray(value.deletedEntries) ||
    !Array.isArray(value.reparentedChildren) ||
    !isPlainObject(value.threadBefore) ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprintBefore ?? "") ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprintAfter ?? "") ||
    !new RegExp(`^${AUTHORIZATION_PREFIX}\\.[a-f0-9]{64}$`, "u").test(
      value.repairAuthorizationToken ?? "",
    )
  ) {
    fail(`Repair receipt has malformed fields: ${backupPath}`);
  }
  return value;
};

const assertReceiptDatabaseIdentity = (dbPath, backup) => {
  const current = databaseIdentity(dbPath);
  if (canonicalJson(current) !== canonicalJson(backup.databaseIdentity)) {
    fail(
      "Repair receipt belongs to a different canonical database identity; refusing copied or replaced database.",
    );
  }
};

const analyzeAppliedRepairState = (db, dbPath, backup) => {
  const schema = assertSchema(db);
  if (path.resolve(backup.databasePath) !== dbPath) {
    fail(`Backup belongs to a different database path: ${backup.databasePath}`);
  }
  assertReceiptDatabaseIdentity(dbPath, backup);
  if (
    canonicalJson(schemaIdentity(schema)) !==
    canonicalJson(backup.schemaIdentity)
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
  if (target) {
    const plan = analyzeRepair(db, entryId);
    return {
      status: "repair",
      plan,
      authorizationToken: buildRepairAuthorization(dbPath, plan).token,
    };
  }
  const applied = findAppliedRepair(db, dbPath, entryId);
  if (applied) {
    return {
      status: "noop",
      entryId,
      backupPath: applied.backupPath,
      backup: applied.backup,
      fingerprintBefore: applied.backup.fingerprintBefore,
      fingerprintAfter: applied.appliedState.fingerprint,
      authorizationToken: applied.backup.repairAuthorizationToken,
    };
  }
  fail(`No entry with id ${entryId}, and no matching applied repair receipt.`);
};

export const analyzeRestore = (db, dbPath, backup) => {
  const schema = assertSchema(db);
  if (path.resolve(backup.databasePath) !== dbPath) {
    fail(`Backup belongs to a different database path: ${backup.databasePath}`);
  }
  assertReceiptDatabaseIdentity(dbPath, backup);
  if (
    canonicalJson(schemaIdentity(schema)) !==
    canonicalJson(backup.schemaIdentity)
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
  return {
    schema,
    schemaIdentity: schemaIdentity(schema),
    targetThreadKey: backup.threadBefore.thread_key,
    plannedEntryIds: new Set([
      ...backup.deletedEntries.map((row) => row.entry_id),
      ...backup.reparentedChildren.map((item) => item.before.entry_id),
    ]),
    thread,
    fingerprint,
  };
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
  const outOfPlanBefore = captureOutOfPlanState(db, restorePlan);
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
  const outOfPlanAfter = captureOutOfPlanState(db, restorePlan);
  assertOutOfPlanUnchanged(outOfPlanBefore, outOfPlanAfter);
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
      authorizationToken: outcome.authorizationToken,
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
    authorizationToken: outcome.authorizationToken,
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
            `--authorization-token ${outcome.authorizationToken}`,
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
  authorization,
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
  authorizationToken: authorization.token,
  entriesRestored: backup.deletedEntries.length,
  childrenRestored: backup.reparentedChildren.length,
  mutated: status === "committed",
  ...(mode === "dry-run"
    ? {
        applyRequirements: [
          "--apply",
          "--confirm-stella-stopped",
          `--authorization-token ${authorization.token}`,
        ],
      }
    : {}),
});

const printReport = (report) => {
  console.log(JSON.stringify(report, null, 2));
};

const assertAuthorizationToken = (provided, expected) => {
  if (!provided) {
    fail(
      "Refusing --apply without --authorization-token from a fresh dry run.",
    );
  }
  if (
    !new RegExp(`^${AUTHORIZATION_PREFIX}\\.[a-f0-9]{64}$`, "u").test(provided)
  ) {
    fail("--authorization-token has an invalid format.");
  }
  if (provided !== expected) {
    fail(
      "Authorization token mismatch. The database identity, operation, target, receipt, schema, pre-state, or planned mutations changed; re-run the dry run.",
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
  const dbPath = assertOfflineDatabaseBundle(
    resolveExistingRegularFile(readFlag(argv, "db"), "Database"),
  );
  const entryId = readFlag(argv, "entry");
  const restoreInput = readFlag(argv, "restore");
  const providedAuthorization = readFlag(argv, "authorization-token");
  const apply = hasFlag(argv, "apply");
  const confirmedStopped = hasFlag(argv, "confirm-stella-stopped");
  if (Boolean(entryId) === Boolean(restoreInput)) {
    fail("Pass exactly one of --entry <id> or --restore <backup.json>.");
  }
  if (apply && !confirmedStopped) {
    fail("Refusing --apply without --confirm-stella-stopped.");
  }
  if (apply && !providedAuthorization) {
    fail(
      "Refusing --apply without --authorization-token from a fresh dry run.",
    );
  }
  if (apply) assertNoActiveDatabaseHolders(dbPath);

  const backupPath = restoreInput
    ? resolveExistingRegularFile(restoreInput, "Backup")
    : undefined;
  if (backupPath) assertOfflineDatabasePath(backupPath);
  // Receipt authenticity is checked before database readiness analysis and,
  // critically, before opening the database writable.
  const backup = backupPath ? loadBackup(backupPath) : undefined;

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
          assertAuthorizationToken(
            providedAuthorization,
            outcome.authorizationToken,
          );
          return { outcome, repair: null };
        }
        assertAuthorizationToken(
          providedAuthorization,
          outcome.authorizationToken,
        );
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

    if (!backupPath || !backup) fail("Restore receipt was not loaded.");
    if (!apply) {
      const plan = analyzeRestore(db, dbPath, backup);
      const authorization = buildRestoreAuthorization(
        dbPath,
        backupPath,
        backup,
        plan,
      );
      const report = buildRestoreReport({
        dbPath,
        backupPath,
        backup,
        plan,
        authorization,
        mode: "dry-run",
        status: "ready",
      });
      printReport(report);
      return report;
    }
    const result = runLocked(db, dbPath, () => {
      const plan = analyzeRestore(db, dbPath, backup);
      const authorization = buildRestoreAuthorization(
        dbPath,
        backupPath,
        backup,
        plan,
      );
      assertAuthorizationToken(providedAuthorization, authorization.token);
      applyRestorePlan(db, backup, plan);
      return { plan, authorization };
    });
    const report = buildRestoreReport({
      dbPath,
      backupPath,
      backup,
      plan: result.plan,
      authorization: result.authorization,
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
