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
 */

import {
  MEMORY_LIST_MAX_FILES,
  createMemoryClient,
  type MemoryClient,
  type MemoryFileStore,
} from "@stella/runtime/kernel/memory/memory-client.js";
import {
  CORE_MEMORY_FILE,
  MEMORIES_DIR,
} from "@stella/runtime/kernel/memory/memory-layout.js";
import { worldName } from "./workspace.js";
import type { WorldEntry, WorldListingEntry } from "./world/types.js";

/** The world directory that stands for the desktop's `~/.stella`. */
export const WORLD_STELLA_DIR = ".stella";
export const WORLD_PERSONALITY_FILE = "PERSONALITY.md";

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

const createWorldMemoryStore = (
  world: () => Promise<MemoryWorld>,
): MemoryFileStore => ({
  read: async (relative) => (await world()).readFile(worldStellaPath(relative)),
  write: async (relative, bytes, sha, expectSha) => {
    const store = await world();
    const path = worldStellaPath(relative);
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
      if (committed.status === "committed") return { ok: true };
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
  list: async () => {
    const store = await world();
    const [core, nested] = await Promise.all([
      store.stat(worldStellaPath(CORE_MEMORY_FILE)),
      store.list(worldStellaPath(MEMORIES_DIR), {
        limit: MEMORY_LIST_MAX_FILES * 4,
      }),
    ]);
    return [core, ...nested.entries].flatMap((entry) =>
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
    );
  },
});

/** The memory client over the owner's world. */
export const createWorldMemory = (
  world: () => Promise<MemoryWorld>,
): MemoryClient => createMemoryClient(createWorldMemoryStore(world));

/** Everything a memory wipe erases, as world paths. */
export const WORLD_MEMORY_WIPE_PATHS: readonly string[] = [
  worldStellaPath(CORE_MEMORY_FILE),
  worldStellaPath(MEMORIES_DIR),
  worldStellaPath(WORLD_PERSONALITY_FILE),
];

/** Erase the owner's memory files from their world; the paths removed. */
export const wipeWorldMemory = async (world: MemoryWorld): Promise<number> => {
  let removed = 0;
  for (const path of WORLD_MEMORY_WIPE_PATHS) {
    if (!(await world.stat(path))) continue;
    await world.remove(path, { recursive: true });
    removed += 1;
  }
  return removed;
};
