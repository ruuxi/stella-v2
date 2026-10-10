/**
 * The owner's cloud memory: plain Markdown files in their world, laid out and
 * named exactly as the desktop keeps them under `~/.stella`.
 *
 *   /workspace/world/.stella/core-memory.md
 *   /workspace/world/.stella/memories/profile.md
 *   /workspace/world/.stella/memories/index.md
 *   /workspace/world/.stella/memories/**.md
 *   /workspace/world/.stella/PERSONALITY.md
 *
 * They are ordinary world files: General agents edit them with their file
 * tools and shell, the orchestrator through `memory.*` inside `code`
 * (`createWorldMemory`, whose path rules, redaction and caps are the shared
 * ones in `memory-client.ts`), and the turn reads the resident ones fresh
 * every time (`AgentHome.readDocuments`). The world has no locks, so the last
 * write wins; `memory.write`'s `expectSha` is the one compare-and-set.
 *
 * Each of the owner's computers keeps its `~/.stella` copy the same as these
 * through `createWorldMemorySync` (the `memory.files.*` calls), which writes
 * and deletes only by compare-and-set, so a sync never loses a cloud edit.
 */

import {
  MEMORY_LIST_MAX_FILES,
  createMemoryClient,
  isSyncedMemoryPath,
  memorySha,
  prepareMemoryWrite,
  type MemoryClient,
  type MemoryFileInfo,
  type MemoryFileStore,
} from "@stella/runtime/kernel/memory/memory-client.js";
import {
  CORE_MEMORY_FILE,
  MEMORIES_DIR,
  PERSONALITY_FILE,
} from "@stella/runtime/kernel/memory/memory-layout.js";
import { worldName } from "./workspace.js";
import type { WorldEntry, WorldListingEntry } from "./world/types.js";

/** The world directory that stands for the desktop's `~/.stella`. */
export const WORLD_STELLA_DIR = ".stella";
export const WORLD_PERSONALITY_FILE = PERSONALITY_FILE;

/** What memory needs from the owner's `WorldStore`. */
export type MemoryWorld = Readonly<{
  head(): Promise<{ revision: number }>;
  stat(path: string): Promise<WorldEntry | null>;
  list(
    prefix: string,
    options: { limit: number },
  ): Promise<{ entries: WorldEntry[]; cursor?: string }>;
  readFile(path: string): Promise<Uint8Array | null>;
  remove(path: string, options: { recursive: boolean }): Promise<unknown>;
  putBlob(
    stream: ReadableStream<Uint8Array>,
    input: { sha256: string; size: number },
  ): Promise<unknown>;
  commitShell(input: {
    baseRevision: number;
    reads: { paths: string[]; children: string[] };
    entries: WorldListingEntry[];
    deleted: string[];
  }): Promise<{ status: string }>;
  /** Drop paths from every earlier checkpoint (`WorldSqlStore.purgeHistory`). */
  purgeHistory(paths: readonly string[]): Promise<number>;
}>;

/** The owner's one world, as memory reaches it. */
export const ownerMemoryWorld = async (
  worlds: Cloudflare.Env["WORLDS"],
  ownerId: string,
): Promise<MemoryWorld> => {
  const stub = worlds.getByName(await worldName(ownerId));
  return {
    head: () => stub.head(),
    stat: (path) => stub.stat(path),
    list: (prefix, options) => stub.list(prefix, options),
    readFile: (path) => stub.readFile(path),
    remove: (path, options) => stub.remove(path, options),
    putBlob: (stream, input) => stub.putBlob(stream, input),
    commitShell: (input) => stub.commitShell(input),
    purgeHistory: (paths) => stub.purgeHistory(paths),
  };
};

/** The world path of a `~/.stella`-relative path. */
export const worldStellaPath = (relative: string): string =>
  `${WORLD_STELLA_DIR}/${relative}`;

const decoder = new TextDecoder();

/** One `~/.stella`-relative file's text, or null when it does not exist. */
export const readWorldStellaText = async (
  world: MemoryWorld,
  relative: string,
): Promise<string | null> => {
  const bytes = await world.readFile(worldStellaPath(relative));
  return bytes === null ? null : decoder.decode(bytes);
};

const COMMIT_ATTEMPTS = 3;

/**
 * The owner's open memory epoch, read fresh; throws while a wipe runs. A write takes it when it starts and lands only while it
 * still holds, so a write already running when a wipe began cannot put
 * erased memory back.
 */
export type MemoryEpochFence = () => Promise<string>;

const ERASED_WHILE_WRITING =
  "memory: Stella's memory was erased while this was being written; nothing was written.";

