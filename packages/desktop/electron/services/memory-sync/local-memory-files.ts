import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MEMORY_LIST_MAX_FILES,
  isSyncedMemoryPath,
} from "@stella/runtime/kernel/memory/memory-client.js";
import {
  CORE_MEMORY_FILE,
  MEMORIES_DIR,
  PERSONALITY_FILE,
} from "@stella/runtime/kernel/memory/memory-layout.js";

/** Directory entries one scan walks before it gives up. */
const MAX_WALK_ENTRIES = 5_000;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

type CachedHash = { mtimeMs: number; size: number; ino: number; sha: string };

/**
 * This computer's side of the memory sync: the synced files under
 * `~/.stella` (`isSyncedMemoryPath`), read, written and deleted only by
 * compare-and-set. Writes land through a temporary sibling and a rename, as
 * `disk-memory.ts` writes them, so a turn never reads half a file.
 */
export class LocalMemoryFiles {
  private readonly hashes = new Map<string, CachedHash>();

  constructor(private readonly stellaDataDir: string) {}

  absolute(relative: string): string {
    return path.join(this.stellaDataDir, ...relative.split("/"));
  }

  /**
   * Every synced file with its sha. Throws rather than return a listing cut
   * short, which a pass would read as deletions.
   */
  async scan(): Promise<Map<string, string>> {
    const relatives = [CORE_MEMORY_FILE, PERSONALITY_FILE];
    let visited = 0;
    const walk = async (relativeDir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(this.absolute(relativeDir), {
          withFileTypes: true,
        });
      } catch (error) {
        if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > MAX_WALK_ENTRIES) {
          throw new Error("memories/ holds more entries than sync handles.");
        }
        if (entry.name.startsWith(".")) continue;
        const relative = `${relativeDir}/${entry.name}`;
        if (entry.isDirectory()) await walk(relative);
        else if (entry.isFile() && isSyncedMemoryPath(relative)) {
          relatives.push(relative);
        }
      }
    };
    await walk(MEMORIES_DIR);
    if (relatives.length > MEMORY_LIST_MAX_FILES + 2) {
      throw new Error("memories/ holds more files than sync handles.");
    }
    const files = new Map<string, string>();
    for (const relative of relatives) {
      const sha = await this.sha(relative);
      if (sha !== null) files.set(relative, sha);
    }
    for (const relative of this.hashes.keys()) {
      if (!files.has(relative)) this.hashes.delete(relative);
    }
    return files;
  }

  /** A file's sha, rehashed only when its stat moved. */
  private async sha(relative: string): Promise<string | null> {
    const file = this.absolute(relative);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    const cached = this.hashes.get(relative);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.ino === stat.ino
    ) {
      return cached.sha;
    }
    const bytes = await this.read(relative);
    if (bytes === null) return null;
    const sha = sha256Hex(bytes);
    this.hashes.set(relative, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
      sha,
    });
    return sha;
  }

  async read(relative: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.absolute(relative)));
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "EISDIR") {
        return null;
      }
      throw error;
    }
  }

  private async currentSha(relative: string): Promise<string | null> {
    const bytes = await this.read(relative);
    return bytes === null ? null : sha256Hex(bytes);
  }

  /** Write `bytes` only while the file's sha is `expectSha` (`null`: absent). */
  async write(
    relative: string,
    bytes: Uint8Array,
    expectSha: string | null,
  ): Promise<boolean> {
    if ((await this.currentSha(relative)) !== expectSha) return false;
    const file = this.absolute(relative);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true });
    const mode =
      expectSha === null
        ? 0o644
        : ((await fs.stat(file).catch(() => null))?.mode ?? 0o644) & 0o777;
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
    this.hashes.delete(relative);
    return true;
  }

  /** Delete the file only while its sha is `expectSha`; true when it is gone. */
  async remove(relative: string, expectSha: string): Promise<boolean> {
    const current = await this.currentSha(relative);
    if (current === null) return true;
    if (current !== expectSha) return false;
    await fs.rm(this.absolute(relative), { force: true });
    this.hashes.delete(relative);
    return true;
  }
}
