/**
 * The desktop's memory: `memory.read` / `memory.write` / `memory.list` over
 * the memory files under `~/.stella` on disk. The path rules, redaction and
 * caps are the shared ones (`memory-client.ts`); this module only owns the
 * files. A write lands through a temporary sibling and a rename, so a reader
 * never sees half a file, and this process's writes run one at a time so the
 * `expectSha` comparison and the write cannot interleave with each other.
 * While the user has memory off, every call is refused.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MEMORY_LIST_MAX_FILES,
  createMemoryClient,
  isMemoryPath,
  type MemoryClient,
  type MemoryFileInfo,
  type MemoryFileStore,
} from "./memory-client.js";
import { CORE_MEMORY_FILE, MEMORIES_DIR } from "./memory-layout.js";

/** Directory entries one `list()` walks before it stops. */
const MAX_WALK_ENTRIES = 5_000;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

const createDiskMemoryStore = (stellaDataDir: string): MemoryFileStore => {
  const absolute = (relative: string): string =>
    path.join(stellaDataDir, ...relative.split("/"));

  const readBytes = async (relative: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await fs.readFile(absolute(relative)));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (errorCode(error) === "EISDIR") {
        throw new Error(`memory: ${relative} is a directory, not a file.`);
      }
      throw error;
    }
  };

  let writes: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writes.then(work, work);
    writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const info = async (relative: string): Promise<MemoryFileInfo | null> => {
    const file = absolute(relative);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    const bytes = await fs.readFile(file).catch(() => null);
    if (!bytes) return null;
    return {
      path: relative,
      size: bytes.byteLength,
      sha: sha256(bytes),
      updatedAt: Math.trunc(stat.mtimeMs),
    };
  };

  return {
    read: readBytes,
    write: (relative, bytes, sha, expectSha) =>
      oneAtATime(async () => {
        const file = absolute(relative);
        const current = await readBytes(relative);
        const currentSha = current ? sha256(current) : null;
        if (expectSha !== undefined && currentSha !== expectSha) {
          return { ok: false as const, actualSha: currentSha };
        }
        if (currentSha === sha) return { ok: true as const };
        const directory = path.dirname(file);
        await fs.mkdir(directory, { recursive: true });
        const mode = current
          ? ((await fs.stat(file).catch(() => null))?.mode ?? 0o644) & 0o777
          : 0o644;
        const temporary = path.join(
          directory,
          `.${path.basename(file)}.${randomUUID()}.tmp`,
        );
        try {
          await fs.writeFile(temporary, bytes, { mode });
          await fs.rename(temporary, file);
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        return { ok: true as const };
      }),
    list: async () => {
      const relatives: string[] = [CORE_MEMORY_FILE];
      let visited = 0;
      const walk = async (relativeDir: string): Promise<void> => {
        const entries = await fs
          .readdir(absolute(relativeDir), { withFileTypes: true })
          .catch(() => []);
        for (const entry of entries.sort((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          visited += 1;
          if (
            visited > MAX_WALK_ENTRIES ||
            relatives.length > MEMORY_LIST_MAX_FILES
          ) {
            return;
          }
          if (entry.name.startsWith(".")) continue;
          const relative = `${relativeDir}/${entry.name}`;
          if (entry.isDirectory()) await walk(relative);
          else if (entry.isFile() && isMemoryPath(relative)) {
            relatives.push(relative);
          }
        }
      };
      await walk(MEMORIES_DIR);
      const files = await Promise.all(relatives.map(info));
      return files.filter((file): file is MemoryFileInfo => file !== null);
    },
  };
};

/** The memory client over `stellaDataDir`, refused while `enabled()` is false. */
export const createDiskMemory = (
  stellaDataDir: string,
  enabled: () => boolean,
): MemoryClient => {
  const client = createMemoryClient(createDiskMemoryStore(stellaDataDir));
  const assertEnabled = () => {
    if (!enabled()) throw new Error("memory is turned off for this user.");
  };
  return {
    read: async (path) => {
      assertEnabled();
      return await client.read(path);
    },
    write: async (path, content, options) => {
      assertEnabled();
      return await client.write(path, content, options);
    },
    list: async () => {
      assertEnabled();
      return await client.list();
    },
  };
};
