/**
 * Materialize the owner's drive into the turn's workspace.
 *
 * The drive (Convex rows + R2 bytes) and the sandbox workspace (a checkpoint
 * of one directory) are two views of the same files, and until this ran they
 * were disjoint: a file the user uploaded existed only in R2, so an agent told
 * "the files in your workspace are the user's files" could not read it — and,
 * asked to update it, would write a fresh one straight over the user's bytes.
 *
 * This is the read half. It runs before the tool host exists, so no
 * agent-controlled code is running while the signed URLs are live, and it is
 * best-effort: a hydration failure leaves the workspace as the checkpoint left
 * it and, because the turn then vouches for nothing, the write side refuses to
 * overwrite any upload rather than trusting a workspace it could not verify.
 *
 * It is also incremental. The restored checkpoint already holds what the last
 * turn hydrated, so hydration downloads the difference: the ledger records the
 * row version and content hash behind every file this workspace is holding —
 * downloaded now or already on disk from an earlier turn — and a file whose
 * bytes still hash to what the manifest names is left alone.
 *
 * One rule governs both ways this module can destroy a file: **the workspace
 * may only remove or truncate bytes it can prove it put there itself.** An
 * unlink and a download are the same act from the workspace's side — the
 * download opens its target with O_TRUNC — so both are held to the same proof:
 * the ledger records what this workspace hydrated for the path, and the file
 * still hashes to exactly that. A file the drive names but the workspace
 * cannot account for is somebody's work, most often the turn's own output
 * that never reached the drive, and it is reported rather than overwritten. A
 * deleted file whose copy diverged is reported as `stale`; a live file whose
 * copy diverged is reported as a conflict. Both are recoverable; neither
 * version of destroying them is.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

type DriveSyncEntry = {
  path: string;
  relativePath: string;
  sizeBytes: number;
  contentType: string;
  /** Who wrote the bytes now in the drive. */
  source: string;
  /**
   * Where the file came from, whoever wrote it last. An upload the agent has
   * since edited still reads `upload` here while `source` says `agent`, and it
   * is `origin` that decides whether the workspace copy may be believed.
   */
  origin?: string;
  updatedAt: number;
  url: string;
  /**
   * Hex sha256 of the drive object, when the manifest carries one. Server
   * truth beats the ledger: it makes "already current" a fact about the
   * drive's bytes rather than about a file inside the agent's workspace.
   */
  sha256?: string;
};

/**
 * A path the drive no longer has. `relativePath` is where the hydrated copy
 * sits under the workspace root, so applying one is a delete and nothing else.
 */
type DriveSyncTombstone = {
  path: string;
  relativePath: string;
  deletedAt: number;
};

export type DriveSyncResult = {
  /**
   * Drive path → the row version this turn read. Echoed back when the turn
   * reports its own writes: it is the whole proof that an agent replacing a
   * user's file had actually seen it.
   */
  known: Map<string, number>;
  /**
   * Of `known`, the paths whose bytes came from the user. These are the rows
   * the drive protects from a write that did not read them, so they are also
   * the only paths where re-reporting a file is destructive rather than merely
   * repetitive — the second write is read as a second writer.
   */
  uploads: Set<string>;
  /** Drive paths whose bytes are now on disk under the workspace root. */
  materialized: string[];
  /** In the drive, deliberately left out of the workspace. */
  skipped: Array<{ path: string; reason: string }>;
  /** Deleted from the drive, and now removed from the workspace too. */
  deleted: string[];
  /**
   * Deleted from the drive, but the copy on disk is no longer the copy this
   * workspace hydrated — so it holds somebody's work and was kept. The agent
   * is told instead, which is the whole of what happens to these.
   */
  stale: string[];
  /**
   * Still in the drive, and on disk — but the copy on disk is not the one this
   * workspace hydrated, so hydration left it alone instead of downloading over
   * it. `driveMoved` is whether the drive row has changed since this workspace
   * last read it, and it is the whole difference between the two cases: when
   * it has not, the copy on disk is the only version of those bytes anyone
   * has; when it has, the drive and the workspace each hold something the
   * other has never seen.
   */
  conflicts: Array<{ path: string; driveMoved: boolean }>;
};

export const emptyDriveSync = (): DriveSyncResult => ({
  known: new Map(),
  uploads: new Set(),
  materialized: [],
  skipped: [],
  deleted: [],
  stale: [],
  conflicts: [],
});

/**
 * Paths the prompt itself names, so "summarize uploads/report.pdf" hydrates
 * that file whatever else is competing for the byte budget. Deliberately
 * loose — the server intersects these with real rows, so a false positive
 * costs nothing and a miss costs the attachment the user is asking about.
 */
