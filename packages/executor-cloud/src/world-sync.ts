import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  lutimes,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import {
  isWorldUnsyncedPath,
  WORLD_UNSYNCED_PATHS,
} from "@stella/contracts/cloud-tool-home";

export type WorldSyncAccess = Readonly<{
  origin: string;
  name: string;
  capability: string;
}>;

export type WorldMarker = Readonly<{
  manifestId: string;
  revision: number;
}>;

export type WorldListingEntry = {
  path: string;
  kind: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  sha256?: string;
  target?: string;
};

export type WorldIndexEntry = Omit<WorldListingEntry, "path">;

/**
 * What this disk last agreed with the world on, path by path: the base every
 * push is a diff against. Several containers sync one world, so a push sends
 * only what changed here since this base, never the whole disk.
 */
export type WorldIndex = Record<string, WorldIndexEntry>;

/**
 * The index file. `complete` is false only for the seed a cold
 * materialization writes, which names the export's `node_modules` roots and
 * nothing else; the first pull turns the freshly extracted disk into the
 * base.
 */
type StoredWorldIndex = { complete: boolean; entries: WorldIndex };

type WorldChanges = {
  revision: number;
  entries: WorldListingEntry[];
  deleted: string[];
  resync: boolean;
};

const WORLD_PATH_LIMIT_BYTES = 1_024;
const WORLD_FILE_LIMIT_BYTES = 256 * 1024 * 1024;
export const WORLD_BLOB_FRAME_HEADER_BYTES = 40;
export const WORLD_BLOB_BATCH_MAX_BYTES = 32 * 1024 * 1024;
export const WORLD_BLOB_BATCH_MAX_COUNT = 512;
export const WORLD_BLOB_UPLOAD_CONCURRENCY = 3;
const WORLD_ENTRY_LIMIT = 200_000;
const WORLD_UID = 42_424;
const WORLD_GID = 42_424;

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const statePaths = (root: string) => ({
  marker: path.join(root, ".stella", "world-manifest"),
  index: path.join(path.dirname(root), ".stella-world-index.json"),
  lock: path.join(path.dirname(root), ".world-materialize.lock"),
  staging: path.join(path.dirname(root), ".stella-world-staging"),
});

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const validateRelativePath = (value: string): string => {
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > WORLD_PATH_LIMIT_BYTES ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid world path: ${value}`);
  }
  return value;
};

const absoluteWorldPath = (root: string, relative: string): string => {
  const normalized = validateRelativePath(relative);
  const absolute = path.resolve(root, normalized);
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(boundary)) {
    throw new Error(`World path escapes its root: ${relative}`);
  }
  return absolute;
};

const isNodeModulesDirectory = (relative: string): boolean =>
  relative === "node_modules" || relative.endsWith("/node_modules");

/**
 * The user's drive is a working copy of its own store (`drive-sync.ts` and
 * `drive-writeback.ts`), not part of the world: it is never pushed, and
 * restoring the world from an export leaves it where it is.
 */
const isDriveCopy = (relative: string): boolean => relative === "drive";

const indexedNodeModulesDirectories = (index: WorldIndex): Set<string> => {
  const directories = new Set<string>();
  for (const entryPath of Object.keys(index)) {
    const segments = entryPath.split("/");
    for (
      let segmentIndex = 0;
      segmentIndex < segments.length;
      segmentIndex += 1
    ) {
      if (segments[segmentIndex] === "node_modules") {
        directories.add(segments.slice(0, segmentIndex + 1).join("/"));
      }
    }
  }
  return directories;
};

const fileSha256 = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
};

/** The stored index, or null when this disk has none. */
const readIndex = async (
  indexPath: string,
): Promise<StoredWorldIndex | null> => {
  let text: string;
  try {
    const stat = await lstat(indexPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("World index is not a regular file.");
    }
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw asError(error);
  }
  const value = JSON.parse(text) as unknown;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { complete?: unknown }).complete !== "boolean"
  ) {
    throw new Error("World index is invalid.");
  }
  const stored = value as { complete: boolean; entries?: unknown };
  if (
    !stored.entries ||
    typeof stored.entries !== "object" ||
    Array.isArray(stored.entries)
  ) {
    throw new Error("World index is invalid.");
  }
  const entries: WorldIndex = {};
  for (const [entryPath, raw] of Object.entries(stored.entries)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("World index is invalid.");
    }
    const row = raw as Record<string, unknown>;
    if (
      (row.kind !== "file" && row.kind !== "dir" && row.kind !== "symlink") ||
      !Number.isSafeInteger(row.mode) ||
      Number(row.mode) < 0 ||
      !Number.isSafeInteger(row.size) ||
      Number(row.size) < 0 ||
      !Number.isSafeInteger(row.mtime) ||
      (row.sha256 !== undefined &&
        (typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(row.sha256))) ||
      (row.target !== undefined && typeof row.target !== "string")
    ) {
      throw new Error("World index is invalid.");
    }
    entries[validateRelativePath(entryPath)] = {
      kind: row.kind,
      mode: Number(row.mode),
      size: Number(row.size),
      mtime: Number(row.mtime),
      ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
      ...(typeof row.target === "string" ? { target: row.target } : {}),
    };
  }
  return { complete: stored.complete, entries };
};

const writeIndex = async (root: string, entries: WorldIndex): Promise<void> =>
  await writeJsonAtomic(statePaths(root).index, {
    complete: true,
    entries,
  } satisfies StoredWorldIndex);

/**
 * Whether the world and this disk hold the same thing at one path. A
 * directory's mtime moves with every child and a file's with every save, so
 * neither alone is a change worth sending or applying.
 */
const sameContent = (
  base: WorldIndexEntry | undefined,
  entry: WorldIndexEntry,
): boolean =>
  base !== undefined &&
  base.kind === entry.kind &&
  base.mode === entry.mode &&
  (entry.kind === "dir" ||
    (entry.kind === "file" &&
      base.sha256 === entry.sha256 &&
      base.size === entry.size) ||
    (entry.kind === "symlink" && base.target === entry.target));

/** Paths the world sync owns at all; everything else stays on this disk. */
const isSyncedPath = (relative: string): boolean =>
  relative !== ".stella/world-manifest" &&
  !isWorldUnsyncedPath(relative) &&
  !isDriveCopy(relative) &&
  !relative.startsWith("drive/");

const writeJsonAtomic = async (
  filePath: string,
  value: unknown,
): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
};

export const readWorldMarker = async (root: string): Promise<WorldMarker> => {
  const value = JSON.parse(
    await readFile(statePaths(root).marker, "utf8"),
  ) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("World marker is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.manifestId !== "string" ||
    !row.manifestId ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0
  ) {
    throw new Error("World marker is invalid.");
  }
  return { manifestId: row.manifestId, revision: Number(row.revision) };
};

const writeWorldMarker = async (
  root: string,
  marker: WorldMarker,
): Promise<void> => {
  const markerPath = statePaths(root).marker;
  await ensureDirectoryPath(root, ".stella");
  const stateDirectory = path.dirname(markerPath);
  const directoryTimes = await lstat(stateDirectory);
  await writeJsonAtomic(markerPath, marker);
  await chmod(markerPath, 0o600);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    await chown(markerPath, 0, 0);
  }
  await utimes(
    stateDirectory,
    directoryTimes.atimeMs / 1_000,
    directoryTimes.mtimeMs / 1_000,
  );
};

/** Hold the same container-wide flock used by cold materialization. */
export const withWorldSyncLock = async <T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const lockPath = statePaths(root).lock;
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = spawn(
    "/bin/bash",
    [
      "-c",
      '( set -eu; exec 9>"$1"; /usr/bin/flock --exclusive 9; printf R; cat >/dev/null )',
      "world-sync-lock",
      lockPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    lock.once("error", (error) => reject(error));
    lock.once("exit", (code) => {
      if (code !== null)
        reject(new Error(`World lock exited with code ${code}.`));
    });
    lock.stdout.once("data", (chunk: Buffer) => {
      if (chunk.includes(0x52)) resolve();
      else reject(new Error("World lock did not report readiness."));
    });
  });
  try {
    return await operation();
  } finally {
    lock.stdin.end();
    if (lock.exitCode === null) {
      await new Promise<void>((resolve) => lock.once("exit", () => resolve()));
    }
  }
};

export const listWorldProjection = async (
  root: string,
  previous: WorldIndex = {},
  hashFile: (filePath: string) => Promise<string> = fileSha256,
): Promise<{ entries: WorldListingEntry[]; index: WorldIndex }> => {
  const entries: WorldListingEntry[] = [];
  const index: WorldIndex = {};
  const durableNodeModules = indexedNodeModulesDirectories(previous);
  const walk = async (
    relative: string,
    insideDurableNodeModules = false,
  ): Promise<void> => {
    const absolute = relative ? absoluteWorldPath(root, relative) : root;
    const names = (await readdir(absolute)).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const name of names) {
      const child = relative ? `${relative}/${name}` : name;
      if (Buffer.byteLength(child, "utf8") > WORLD_PATH_LIMIT_BYTES) {
        throw new Error(`World path exceeds 1024 UTF-8 bytes: ${child}`);
      }
      const childPath = absoluteWorldPath(root, child);
      const stat = await lstat(childPath);
      const kind = stat.isSymbolicLink()
        ? "symlink"
        : stat.isDirectory()
          ? "dir"
          : stat.isFile()
            ? "file"
            : null;
      if (!kind) {
        throw new Error(
          `World contains an unsupported filesystem entry: ${child}`,
        );
      }
      if (child === ".stella/world-manifest") continue;
      // HOME's caches and the mirrored skills live only on this disk.
      if (isWorldUnsyncedPath(child)) continue;
      if (isDriveCopy(child)) continue;
      // Dependency installations are explicitly ephemeral. If a node_modules
      // subtree came from the durable index, however, scan it rather than
      // reading it as deleted.
      const durableNodeModulesEntry =
        insideDurableNodeModules || durableNodeModules.has(child);
      if (
        kind === "dir" &&
        isNodeModulesDirectory(child) &&
        !durableNodeModulesEntry
      ) {
        continue;
      }
      const common = {
        path: child,
        mode: stat.mode & 0o7777,
        mtime: Math.trunc(stat.mtimeMs),
        size: kind === "dir" ? 0 : stat.size,
      };
      if (kind === "symlink") {
        const target = await readlink(childPath);
        entries.push({ ...common, kind, target });
        index[child] = {
          kind,
          mode: common.mode,
          size: common.size,
          mtime: common.mtime,
          target,
        };
      } else if (kind === "dir") {
        entries.push({ ...common, kind });
        index[child] = { kind, mode: common.mode, size: 0, mtime: common.mtime };
        await walk(child, durableNodeModulesEntry);
      } else {
        if (stat.size > WORLD_FILE_LIMIT_BYTES) {
          throw new Error(`World file exceeds 256 MiB: ${child}`);
        }
        const prior = previous[child];
        const sha256 =
          prior?.kind === "file" &&
          prior.sha256 &&
          prior.size === common.size &&
          prior.mtime === common.mtime
            ? prior.sha256
            : await hashFile(childPath);
        entries.push({ ...common, kind, sha256 });
        index[child] = {
          kind,
          mode: common.mode,
          size: common.size,
          mtime: common.mtime,
          sha256,
        };
      }
      if (entries.length > WORLD_ENTRY_LIMIT) {
        throw new Error("World projection exceeds 200000 entries.");
      }
    }
  };
  await walk("");
  return { entries, index };
};

const routeUrl = (access: WorldSyncAccess, route: string): string => {
  const url = new URL(
    `${access.origin.replace(/\/+$/u, "")}/internal/worlds/${access.name}/${route}`,
  );
  return url.toString();
};

const headers = (access: WorldSyncAccess): Headers =>
  new Headers({ authorization: `Bearer ${access.capability}` });

const parseRevision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("World response revision is invalid.");
  }
  return Number(value);
};

const parseEntry = (value: unknown): WorldListingEntry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("World change entry is invalid.");
  }
  const row = value as Record<string, unknown>;
  const entryPath =
    typeof row.path === "string" ? validateRelativePath(row.path) : "";
  if (
    !entryPath ||
    (row.kind !== "file" && row.kind !== "dir" && row.kind !== "symlink") ||
    !Number.isSafeInteger(row.mode) ||
    !Number.isSafeInteger(row.mtime) ||
    !Number.isSafeInteger(row.size) ||
    Number(row.size) < 0 ||
    (row.kind === "file" &&
      (typeof row.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(row.sha256))) ||
    (row.kind === "symlink" && typeof row.target !== "string")
  ) {
    throw new Error("World change entry is invalid.");
  }
  return {
    path: entryPath,
    kind: row.kind,
    mode: Number(row.mode),
    mtime: Number(row.mtime),
    size: Number(row.size),
    ...(typeof row.sha256 === "string" ? { sha256: row.sha256 } : {}),
    ...(typeof row.target === "string" ? { target: row.target } : {}),
  };
};

const getChanges = async (
  access: WorldSyncAccess,
  since: number,
): Promise<WorldChanges> => {
  const response = await fetch(routeUrl(access, `changes?since=${since}`), {
    headers: headers(access),
  });
  const value = (await response.json().catch(() => null)) as unknown;
  if (
    !response.ok ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`World pull failed with HTTP ${response.status}.`);
  }
  const row = value as Record<string, unknown>;
  if (
    !Array.isArray(row.entries) ||
    !Array.isArray(row.deleted) ||
    typeof row.resync !== "boolean"
  ) {
    throw new Error("World changes response is invalid.");
  }
  const entries = row.entries.map(parseEntry);
  const deleted = row.deleted.map((entry) => {
    if (typeof entry !== "string")
      throw new Error("World deletion is invalid.");
    return validateRelativePath(entry);
  });
  return {
    revision: parseRevision(row.revision),
    entries,
    deleted,
    resync: row.resync,
  };
};

const ensureDirectoryPath = async (
  root: string,
  relative: string,
): Promise<void> => {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("World root is not a real directory.");
  }
  let current = root;
  for (const segment of validateRelativePath(relative).split("/")) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isDirectory()) continue;
      await rm(current, { recursive: true, force: true });
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await mkdir(current, { mode: 0o755 });
  }
};

const ensureParentDirectories = async (root: string, relative: string) => {
  const parent = path.posix.dirname(relative);
  if (parent !== ".") await ensureDirectoryPath(root, parent);
};

const setEntryOwnership = async (
  absolute: string,
  symlinkEntry: boolean,
): Promise<void> => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  if (symlinkEntry) await lchown(absolute, WORLD_UID, WORLD_GID);
  else await chown(absolute, WORLD_UID, WORLD_GID);
};

const setTreeOwnership = async (root: string): Promise<void> => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative ? absoluteWorldPath(root, relative) : root;
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      await lchown(absolute, WORLD_UID, WORLD_GID);
      return;
    }
    await chown(absolute, WORLD_UID, WORLD_GID);
    if (!stat.isDirectory()) return;
    for (const name of await readdir(absolute)) {
      const child = relative ? `${relative}/${name}` : name;
      if (!isWorldUnsyncedPath(child)) await walk(child);
    }
  };
  await walk("");
};

/**
 * Empty the world for an export, except what the world store never holds:
 * the unsynced subtrees, and the directories on the way to them.
 */
const clearSyncedEntries = async (
  root: string,
  relative = "",
): Promise<void> => {
  const absolute = relative ? absoluteWorldPath(root, relative) : root;
  for (const name of await readdir(absolute)) {
    const child = relative ? `${relative}/${name}` : name;
    if (isWorldUnsyncedPath(child) || isDriveCopy(child)) continue;
    const childPath = absoluteWorldPath(root, child);
    if (WORLD_UNSYNCED_PATHS.some((entry) => entry.startsWith(`${child}/`))) {
      const stat = await lstat(childPath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await clearSyncedEntries(root, child);
        continue;
      }
    }
    await rm(childPath, { recursive: true, force: true });
  }
};

const writeResponseToFile = async (
  response: Response,
  filePath: string,
  expected: WorldListingEntry & { kind: "file"; sha256: string },
): Promise<void> => {
  if (!response.ok || !response.body) {
    throw new Error(`World blob fetch failed with HTTP ${response.status}.`);
  }
  const handle = await open(
    filePath,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  const hasher = createHash("sha256");
  let size = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > expected.size || size > WORLD_FILE_LIMIT_BYTES) {
        throw new Error(`World blob size mismatch for ${expected.path}.`);
      }
      hasher.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) {
        const written = await handle.write(
          part.value,
          offset,
          part.value.byteLength - offset,
        );
        offset += written.bytesWritten;
      }
    }
  } finally {
    await handle.close();
  }
  if (size !== expected.size || hasher.digest("hex") !== expected.sha256) {
    throw new Error(`World blob integrity check failed for ${expected.path}.`);
  }
};

const applyFile = async (
  root: string,
  access: WorldSyncAccess,
  entry: WorldListingEntry & { kind: "file"; sha256: string },
): Promise<void> => {
  const paths = statePaths(root);
  await mkdir(paths.staging, { recursive: true, mode: 0o700 });
  const temporary = path.join(paths.staging, randomUUID());
  const response = await fetch(routeUrl(access, `blob/${entry.sha256}`), {
    headers: headers(access),
  });
  try {
    await writeResponseToFile(response, temporary, entry);
    await chmod(temporary, entry.mode & 0o7777);
    await utimes(temporary, entry.mtime / 1_000, entry.mtime / 1_000);
    await setEntryOwnership(temporary, false);
    await ensureParentDirectories(root, entry.path);
    const destination = absoluteWorldPath(root, entry.path);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};

/**
 * Bring one revision down onto this disk and into its base. What the world
 * reports is compared with the base, not the disk: an entry the base already
 * agrees with (this container's own push coming back, most often) is left
 * as it is, so a newer local write is never replaced by its older self. A
 * deletion removes only what the base knew about, children first, and keeps
 * a directory that still holds something only this disk has.
 */
const applyChanges = async (
  root: string,
  access: WorldSyncAccess,
  received: WorldChanges,
  base: WorldIndex,
): Promise<void> => {
  // The world store never holds these, so nothing it says may touch them.
  const changes: WorldChanges = {
    ...received,
    entries: received.entries.filter((entry) => isSyncedPath(entry.path)),
    deleted: received.deleted.filter((entry) => isSyncedPath(entry)),
  };
  for (const deleted of [...changes.deleted].sort(
    (left, right) => right.length - left.length,
  )) {
    if (!base[deleted]) continue;
    delete base[deleted];
    const absolute = absoluteWorldPath(root, deleted);
    const stat = await lstat(absolute).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await rmdir(absolute).catch((error: unknown) => {
        if (!isErrno(error, "ENOTEMPTY") && !isErrno(error, "EEXIST")) {
          throw error;
        }
      });
    } else {
      await rm(absolute, { force: true });
    }
  }
  const directories = changes.entries
    .filter(
      ({ path: entryPath, ...entry }) =>
        entry.kind === "dir" && !sameContent(base[entryPath], entry),
    )
    .sort((left, right) => left.path.length - right.path.length);
  for (const entry of directories) {
    await ensureParentDirectories(root, entry.path);
    const destination = absoluteWorldPath(root, entry.path);
    try {
      const stat = await lstat(destination);
      if (!stat.isDirectory()) {
        await rm(destination, { recursive: true, force: true });
        await mkdir(destination, { mode: entry.mode & 0o7777 });
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      await mkdir(destination, { mode: entry.mode & 0o7777 });
    }
    await chmod(destination, entry.mode & 0o7777);
    await setEntryOwnership(destination, false);
  }
  for (const entry of changes.entries) {
    if (entry.kind === "dir") continue;
    const { path: entryPath, ...indexed } = entry;
    if (sameContent(base[entryPath], indexed)) continue;
    if (entry.kind === "file" && entry.sha256) {
      await applyFile(root, access, {
        ...entry,
        kind: "file",
        sha256: entry.sha256,
      });
      base[entryPath] = indexed;
      continue;
    }
    if (entry.kind !== "symlink" || entry.target === undefined) {
      throw new Error(`World change is incomplete: ${entry.path}`);
    }
    await ensureParentDirectories(root, entry.path);
    const destination = absoluteWorldPath(root, entry.path);
    await rm(destination, { recursive: true, force: true });
    await symlink(entry.target, destination);
    await lutimes(destination, entry.mtime / 1_000, entry.mtime / 1_000);
    await setEntryOwnership(destination, true);
    base[entryPath] = indexed;
  }
  for (const entry of [...directories].reverse()) {
    const destination = absoluteWorldPath(root, entry.path);
    await utimes(destination, entry.mtime / 1_000, entry.mtime / 1_000);
    const { path: entryPath, ...indexed } = entry;
    base[entryPath] = indexed;
  }
};

const indexRestoredNodeModules = async (root: string): Promise<WorldIndex> => {
  const index: WorldIndex = {};
  let visited = 0;
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative ? absoluteWorldPath(root, relative) : root;
    for (const name of await readdir(absolute)) {
      const child = relative ? `${relative}/${name}` : name;
      if (isWorldUnsyncedPath(child)) continue;
      if (Buffer.byteLength(child, "utf8") > WORLD_PATH_LIMIT_BYTES) {
        throw new Error(`World path exceeds 1024 UTF-8 bytes: ${child}`);
      }
      if (isDriveCopy(child)) continue;
      const stat = await lstat(absoluteWorldPath(root, child));
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      visited += 1;
      if (visited > WORLD_ENTRY_LIMIT) {
        throw new Error("World projection exceeds 200000 entries.");
      }
      if (isNodeModulesDirectory(child)) {
        // A directory present in an authoritative export is durable historical
        // data, not a newly generated dependency tree. One root marker is
        // enough: listWorldProjection preserves its entire nested subtree.
        index[child] = {
          kind: "dir",
          mode: stat.mode & 0o7777,
          size: 0,
          mtime: Math.trunc(stat.mtimeMs),
        };
        continue;
      }
      await walk(child);
    }
  };
  await walk("");
  return index;
};

const extractWorldExport = async (
  root: string,
  access: WorldSyncAccess,
): Promise<WorldMarker> => {
  const response = await fetch(routeUrl(access, "export"), {
    headers: headers(access),
  });
  if (!response.ok || !response.body) {
    throw new Error(`World export failed with HTTP ${response.status}.`);
  }
  const manifestId = response.headers.get("x-stella-world-manifest") ?? "";
  const revision = parseRevision(
    Number(response.headers.get("x-stella-world-revision")),
  );
  if (!manifestId) throw new Error("World export manifest is invalid.");
  await clearSyncedEntries(root);
  const tar = spawn(
    "/usr/bin/tar",
    ["-x", "-f", "-", "-C", root, "--no-same-owner"],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  const exited = new Promise<number | null>((resolve, reject) => {
    tar.once("error", reject);
    tar.once("exit", resolve);
  });
  const reader = response.body.getReader();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    if (!tar.stdin.write(part.value)) {
      await new Promise<void>((resolve) => tar.stdin.once("drain", resolve));
    }
  }
  tar.stdin.end();
  const exitCode = await exited;
  if (exitCode !== 0)
    throw new Error(`World tar extraction exited ${exitCode}.`);
  await setTreeOwnership(root);
  return { manifestId, revision };
};

/**
 * A disk that holds exactly a world export is the base. The export's own
 * `node_modules` are durable world data, so they are listed as such; any
 * restored beside them later are not (`dependencyAdoptionLines`).
 */
const baseFromExport = async (
  root: string,
  seed: WorldIndex,
): Promise<WorldIndex> => {
  const base = (await listWorldProjection(root, seed)).index;
  await writeIndex(root, base);
  return base;
};

/**
 * The base this disk syncs against. A cold materialization leaves only a seed
 * (or nothing): the disk then holds exactly the export, and nothing has run
 * on it yet, so the disk itself becomes the base before the first revision
 * is applied.
 */
const establishedBase = async (root: string): Promise<WorldIndex> => {
  const stored = await readIndex(statePaths(root).index);
  if (stored?.complete) return stored.entries;
  return await baseFromExport(
    root,
    stored?.entries ?? (await indexRestoredNodeModules(root)),
  );
};

export const pullWorldProjection = async (args: {
  root: string;
  access: WorldSyncAccess;
}): Promise<WorldMarker> =>
  await withWorldSyncLock(args.root, async () => {
    let marker = await readWorldMarker(args.root);
    const base = await establishedBase(args.root);
    for (;;) {
      const changes = await getChanges(args.access, marker.revision);
      if (changes.resync) {
        marker = await extractWorldExport(args.root, args.access);
        await baseFromExport(
          args.root,
          await indexRestoredNodeModules(args.root),
        );
        await writeWorldMarker(args.root, marker);
        return marker;
      }
      if (changes.revision <= marker.revision) return marker;
      await applyChanges(args.root, args.access, changes, base);
      marker = { ...marker, revision: changes.revision };
      await writeIndex(args.root, base);
      await writeWorldMarker(args.root, marker);
    }
  });

const postChanges = async (
  access: WorldSyncAccess,
  changes: Readonly<{ entries: WorldListingEntry[]; deleted: string[] }>,
): Promise<{
  missingBlobs: string[];
  revision: number;
  previousRevision: number;
}> => {
  const requestHeaders = headers(access);
  requestHeaders.set("content-type", "application/json");
  const response = await fetch(routeUrl(access, "push"), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(changes),
  });
  const value = (await response.json().catch(() => null)) as {
    missingBlobs?: unknown;
    revision?: unknown;
    previousRevision?: unknown;
  } | null;
  if (
    !response.ok ||
    !value ||
    !Array.isArray(value.missingBlobs) ||
    value.missingBlobs.some(
      (sha) => typeof sha !== "string" || !/^[0-9a-f]{64}$/u.test(sha),
    )
  ) {
    throw new Error(`World push failed with HTTP ${response.status}.`);
  }
  return {
    missingBlobs: value.missingBlobs,
    revision: parseRevision(value.revision),
    previousRevision: parseRevision(value.previousRevision),
  };
};

export type WorldBlobUpload = Readonly<{
  sha256: string;
  filePath: string;
  size: number;
}>;

export type WorldBlobUploadBatch =
  | Readonly<{
      kind: "batch";
      blobs: readonly WorldBlobUpload[];
      bytes: number;
    }>
  | Readonly<{ kind: "oversize"; blob: WorldBlobUpload }>;

export const batchWorldBlobUploads = (
  blobs: readonly WorldBlobUpload[],
): WorldBlobUploadBatch[] => {
  const batches: WorldBlobUploadBatch[] = [];
  let current: WorldBlobUpload[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({ kind: "batch", blobs: current, bytes: currentBytes });
    current = [];
    currentBytes = 0;
  };
  for (const blob of blobs) {
    if (blob.size > WORLD_BLOB_BATCH_MAX_BYTES) {
      flush();
      batches.push({ kind: "oversize", blob });
      continue;
    }
    if (
      current.length >= WORLD_BLOB_BATCH_MAX_COUNT ||
      currentBytes + blob.size > WORLD_BLOB_BATCH_MAX_BYTES
    ) {
      flush();
    }
    current.push(blob);
    currentBytes += blob.size;
  }
  flush();
  return batches;
};

const hexBytes = (sha256: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error("World blob sha256 is invalid.");
  }
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16),
  );
};

const blobFrameHeader = (blob: WorldBlobUpload): Uint8Array => {
  const header = new Uint8Array(WORLD_BLOB_FRAME_HEADER_BYTES);
  header.set(hexBytes(blob.sha256));
  new DataView(header.buffer).setBigUint64(32, BigInt(blob.size), false);
  return header;
};

const batchBody = (blobs: readonly WorldBlobUpload[]): Readable =>
  Readable.from(
    (async function* () {
      for (const blob of blobs) {
        yield blobFrameHeader(blob);
        for await (const chunk of createReadStream(blob.filePath)) yield chunk;
      }
    })(),
  );

const parseBlobOutcomes = async (
  response: Response,
  expected: readonly WorldBlobUpload[],
): Promise<void> => {
  const value = (await response.json().catch(() => null)) as {
    outcomes?: unknown;
  } | null;
  const outcomes = value?.outcomes;
  if (!response.ok || !Array.isArray(outcomes)) {
    throw new Error(`World blob upload failed with HTTP ${response.status}.`);
  }
  const accepted = new Set<string>();
  for (const raw of outcomes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("World blob upload returned malformed outcomes.");
    }
    const sha256 = "sha256" in raw ? raw.sha256 : undefined;
    const acceptedValue = "accepted" in raw ? raw.accepted : undefined;
    if (
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(sha256) ||
      acceptedValue !== true
    ) {
      throw new Error("World blob upload rejected a blob.");
    }
    accepted.add(sha256);
  }
  if (
    accepted.size !== expected.length ||
    expected.some((blob) => !accepted.has(blob.sha256))
  ) {
    throw new Error("World blob upload did not accept every requested blob.");
  }
};

const uploadBlobBatch = async (
  access: WorldSyncAccess,
  batch: WorldBlobUploadBatch,
): Promise<void> => {
  const requestHeaders = headers(access);
  const blobs = batch.kind === "batch" ? batch.blobs : [batch.blob];
  let body: Readable;
  if (batch.kind === "batch") {
    requestHeaders.set("content-type", "application/vnd.stella.world-blobs");
    requestHeaders.set(
      "content-length",
      String(batch.bytes + batch.blobs.length * WORLD_BLOB_FRAME_HEADER_BYTES),
    );
    body = batchBody(batch.blobs);
  } else {
    requestHeaders.set("content-type", "application/octet-stream");
    requestHeaders.set("x-stella-world-blob-sha256", batch.blob.sha256);
    requestHeaders.set("content-length", String(batch.blob.size));
    body = createReadStream(batch.blob.filePath);
  }
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: requestHeaders,
    body: body as never,
    duplex: "half",
  };
  const response = await fetch(routeUrl(access, "push"), init);
  await parseBlobOutcomes(response, blobs);
};

const uploadWithRetry = async (
  access: WorldSyncAccess,
  batch: WorldBlobUploadBatch,
): Promise<void> => {
  try {
    await uploadBlobBatch(access, batch);
  } catch {
    await uploadBlobBatch(access, batch);
  }
};

const uploadBatches = async (
  access: WorldSyncAccess,
  batches: readonly WorldBlobUploadBatch[],
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const batch = batches[index];
      if (!batch) return;
      await uploadWithRetry(access, batch);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(WORLD_BLOB_UPLOAD_CONCURRENCY, batches.length) },
      () => worker(),
    ),
  );
};

/**
 * Send the world what this disk changed since its base, and nothing else:
 * every file created or changed here, every path the base had that is gone.
 * Other agents push into the same world from their own containers, so a
 * file this disk merely has an older copy of is never sent, and a file it
 * never saw is never deleted. Per path, the later push wins.
 *
 * A cold disk whose first pull never ran has only a seed for a base; then
 * every file reads as created, the world skips what it already holds, and
 * an older copy here can overwrite a newer one there. That is the one case
 * a push can undo another agent's write.
 */
export const pushWorldProjection = async (args: {
  root: string;
  access: WorldSyncAccess;
  hashFile?: (filePath: string) => Promise<string>;
}): Promise<WorldMarker> =>
  await withWorldSyncLock(args.root, async () => {
    const marker = await readWorldMarker(args.root);
    const stored = await readIndex(statePaths(args.root).index);
    const base = stored?.entries ?? (await indexRestoredNodeModules(args.root));
    const projection = await listWorldProjection(
      args.root,
      base,
      args.hashFile,
    );
    const entries = projection.entries.filter(
      ({ path: entryPath, ...entry }) => !sameContent(base[entryPath], entry),
    );
    const deleted = Object.keys(base).filter(
      (entryPath) => !projection.index[entryPath] && isSyncedPath(entryPath),
    );
    if (entries.length === 0 && deleted.length === 0) {
      await writeIndex(args.root, projection.index);
      return marker;
    }
    const files = new Map(
      entries
        .filter(
          (
            entry,
          ): entry is WorldListingEntry & { kind: "file"; sha256: string } =>
            entry.kind === "file" && Boolean(entry.sha256),
        )
        .map((entry) => [
          entry.sha256,
          {
            sha256: entry.sha256,
            filePath: absoluteWorldPath(args.root, entry.path),
            size: entry.size,
          },
        ]),
    );
    let pushed = await postChanges(args.access, { entries, deleted });
    while (pushed.missingBlobs.length > 0) {
      const uploads = pushed.missingBlobs.map((sha256) => {
        const upload = files.get(sha256);
        if (!upload)
          throw new Error(`World requested an unknown blob ${sha256}.`);
        return upload;
      });
      await uploadBatches(args.access, batchWorldBlobUploads(uploads));
      pushed = await postChanges(args.access, { entries, deleted });
    }
    // Only a push nothing else landed before may move the marker past the
    // revisions this disk has not pulled; otherwise the next pull brings them
    // down, this push's own revision included, which the base already holds.
    const nextMarker =
      pushed.previousRevision === marker.revision
        ? { ...marker, revision: pushed.revision }
        : marker;
    await writeIndex(args.root, projection.index);
    await writeWorldMarker(args.root, nextMarker);
    return nextMarker;
  });
