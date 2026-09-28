import { sha256BytesHex } from "../../src/hash.js";
import type { WorkerShellChanges } from "../../src/worker-shell/protocol.js";
import type { WorkerShellWorld } from "../../src/worker-shell/workspace-fs.js";
import type { WorldEntry } from "../../src/world/types.js";

type Seed =
  | string
  | Uint8Array
  | Readonly<{ symlink: string }>
  | Readonly<{ dir: true }>
  | Readonly<{ file: string; mode: number }>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/**
 * A world-relative filesystem the worker shell can read through the same
 * calls the loopback serves. `apply` stands in for `WorldStore.commitShell`,
 * so a test can prove a run's change set is exactly what landed.
 */
export const createFakeShellWorld = async (seed: Record<string, Seed> = {}) => {
  const entries = new Map<string, WorldEntry>();
  const blobs = new Map<string, Uint8Array>();
  const calls = { stat: 0, children: 0, read: 0, putBlob: 0 };

  const ensureParents = (path: string) => {
    for (let parent = parentOf(path); parent !== ""; parent = parentOf(parent)) {
      if (!entries.has(parent)) {
        entries.set(parent, {
          path: parent,
          kind: "dir",
          mode: 0o755,
          mtime: 1,
          size: 0,
        });
      }
    }
  };

  const putFile = async (path: string, bytes: Uint8Array, mode = 0o644) => {
    const sha256 = await sha256BytesHex(bytes);
    blobs.set(sha256, bytes);
    ensureParents(path);
    entries.set(path, {
      path,
      kind: "file",
      mode,
      mtime: 1,
      size: bytes.byteLength,
      sha256,
    });
  };

  const ready = (async () => {
    for (const [path, value] of Object.entries(seed)) {
      if (typeof value === "string") await putFile(path, encoder.encode(value));
      else if (value instanceof Uint8Array) await putFile(path, value);
      else if ("symlink" in value) {
        ensureParents(path);
        entries.set(path, {
          path,
          kind: "symlink",
          mode: 0o777,
          mtime: 1,
          size: value.symlink.length,
          target: value.symlink,
        });
      } else if ("file" in value) {
        await putFile(path, encoder.encode(value.file), value.mode);
      } else {
        ensureParents(path);
        entries.set(path, { path, kind: "dir", mode: 0o755, mtime: 1, size: 0 });
      }
    }
  })();

  const world: WorkerShellWorld = {
    async stat(paths) {
      await ready;
      calls.stat += 1;
      return paths.map((path) =>
        path === ""
          ? { path: "", kind: "dir", mode: 0o755, mtime: 0, size: 0 }
          : (entries.get(path) ?? null),
      );
    },
    async children(path) {
      await ready;
      calls.children += 1;
      return [...entries.values()]
        .filter((entry) => entry.path !== "" && parentOf(entry.path) === path)
        .sort((left, right) => (left.path < right.path ? -1 : 1));
    },
    async read(path, { offset, length }) {
      await ready;
      calls.read += 1;
      const entry = entries.get(path);
      if (!entry) return null;
      if (entry.kind !== "file") throw new Error(`Path is not a file: ${path}`);
      return blobs.get(entry.sha256!)!.slice(offset, offset + length);
    },
    async putBlob(bytes) {
      calls.putBlob += 1;
      const copy = new Uint8Array(bytes);
      const sha256 = await sha256BytesHex(copy);
      blobs.set(sha256, copy);
      return { sha256, size: copy.byteLength };
    },
  };

  await ready;
  return {
    world,
    calls,
    /** Apply a change set the way `pushDiff` does: deletions, then entries. */
    apply(changes: WorkerShellChanges) {
      for (const deleted of [...changes.deleted].sort(
        (left, right) => right.length - left.length,
      )) {
        for (const path of [...entries.keys()]) {
          if (path === deleted || path.startsWith(`${deleted}/`)) {
            entries.delete(path);
          }
        }
      }
      for (const entry of [...changes.entries].sort(
        (left, right) => left.path.length - right.path.length,
      )) {
        if (entry.kind === "file" && !blobs.has(entry.sha256!)) {
          throw new Error(`missing blob for ${entry.path}`);
        }
        ensureParents(entry.path);
        entries.set(entry.path, { ...entry, mtime: entry.mtime ?? 1 });
      }
    },
    text(path: string): string | null {
      const entry = entries.get(path);
      if (!entry || entry.kind !== "file") return null;
      return decoder.decode(blobs.get(entry.sha256!)!);
    },
    entry(path: string): WorldEntry | undefined {
      return entries.get(path);
    },
    paths(): string[] {
      return [...entries.keys()].sort();
    },
  };
};