/** Delete one world file only while it still holds `expectSha`. */
const removeIfUnchanged = async (
  target: MemoryWorld,
  path: string,
  expectSha: string,
): Promise<
  | { status: "deleted" | "missing" }
  | { status: "conflict"; actualSha: string | null }
  | { status: "busy" }
> => {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    const { revision } = await target.head();
    const current = await target.stat(path);
    if (!current) return { status: "missing" };
    if (current.kind !== "file" || current.sha256 !== expectSha) {
      return { status: "conflict", actualSha: current.sha256 ?? null };
    }
    // Lands only if nothing wrote this path after `revision`.
    const committed = await target.commitShell({
      baseRevision: revision,
      reads: { paths: [path], children: [] },
      entries: [],
      deleted: [path],
    });
    if (committed.status === "committed") return { status: "deleted" };
  }
  return { status: "busy" };
};

const createWorldMemoryStore = (
  world: () => Promise<MemoryWorld>,
  fence?: MemoryEpochFence,
): MemoryFileStore => ({
  read: async (relative) => (await world()).readFile(worldStellaPath(relative)),
  write: async (relative, bytes, sha, expectSha) => {
    const store = await world();
    const path = worldStellaPath(relative);
    const epoch = fence ? await fence() : undefined;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
      const { revision } = await store.head();
      const current = await store.stat(path);
      if (current && current.kind !== "file") {
        throw new Error(`memory: ${relative} is not a file.`);
      }
      const currentSha = current?.sha256 ?? null;
      if (expectSha !== undefined && currentSha !== expectSha) {
        return { ok: false, actualSha: currentSha };
      }
      if (currentSha === sha) return { ok: true };
      await store.putBlob(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { sha256: sha, size: bytes.byteLength },
      );
      // Lands only if nothing wrote this path after `revision`, so the
      // comparison above still holds when the file changes.
      const committed = await store.commitShell({
        baseRevision: revision,
        reads: { paths: [path], children: [] },
        entries: [
          {
            path,
            kind: "file",
            mode: current?.mode ?? 0o644,
            size: bytes.byteLength,
            sha256: sha,
          },
        ],
        deleted: [],
      });
      if (committed.status === "committed") {
        if (fence) {
          // A wipe that began meanwhile may already have swept: take this
          // write back out and refuse it.
          const held = await fence()
            .catch(() => fence())
            .then(
            (current) => current === epoch,
            () => false,
          );
          if (!held) {
            await removeIfUnchanged(store, path, sha).catch(() => undefined);
            throw new Error(ERASED_WHILE_WRITING);
          }
        }
        return { ok: true };
      }
      if (committed.status === "missing_blobs") {
        throw new Error(
          `memory: the workspace did not keep the content for ${relative}; nothing was written. Try again.`,
        );
      }
    }
    throw new Error(
      `memory: ${relative} kept changing while it was being written; nothing was written. Try again.`,
    );
  },
  list: async () => (await listWorldMemoryFiles(await world())).files,
});

/**
 * The memory files in the world (`core-memory.md`, `PERSONALITY.md`,
 * `memories/**`), and whether the `memories/` listing was cut short.
 */
const listWorldMemoryFiles = async (
  store: MemoryWorld,
): Promise<{ files: MemoryFileInfo[]; cutShort: boolean }> => {
  const [core, personality, nested] = await Promise.all([
    store.stat(worldStellaPath(CORE_MEMORY_FILE)),
    store.stat(worldStellaPath(PERSONALITY_FILE)),
    store.list(worldStellaPath(MEMORIES_DIR), {
      limit: MEMORY_LIST_MAX_FILES * 4,
    }),
  ]);
  return {
    files: [core, personality, ...nested.entries].flatMap((entry) =>
      entry?.kind === "file" && entry.sha256
        ? [
            {
              path: entry.path.slice(WORLD_STELLA_DIR.length + 1),
              size: entry.size,
              sha: entry.sha256,
              updatedAt: entry.mtime,
            },
          ]
        : [],
    ),
    cutShort: nested.cursor !== undefined,
  };
};

/**
 * The memory client over the owner's world. With `fence`, each write holds
 * to the memory epoch it started in.
 */
export const createWorldMemory = (
  world: () => Promise<MemoryWorld>,
  fence?: MemoryEpochFence,
): MemoryClient => createMemoryClient(createWorldMemoryStore(world, fence));

/**
 * Write `bytes` to a memory file only if it does not exist yet, as they are
 * (no caps: legacy content moving in). The sha written, or null when the
 * file was already there.
 */