const PATH_LIKE = /[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.[A-Za-z0-9]{1,8}/g;

export const drivePathsInPrompt = (prompt: string): string[] => {
  const found = new Set<string>();
  for (const match of prompt.slice(0, 20_000).matchAll(PATH_LIKE)) {
    const value = match[0].replace(/[.,;:)\]]+$/, "");
    if (value.length > 0 && value.length <= 400) found.add(value);
    if (found.size >= 25) break;
  }
  return [...found];
};

/** Downloads in flight at once. The bound is the container, not the drive. */
const DOWNLOAD_CONCURRENCY = 6;
/** One stalled signed URL must not hold a slot for the whole turn. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/**
 * Total hydration budget. The server already caps the manifest at 100 files /
 * 128 MB; this caps the wall clock those cost, so a slow R2 makes a turn start
 * with fewer files rather than start late.
 */
const HYDRATE_BUDGET_MS = 90_000;
const HASH_CHUNK_BYTES = 1024 * 1024;
/** Ledger rows kept, newest row version first. */
const LEDGER_MAX_ENTRIES = 2_000;
const LEDGER_FILE = "drive-sync.json";
/** Tombstones honored per turn; the manifest is not an unbounded delete list. */
const TOMBSTONE_MAX = 500;
/**
 * Hydrated paths one sync asks the server to confirm still exist. Matches the
 * server's own ceiling. A ledger larger than this rotates across turns, which
 * is affordable precisely because the bound's cost is a delete arriving a turn
 * or two late — never a file removed on a guess.
 */
const PRESENCE_MAX = 500;

/** What this workspace last hydrated for a drive path. */
type LedgerEntry = { updatedAt: number; sizeBytes: number; sha256: string };
type Ledger = {
  files: Map<string, LedgerEntry>;
  /**
   * The `syncedAt` of the last sync this workspace fully applied, sent back as
   * `since`. It lives here rather than beside the workspace so the cursor and
   * the files it describes are checkpointed together and restored together —
   * a workspace can never be older or newer than its own cursor.
   */
  syncedAt: number;
  /**
   * The last path this workspace asked the server to confirm, so a ledger
   * larger than one presence window walks the rest on the following turns
   * instead of re-asking about the same head forever.
   */
  checkedThrough: string;
};

/**
 * The ledger lives inside the checkpointed workspace — the only place that
 * survives to the next turn — so it is agent-writable and is parsed as
 * untrusted input. It is never believed on its own: an entry only ever
 * shortcuts a download when the bytes on disk still hash to what it recorded
 * for the exact row version the server just named.
 *
 * The cursor is untrusted for a sharper reason: its failure direction is
 * subtraction. A cursor further ahead than the truth asks for *fewer*
 * deletions, so a turn that writes itself a far-future `syncedAt` would
 * otherwise suppress every tombstone that follows. Four things take that
 * away. A cursor the server cannot have issued (one from the future) is
 * clamped here; the cursor this turn keeps is whatever the server answered
 * with rather than the larger of the two, so a forged value cannot outlive
 * the turn that wrote it; deletions no longer rest on the cursor alone — the
 * sync sends the paths this workspace is holding and the server answers, per
 * path, which of them it no longer has, which is a question about the drive
 * and not about the cursor; and the server answers every sync with the drive's
 * most recent deletions whatever `since` asked for, so a suppressed cursor
 * does not suppress the tombstone.
 *
 * What none of that reaches, and what nothing here tries to reach, is an agent
 * that drops its own ledger entries to keep a copy of a file the user has
 * since deleted. That is not a hole this mechanism could close: the same agent
 * can copy the bytes to a second path in the same checkpointed tree, which no
 * tombstone will ever name. Deletion propagation is hygiene — it keeps a
 * deleted file from silently reappearing to later turns as if it were still
 * the user's — not a containment boundary, and building it as one is what put
 * the turn's own output within reach of a replayed tombstone.
 */
const readLedger = async (file: string): Promise<Ledger> => {
  const ledger: Ledger = { files: new Map(), syncedAt: 0, checkedThrough: "" };
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) return ledger;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ledger;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ledger;
  }
  const document = parsed as {
    files?: unknown;
    syncedAt?: unknown;
    checkedThrough?: unknown;
  };
  if (typeof document.syncedAt === "number" && document.syncedAt > 0) {
    // Every cursor the server issues is a timestamp it has already reached, so
    // one ahead of the clock was written by something other than a sync.
    ledger.syncedAt = Math.min(Math.floor(document.syncedAt), Date.now());
  }
  if (typeof document.checkedThrough === "string") {
    // Only ever decides which slice of the ledger this turn asks about, and
    // the slice wraps, so a forged value delays a question rather than
    // suppressing one — and dropping the entry outright is easier anyway.
    ledger.checkedThrough = document.checkedThrough.slice(0, 400);
  }
  const files =
    document.files && typeof document.files === "object"
      ? (document.files as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(files)) {
    const entry = value as Partial<LedgerEntry> | null;
    if (
      typeof entry?.updatedAt === "number" &&
      typeof entry.sizeBytes === "number" &&
      typeof entry.sha256 === "string"
    ) {
      ledger.files.set(key, {
        updatedAt: entry.updatedAt,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
      });
    }
  }
  return ledger;
};