export const createWorldMemoryFile = async (
  world: () => Promise<MemoryWorld>,
  relative: string,
  bytes: Uint8Array,
): Promise<string | null> => {
  const sha = await memorySha(bytes);
  const outcome = await createWorldMemoryStore(world).write(
    relative,
    bytes,
    sha,
    null,
  );
  return outcome.ok ? sha : null;
};

/** Largest file the desktop sync reads back; written files are far smaller. */
export const MEMORY_SYNC_READ_MAX_BYTES = 512 * 1024;

export class MemorySyncFileError extends Error {}

const syncedPath = (path: string): string => {
  if (!isSyncedMemoryPath(path)) {
    throw new MemorySyncFileError(
      `${JSON.stringify(path)} is not a memory file.`,
    );
  }
  return path;
};

/**
 * What a desktop's memory sync does to the owner's world: the synced files
 * (`isSyncedMemoryPath`) with their shas, and compare-and-set writes and
 * deletes. Writes go through the same redaction and caps as `memory.write`
 * (`prepareMemoryWrite`); `expectSha: null` writes only a file that does
 * not exist yet.
 */
export const createWorldMemorySync = (world: () => Promise<MemoryWorld>) => {
  const store = createWorldMemoryStore(world);
  return {
    /**
     * Every synced file. Refuses rather than answer a listing cut short,
     * which a computer would read as deletions.
     */
    list: async (): Promise<MemoryFileInfo[]> => {
      const { files, cutShort } = await listWorldMemoryFiles(await world());
      if (cutShort) {
        throw new MemorySyncFileError(
          "Cloud memory holds more files than sync handles.",
        );
      }
      return files.filter((file) => isSyncedMemoryPath(file.path));
    },
    read: async (
      input: string,
    ): Promise<{ content: string; sha: string } | null> => {
      const path = syncedPath(input);
      const entry = await (await world()).stat(worldStellaPath(path));
      if (!entry || entry.kind !== "file") return null;
      if (entry.size > MEMORY_SYNC_READ_MAX_BYTES) {
        throw new MemorySyncFileError(`${path} is too large to sync.`);
      }
      const bytes = await store.read(path);
      if (bytes === null) return null;
      return { content: decoder.decode(bytes), sha: await memorySha(bytes) };
    },
    write: async (
      input: string,
      content: string,
      expectSha: string | null,
    ): Promise<
      | { status: "written"; sha: string; bytes: number }
      | { status: "conflict"; actualSha: string | null }
    > => {
      const path = syncedPath(input);
      let prepared: { bytes: Uint8Array; sha: string };
      try {
        prepared = await prepareMemoryWrite(path, content);
      } catch (error) {
        throw new MemorySyncFileError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const outcome = await store.write(
        path,
        prepared.bytes,
        prepared.sha,
        expectSha,
      );
      return outcome.ok
        ? {
            status: "written",
            sha: prepared.sha,
            bytes: prepared.bytes.byteLength,
          }
        : { status: "conflict", actualSha: outcome.actualSha };
    },
    remove: async (
      input: string,
      expectSha: string,
    ): Promise<
      | { status: "deleted" | "missing" }
      | { status: "conflict"; actualSha: string | null }
    > => {
      const relative = syncedPath(input);
      const outcome = await removeIfUnchanged(
        await world(),
        worldStellaPath(relative),
        expectSha,
      );
      if (outcome.status !== "busy") return outcome;
      throw new Error(
        `memory: ${relative} kept changing while it was being deleted; nothing was deleted. Try again.`,
      );
    },
  };
};

export type WorldMemorySync = ReturnType<typeof createWorldMemorySync>;

/** Everything a memory wipe erases, as world paths. */
export const WORLD_MEMORY_WIPE_PATHS: readonly string[] = [
  worldStellaPath(CORE_MEMORY_FILE),
  worldStellaPath(MEMORIES_DIR),
  worldStellaPath(WORLD_PERSONALITY_FILE),
];

/**
 * Erase the owner's memory files from their world, the earlier checkpoints
 * included, so nothing keeps the erased content reachable; the live paths
 * removed.
 */
export const wipeWorldMemory = async (world: MemoryWorld): Promise<number> => {
  let removed = 0;
  for (const path of WORLD_MEMORY_WIPE_PATHS) {
    if (!(await world.stat(path))) continue;
    await world.remove(path, { recursive: true });
    removed += 1;
  }
  await world.purgeHistory(WORLD_MEMORY_WIPE_PATHS);
  return removed;
};