const writeLedger = async (file: string, ledger: Ledger): Promise<void> => {
  const rows = [...ledger.files.entries()]
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, LEDGER_MAX_ENTRIES);
  await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  await writeFile(
    file,
    JSON.stringify({
      syncedAt: ledger.syncedAt,
      checkedThrough: ledger.checkedThrough,
      files: Object.fromEntries(rows),
    }),
  ).catch(() => undefined);
};

/**
 * The slice of the ledger this turn asks the server to confirm, resuming after
 * the last path the previous turn asked about and wrapping at the end.
 *
 * Rotation rather than truncation because the answer is what authorizes a
 * delete: a path this window does not reach is left on disk until a later turn
 * reaches it, so the only thing a small window costs is how long a deleted
 * file stays readable in the sandbox — and the manifest's own tombstone stream
 * already covers the recent deletions, which is every deletion that has a live
 * cursor behind it. This is the backstop for the rest.
 */
const presenceWindow = (ledger: Ledger): string[] => {
  const paths = [...ledger.files.keys()].sort();
  if (paths.length <= PRESENCE_MAX) return paths;
  const next = paths.findIndex((value) => value > ledger.checkedThrough);
  const from = next < 0 ? 0 : next;
  return [...paths.slice(from), ...paths.slice(0, from)].slice(0, PRESENCE_MAX);
};

/** Hash without following a symlink at the leaf, and without buffering it all. */
const sha256File = async (file: string): Promise<string | null> => {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) return null;
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/** Where a drive path's copy sits under the workspace root. */
const relativeToPrefix = (prefix: string, drivePath: string): string =>
  prefix && drivePath.startsWith(prefix)
    ? drivePath.slice(prefix.length)
    : drivePath;

/**
 * Is the file standing here exactly the copy this workspace hydrated for its
 * drive path? This is the only proof that licenses destroying it, and both
 * ways of destroying one ask it: `applyTombstones` before it unlinks, and
 * hydration before it downloads over it.
 *
 * The two used to answer it differently — the unlink path ran this test, the
 * download path ran none — which is how a file the agent had rewritten was
 * safe from a delete on the drive and not safe from an ordinary manifest
 * entry naming the same row.
 */
const isHydratedCopy = async (
  target: string,
  stats: Stats,
  hydrated: LedgerEntry | undefined,
): Promise<boolean> => {
  if (!hydrated || stats.size !== hydrated.sizeBytes) return false;
  return (await sha256File(target)) === hydrated.sha256;
};

/**
 * Resolve where an entry's bytes go, refusing anything that would land outside
 * the workspace. A restored checkpoint is agent-written content: a symlink
 * planted at a drive path on an earlier turn would otherwise redirect this
 * write anywhere the sandbox user can reach.
 *
 * `createDirectory` is off for tombstones: a delete has no business creating
 * the directory tree of a file that is not there.
 */
const resolveTarget = async (
  workspaceRealRoot: string,
  relativePath: string,
  createDirectory = true,
): Promise<string | null> => {
  const absolute = path.resolve(workspaceRealRoot, relativePath);
  const relative = path.relative(workspaceRealRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const directory = path.dirname(absolute);
  if (createDirectory) {
    await mkdir(directory, { recursive: true }).catch(() => undefined);
  }
  const realDirectory = await realpath(directory).catch(() => null);
  if (!realDirectory) return null;
  const fromRoot = path.relative(workspaceRealRoot, realDirectory);
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) return null;
  return path.join(realDirectory, path.basename(absolute));
};

/**
 * Does the workspace already hold this row's bytes, and if so what are they?
 *
 * The old answer was "yes if the size matches, unless the row is an upload".
 * Uploads had to be excluded because size alone cannot tell a re-upload from
 * the copy an earlier turn wrote, and nothing on disk recorded which version
 * that copy came from — so every upload was re-downloaded every turn, which is
 * most of a drive. The ledger records exactly that missing version, and the
 * hash is what makes believing it safe.
 *
 * The hash comes back rather than just the verdict because the ledger is what
 * authorizes a later delete: a copy this workspace is holding but has no entry
 * for can never be removed when its row is, so "current" has to be able to
 * record what it found, not only that it was satisfied.
 */
const alreadyCurrent = async (
  target: string,
  entry: DriveSyncEntry,
  ledger: Ledger,
): Promise<{ sha256: string } | null> => {
  const stats = await lstat(target).catch(() => null);
  if (!stats?.isFile() || stats.size !== entry.sizeBytes) return null;
  const recorded = ledger.files.get(entry.path);
  const expected =
    entry.sha256 ??
    (recorded?.updatedAt === entry.updatedAt &&
    recorded.sizeBytes === entry.sizeBytes
      ? recorded.sha256
      : undefined);
  if (expected) {
    return (await sha256File(target)) === expected
      ? { sha256: expected }
      : null;
  }
  // Nothing to verify against: a row this workspace produced is still taken at
  // its size — that is where its bytes came from — and a file the user
  // uploaded never is. `origin`, not `source`: an upload an earlier turn
  // edited is still the user's bytes, and taking it on size would let a
  // same-size replacement pass unnoticed.
  if ((entry.origin ?? entry.source) === "upload") return null;
  const hash = await sha256File(target);
  return hash === null ? null : { sha256: hash };
};

const writeContained = async (
  target: string,
  bytes: Buffer,
): Promise<boolean> => {
  const handle = await open(
    target,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
  ).catch(() => null);
  if (!handle) return false;
  try {
    await handle.writeFile(bytes);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * Remove the paths the drive no longer has — and only ever the exact bytes
 * this workspace put there for them.
 *
 * Deleting a drive file used to leave the hydrated copy in the checkpoint,
 * where every later turn restored it, read it, and could re-register it as a
 * fresh file — the delete removed the file from the user's view but not from
 * the machine running their agents. The manifest names them; this removes
 * them, under the same containment rules as a write: the parent chain is
 * resolved, the leaf is `lstat`ed rather than `stat`ed, and `unlink` never
 * follows a symlink.
 *
 * The gate is the whole of the safety argument, and it is deliberately
 * narrower than "the manifest said so". A tombstone is not an instruction to
 * delete a path; it is the fact that a row is gone. What may be deleted on
 * that fact is a copy of the deleted row's bytes and nothing else — so a path
 * unlinks only when the ledger records what this workspace hydrated for it and
 * the file still hashes to exactly that. Everything else in the drive tree is
 * somebody's work. Undelivered output — `collected.omitted`, a withheld batch,
 * a quota refusal, a failed delivery — is exactly that, whether it sits at a
 * path with no ledger entry at all or at one this workspace hydrated and the
 * agent then rewrote; the first has nothing to match and the second no longer
 * matches, and neither is unlinked. The server answers
 * every sync with the drive's most recent deletions whatever cursor it was
 * given, so an ungated apply is not a one-shot replay but a standing delete
 * rule re-run at the start of every turn, forever; under this gate a replay is
 * a no-op by construction, because the first application already removed the
 * bytes it was allowed to remove.
 *
 * The cost is that a deleted file whose copy the agent modified stays readable
 * in the sandbox. That is reported as `stale` and told to the agent rather
 * than acted on: a stale copy is recoverable, destroyed work is not.
 */
const applyTombstones = async (
  workspaceRealRoot: string,
  prefix: string,
  deleted: DriveSyncTombstone[],
  ledger: Ledger,
): Promise<{ removed: string[]; stale: string[]; dropped: number }> => {
  const removed: string[] = [];
  const stale: string[] = [];
  let dropped = 0;
  for (const entry of deleted) {
    const drivePath = entry.path.trim();
    if (!drivePath) continue;
    // The manifest carries `relativePath` already; deriving it from the
    // prefix is the fallback for a tombstone that arrived without one.
    const relativePath =
      entry.relativePath || relativeToPrefix(prefix, drivePath);
    const hydrated = ledger.files.get(drivePath);
    // The row is gone either way, so this workspace stops vouching for it:
    // it drops out of the presence window and out of the versions the write
    // side may echo.
    if (ledger.files.delete(drivePath)) dropped += 1;
    if (!hydrated) continue;
    const target = await resolveTarget(workspaceRealRoot, relativePath, false);
    if (!target) continue;
    const stats = await lstat(target).catch(() => null);
    // A missing file is success — a replayed tombstone is expected, and the
    // window may reach further back than this workspace ever hydrated. A
    // symlink or a directory standing at a drive path is not a hydrated copy
    // and is left where it is.
    if (!stats?.isFile()) continue;
    if (!(await isHydratedCopy(target, stats, hydrated))) {
      stale.push(drivePath);
      continue;
    }
    const gone = await unlink(target).then(
      () => true,
      () => false,
    );
    if (gone) removed.push(drivePath);
  }
  return { removed, stale, dropped };
};

/**
 * The manifest's tombstones, taken as data rather than trusted shape: this is
 * a network payload, and a half-parsed entry must skip rather than throw and
 * take the whole hydration down with it.
 *
 * `TOMBSTONE_MAX` is spent here rather than at apply time because it is this
 * list — arbitrary length, straight off the wire — that it exists to bound.
 * The deletes derived from the presence answer are already bounded by what
 * this workspace asked about and intersected with its own ledger, so capping
 * the two together would let a long delete list starve them.
 */
const readTombstones = (value: unknown): DriveSyncTombstone[] => {
  if (!Array.isArray(value)) return [];
  const tombstones: DriveSyncTombstone[] = [];
  for (const raw of value.slice(0, TOMBSTONE_MAX)) {
    if (typeof raw === "string") {
      tombstones.push({ path: raw, relativePath: "", deletedAt: 0 });
      continue;
    }
    const entry = raw as Partial<DriveSyncTombstone> | null;
    if (typeof entry?.path !== "string") continue;
    tombstones.push({
      path: entry.path,
      relativePath:
        typeof entry.relativePath === "string" ? entry.relativePath : "",
      deletedAt: typeof entry.deletedAt === "number" ? entry.deletedAt : 0,
    });
  }
  return tombstones;
};

/**
 * Both live outcomes carry a ledger entry, because both leave this workspace
 * holding the row's bytes. Recording only the downloads is what let a file
 * that was already on disk — every piece of agent output, which hydration
 * takes at its size the turn after it was written — sit in the drive tree with
 * nothing accounting for it, so the tombstone gate could never remove it when
 * the user deleted the row.
 */
type Hydration =
  | { kind: "current"; path: string; updatedAt: number; ledger: LedgerEntry }
  | {
      kind: "downloaded";
      path: string;
      updatedAt: number;
      ledger: LedgerEntry;
    }
  // A file this workspace cannot prove it wrote is standing at the row's path,
  // so nothing was downloaded over it. It carries a version only when the row
  // has not moved, because that is the only case where the workspace can still
  // say which version its copy descends from.
  | { kind: "conflict"; path: string; updatedAt: number; driveMoved: false }
  | { kind: "conflict"; path: string; driveMoved: true }
  | { kind: "skipped"; path: string; reason: string };

export const materializeDriveFiles = async (options: {
  turnId: string;
  prompt: string;
  workspaceRoot: string;
  /** Where the hydration ledger lives (the workspace's tool-state directory). */
  stateDir: string;
  post: (route: string, body: unknown) => Promise<Response>;
  onProgress?: (message: string) => void;
}): Promise<DriveSyncResult> => {
  // The ledger is read before the request, not after: its cursor is what the
  // server needs to know which deletions this workspace has not applied yet.
  const ledgerPath = path.join(options.stateDir, LEDGER_FILE);
  const ledger = await readLedger(ledgerPath);

  // `have` is the other half of that: the paths this workspace is holding, so
  // the server can answer which of them it no longer has instead of the
  // workspace guessing from what the (capped) file list happens to name.
  const asked = presenceWindow(ledger);
  const response = await options
    .post("/api/cloud/drive/sync", {
      turnId: options.turnId,
      include: drivePathsInPrompt(options.prompt),
      ...(ledger.syncedAt > 0 ? { since: ledger.syncedAt } : {}),
      ...(asked.length > 0 ? { have: asked } : {}),
    })
    .catch(() => null);
  if (!response?.ok) {
    throw new Error(
      `Drive sync failed (${response ? response.status : "no response"}).`,
    );
  }
  const manifest = (await response.json()) as {
    prefix?: string;
    files?: DriveSyncEntry[];
    /**
     * In the drive, not hydrated this turn. `updatedAt`/`origin` are what let
     * a copy an earlier turn already put on disk still count as read.
     */
    skipped?: Array<{
      path: string;
      reason: string;
      updatedAt?: number;
      origin?: string;
    }>;
    /** Paths deleted from the drive since `since`. */
    deleted?: unknown;
    /** Of the paths sent as `have`, the ones the drive has no row for. */
    absent?: unknown;
    /** Cursor to send as `since` next turn, once everything here is applied. */
    syncedAt?: unknown;
    /** False when tombstones older than the cursor may have been pruned. */
    deletedComplete?: unknown;
  };
  const entries = manifest.files ?? [];
  const result: DriveSyncResult = {
    known: new Map(),
    uploads: new Set(),
    materialized: [],
    // Filled once the ledger is settled: which of these the workspace is
    // already holding is the difference between "not in this turn" and "here
    // from an earlier one".
    skipped: [],
    deleted: [],
    stale: [],
    conflicts: [],
  };

  await mkdir(options.workspaceRoot, { recursive: true }).catch(
    () => undefined,
  );
  const workspaceRealRoot = await realpath(options.workspaceRoot).catch(
    () => options.workspaceRoot,
  );

  // Deletions first: a tombstoned path that a later manifest entry re-creates
  // is a re-upload, and it should end the turn present, not removed.
  const prefix = manifest.prefix ?? "";
  const tombstones = readTombstones(manifest.deleted);
  // A tombstone is a delete the caller has to be told about, and being told
  // depends on a cursor that lives in the agent's own workspace. `absent` does
  // not: it is the server's answer, per path, for exactly the paths this
  // workspace said it was holding, so a path in it is a row the drive no
  // longer has whatever cursor the ledger claimed.
  //
  // The manifest's file list cannot stand in for that answer. It is capped, so
  // on any drive larger than the cap a path missing from it means "not in the
  // window the server read", and removing a hydrated copy on that basis
  // deletes a file the user still has — deterministically and for good, since
  // the same rows fall outside the window on every later sync, after which the
  // agent writes a fresh file over the row it was never shown. A path the
  // presence window did not reach this turn is left exactly where it is: the
  // failure direction here is a stale copy, never an unlink.
  //
  // Re-checked against the prefix — `absent` is network data, and the only
  // paths it may speak for are the ones this workspace hydrated. What it is
  // allowed to remove is settled in `applyTombstones`, which holds every
  // tombstone to the same gate whether it came from here or from the server's
  // own list.
  const absent = Array.isArray(manifest.absent)
    ? manifest.absent.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const named = new Set(tombstones.map((entry) => entry.path));
  for (const drivePath of absent) {
    if (named.has(drivePath) || !ledger.files.has(drivePath)) continue;
    if (prefix && !drivePath.startsWith(prefix)) continue;
    named.add(drivePath);
    tombstones.push({ path: drivePath, relativePath: "", deletedAt: 0 });
  }
  let ledgerDropped = 0;
  if (tombstones.length > 0) {
    const applied = await applyTombstones(
      workspaceRealRoot,
      prefix,
      tombstones,
      ledger,
    );
    result.deleted = applied.removed;
    // A path the manifest also names live is a re-upload: the tombstone is the
    // old row's, and the drive has one again. Reporting it as deleted-but-kept
    // would be false in the one direction that matters — the agent would be
    // told the file is no longer the user's while the user is looking at it.
    // What actually happens to the diverged copy is settled by hydration
    // below, which reaches the same answer for the same reason and says so as
    // a conflict.
    const live = new Set([
      ...entries.map((entry) => entry.path),
      ...(manifest.skipped ?? []).map((entry) => entry.path),
    ]);
    result.stale = applied.stale.filter((drivePath) => !live.has(drivePath));
    ledgerDropped = applied.dropped;
  }
  if (manifest.deletedComplete === false) {
    // Deliberately only logged. The obvious reflex — sweep the drive folder
    // for anything with no row — would delete this turn's own undelivered
    // output, which lives in the same tree and has no row either.
    console.warn(
      "drive sync: deletion history may be incomplete for this workspace",
    );
  }

  // Rows the manifest named but did not hydrate, on a drive larger than the
  // per-turn budget. "Not loaded into this turn" is only true of the ones the
  // workspace is not already holding: a row an earlier turn hydrated is still
  // on disk in the restored checkpoint, and the agent reads and edits it like
  // any other file. Telling the agent it is missing is the smaller half of
  // getting that wrong — the larger half is that a path with no version here
  // is, to the write side, a row this turn was never shown, so every delivery
  // of one carries the `replaced` notice that exists for the case where the
  // agent really did overwrite something unseen.
  //
  // The version is the whole test for `known`: the ledger says which one this
  // workspace hydrated and the manifest says which one the row is on now, and
  // when they agree the copy on disk descends from the row as it stands. No
  // hash there — that asks whether the agent has since edited the file, which
  // is a different question and not one `known` answers anywhere else. The
  // file does have to still be there: vouching for a version whose copy the
  // agent deleted would hand the write side a read it never had.
  //
  // `materialized` is that different question, so it is settled the way the
  // outcome loop settles it. Without the hash here the report U1 exists for is
  // unreachable on any drive larger than one turn's window: the same
  // divergence at the same unmoved row is a conflict when the manifest names
  // the row among its `files`, and silently "one of the user's files" when the
  // budget pushed the identical row into `skipped` instead. Nothing is
  // destroyed either way — a skipped row is never downloaded — but the agent
  // would be told its own undelivered work is the user's current copy, which
  // is the half of U1 that is about reporting rather than bytes.
  for (const entry of manifest.skipped ?? []) {
    const version = entry.updatedAt;
    const hydrated = ledger.files.get(entry.path);
    const target =
      typeof version === "number" && hydrated?.updatedAt === version
        ? await resolveTarget(
            workspaceRealRoot,
            relativeToPrefix(prefix, entry.path),
            false,
          )
        : null;
    const stats = target ? await lstat(target).catch(() => null) : null;
    if (typeof version !== "number" || !target || !stats?.isFile()) {
      result.skipped.push({ path: entry.path, reason: entry.reason });
      continue;
    }
    result.known.set(entry.path, version);
    if (entry.origin === "upload") result.uploads.add(entry.path);
    if (!(await isHydratedCopy(target, stats, hydrated))) {
      // The row has not moved — that is the precondition for being here — so
      // this is the same case as the outcome loop's `driveMoved: false`, and
      // it is reported with the same words.
      result.conflicts.push({ path: entry.path, driveMoved: false });
      continue;
    }
    result.materialized.push(entry.path);
  }

  // Parallel and bounded: the manifest is up to 100 files, and awaiting them
  // one at a time made a turn's start time the sum of the drive's downloads.
  const deadline = Date.now() + HYDRATE_BUDGET_MS;
  const hydrate = async (entry: DriveSyncEntry): Promise<Hydration> => {
    const target = await resolveTarget(workspaceRealRoot, entry.relativePath);
    if (!target) {
      return {
        kind: "skipped",
        path: entry.path,
        reason: "it does not resolve to a location inside the workspace",
      };
    }
    const current = await alreadyCurrent(target, entry, ledger);
    if (current) {
      return {
        kind: "current",
        path: entry.path,
        updatedAt: entry.updatedAt,
        ledger: {
          updatedAt: entry.updatedAt,
          sizeBytes: entry.sizeBytes,
          sha256: current.sha256,
        },
      };
    }
    // The row's bytes are not what is on disk, so the download is about to
    // truncate whatever is. Same question the tombstone gate asks before it
    // unlinks: can this workspace prove it put those bytes there? A regular
    // file it cannot account for is somebody's work — most often this thread's
    // own output from a turn whose delivery was omitted, withheld, refused by
    // quota or lost, all of which the user was told are "still in the
    // workspace" — and re-downloading the row is a silent revert of it.
    const standing = await lstat(target).catch(() => null);
    // Only a regular file is a copy of anything. A directory or a symlink
    // standing at a drive path is neither ours nor somebody's work; the write
    // below refuses it on its own terms (O_NOFOLLOW), as it always has.
    const present = standing?.isFile() ? standing : null;
    const hydrated = ledger.files.get(entry.path);
    const ours =
      present !== null && (await isHydratedCopy(target, present, hydrated));
    if (present && !ours && hydrated?.updatedAt === entry.updatedAt) {
      // The row has not moved since this workspace hydrated it, so the
      // download would restore bytes this workspace already had and destroy
      // the only copy of the ones it does not. Nothing to weigh: keep the
      // file, and do not spend the transfer finding that out.
      return {
        kind: "conflict",
        path: entry.path,
        updatedAt: entry.updatedAt,
        driveMoved: false,
      };
    }
    if (Date.now() > deadline) {
      return {
        kind: "skipped",
        path: entry.path,
        reason: "loading it into the workspace ran out of time",
      };
    }
    const download = await fetch(entry.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    }).catch(() => null);
    const bytes = download?.ok
      ? await download
          .arrayBuffer()
          .then((buffer) => Buffer.from(buffer))
          .catch(() => null)
      : null;
    if (bytes && present && !ours) {
      // The row has moved (or this workspace has no usable record of ever
      // holding it: a ledger entry rotated out past LEDGER_MAX_ENTRIES,
      // dropped, or never written). Both sides may have changed, so the last
      // thing that can still settle it is the drive's own bytes — compared,
      // not written.
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        present.size !== bytes.byteLength ||
        (await sha256File(target)) !== sha256
      ) {
        return { kind: "conflict", path: entry.path, driveMoved: true };
      }
      // Byte-identical after all, so there was never anything to overwrite —
      // and the record this workspace was missing is now provable, which is
      // what stops the next turn asking the same question.
      return {
        kind: "current",
        path: entry.path,
        updatedAt: entry.updatedAt,
        ledger: {
          updatedAt: entry.updatedAt,
          sizeBytes: bytes.byteLength,
          sha256,
        },
      };
    }
    if (!bytes || !(await writeContained(target, bytes))) {
      // Not fatal, and deliberately not vouched for: the write side will
      // protect this path rather than let the agent replace bytes it could
      // not read.
      return {
        kind: "skipped",
        path: entry.path,
        reason: "loading it into the workspace failed",
      };
    }
    return {
      kind: "downloaded",
      path: entry.path,
      updatedAt: entry.updatedAt,
      ledger: {
        updatedAt: entry.updatedAt,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  };

  const outcomes: Array<Hydration | undefined> = new Array(entries.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const entry = entries[index];
      if (!entry) return;
      outcomes[index] = await hydrate(entry);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(DOWNLOAD_CONCURRENCY, entries.length) },
      worker,
    ),
  );

  let downloaded = 0;
  let reused = 0;
  let ledgerAdded = 0;
  // Manifest order, not completion order: the prompt lists these back to the
  // agent, and relevance is what the server ranked them by.
  for (const [index, outcome] of outcomes.entries()) {
    if (!outcome) continue;
    if (outcome.kind === "skipped") {
      result.skipped.push({ path: outcome.path, reason: outcome.reason });
      continue;
    }
    const entry = entries[index];
    if (outcome.kind === "conflict") {
      result.conflicts.push({
        path: outcome.path,
        driveMoved: outcome.driveMoved,
      });
      // The ledger is left exactly as it was. It still records what this
      // workspace hydrated, which is what a later tombstone for this path is
      // measured against — writing the row's version against bytes nothing
      // here produced would hand that tombstone a licence to unlink the very
      // work this branch exists to keep.
      if (outcome.driveMoved) continue;
      // The row has not moved, so the workspace's copy still descends from the
      // version the manifest names and the turn has read it — the same claim
      // the reuse path makes for a file it found already on disk, and the
      // difference between the agent saving its own continuation of a file and
      // being diverted to an "(agent copy)" sibling of it.
      //
      // When the row HAS moved, staying out of `known` is the point: the turn
      // has not seen the drive's current bytes, and the write side must treat
      // its version as a second writer rather than an update.
      result.known.set(outcome.path, outcome.updatedAt);
      if (entry && (entry.origin ?? entry.source) === "upload") {
        result.uploads.add(outcome.path);
      }
      // Not `materialized`: what stands at that path is the workspace's own
      // divergent copy, and the count is how the prompt tells the agent which
      // of the user's files it is actually looking at.
      continue;
    }
    result.known.set(outcome.path, outcome.updatedAt);
    // `origin`, not `source`, for the same reason the write rule tests it: an
    // upload an earlier turn edited is still the user's file.
    if (entry && (entry.origin ?? entry.source) === "upload") {
      result.uploads.add(outcome.path);
    }
    result.materialized.push(outcome.path);
    const held = ledger.files.get(outcome.path);
    if (
      held?.updatedAt !== outcome.ledger.updatedAt ||
      held.sizeBytes !== outcome.ledger.sizeBytes ||
      held.sha256 !== outcome.ledger.sha256
    ) {
      ledger.files.set(outcome.path, outcome.ledger);
      ledgerAdded += 1;
    }
    if (outcome.kind === "downloaded") downloaded += 1;
    else reused += 1;
  }

  // The cursor moves only here, after every tombstone was applied and
  // materialization ran to the end. Anything that threw earlier left it where
  // it was, so the next turn is handed those deletions again.
  //
  // It is taken verbatim rather than as the later of the two. The old ratchet
  // made a cursor from a future the server has not reached permanent: nothing
  // could ever bring it back down, and it asked for zero deletions forever.
  // Backwards is the harmless direction — it re-serves tombstones, and
  // replaying one is a no-op.
  const answered =
    typeof manifest.syncedAt === "number" &&
    Number.isFinite(manifest.syncedAt) &&
    manifest.syncedAt > 0
      ? Math.floor(manifest.syncedAt)
      : ledger.syncedAt;
  const moved = answered !== ledger.syncedAt;
  ledger.syncedAt = answered;
  // Same rule for the presence window: it advances only once its answer has
  // been applied, so a turn that threw asks about the same slice again.
  const walked = asked.at(-1) ?? ledger.checkedThrough;
  const rotated = walked !== ledger.checkedThrough;
  ledger.checkedThrough = walked;
  if (ledgerAdded > 0 || ledgerDropped > 0 || moved || rotated) {
    await writeLedger(ledgerPath, ledger);
  }
  const notes: string[] = [];
  if (downloaded > 0) {
    notes.push(
      `Loaded ${downloaded} drive ${downloaded === 1 ? "file" : "files"} into the workspace${
        reused > 0 ? ` (${reused} already there)` : ""
      }.`,
    );
  }
  if (result.deleted.length > 0) {
    const gone = result.deleted.length;
    notes.push(
      `Removed ${gone} ${gone === 1 ? "file" : "files"} deleted from the drive.`,
    );
  }
  if (result.stale.length > 0) {
    const kept = result.stale.length;
    notes.push(
      `Kept ${kept} changed ${kept === 1 ? "copy" : "copies"} of ${kept === 1 ? "a file" : "files"} deleted from the drive.`,
    );
  }
  if (result.conflicts.length > 0) {
    const kept = result.conflicts.length;
    notes.push(
      `Kept ${kept} workspace ${kept === 1 ? "file" : "files"} with unsaved changes rather than reloading ${kept === 1 ? "it" : "them"} from the drive.`,
    );
  }
  if (notes.length > 0) options.onProgress?.(notes.join(" "));
  return result;
};
