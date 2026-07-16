import crypto from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Runtime code-identity stamp used by the staleness handshake between the
 * Electron host and the detached runtime worker.
 *
 * The detached worker deliberately outlives the Electron host (grace window
 * so in-flight agent runs survive a desktop restart). The cost: a host that
 * reconnects after a desktop update can silently adopt a worker running old
 * runtime code. This stamp makes that detectable:
 *
 *   - The worker computes the stamp of the runtime tree it loaded at boot
 *     and writes it to `~/.stella/runtime/<rootHash>/build-stamp.txt`
 *     (see `WorkerLifecycleServer.start`).
 *   - The host, when it attaches to an existing worker, recomputes the stamp
 *     from the on-disk tree and compares. Mismatch (or a missing worker
 *     stamp, i.e. a pre-stamp worker) means "stale worker" — the host then
 *     restarts it immediately when idle, or defers until quiescence.
 *
 * The stamp is stat-based (relative path + size + mtimeMs) over the files
 * in the runtime tree. No file contents are read, so computing it is a cheap
 * directory walk. A
 * real code change virtually always changes size or mtime; mtime-preserving
 * copies with identical sizes are the only blind spot and don't occur in
 * the desktop-update path.
 */

/** Sentinel returned when the stamp cannot be computed (missing tree, IO error). */
export const RUNTIME_BUILD_STAMP_UNAVAILABLE = "unavailable";

const STAMPED_FILE_SUFFIXES = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];

const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "browser-data",
  "bun-transpiler-cache",
]);

const HOST_OWNED_RUNTIME_PREFIXES = [
  "kernel/convex-urls",
  "kernel/dev-projects/",
  "kernel/home/",
  "kernel/local-scheduler-service",
  "kernel/preferences/local-preferences",
  "kernel/shared/",
  "kernel/storage/",
  "kernel/tools/network-guards",
  "kernel/tools/stella-browser-bridge-config",
];

const hasStampedSuffix = (name: string): boolean => {
  const lower = name.toLowerCase();
  return STAMPED_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

/**
 * The worker entry lives at `<bundleRoot>/worker/entry.js` (bundled) or
 * `<repoRoot>/packages/runtime/worker/entry.ts` (unbundled/vitest). Either way the
 * runtime tree root is one directory up from the entry's directory.
 */
export const resolveRuntimeBundleRoot = (workerEntryPath: string): string =>
  path.resolve(path.dirname(workerEntryPath), "..");

const collectStampLines = (
  rootDir: string,
  currentDir: string,
  lines: string[],
): void => {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(name)) continue;
      collectStampLines(rootDir, path.join(currentDir, name), lines);
      continue;
    }
    if (!entry.isFile() || !hasStampedSuffix(name)) continue;
    const absPath = path.join(currentDir, name);
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, "/");
    if (
      HOST_OWNED_RUNTIME_PREFIXES.some((prefix) => relPath.startsWith(prefix))
    ) {
      continue;
    }
    let size = 0;
    let mtimeMs = 0;
    try {
      const stats = statSync(absPath);
      size = stats.size;
      mtimeMs = Math.round(stats.mtimeMs);
    } catch {
      // File vanished mid-walk (concurrent rebuild); record presence only.
    }
    lines.push(`${relPath}\n${size}\n${mtimeMs}`);
  }
};

/**
 * Compute the runtime build stamp for the tree containing `workerEntryPath`.
 * Returns `RUNTIME_BUILD_STAMP_UNAVAILABLE` when the tree can't be walked —
 * callers must treat that as "unknown", never as a definite mismatch.
 */
export const computeRuntimeBuildStamp = (workerEntryPath: string): string => {
  const trimmedEntry = workerEntryPath?.trim();
  if (!trimmedEntry) return RUNTIME_BUILD_STAMP_UNAVAILABLE;
  try {
    const rootDir = resolveRuntimeBundleRoot(trimmedEntry);
    const lines: string[] = [];
    collectStampLines(rootDir, rootDir, lines);
    if (lines.length === 0) return RUNTIME_BUILD_STAMP_UNAVAILABLE;
    lines.sort();
    return crypto
      .createHash("sha256")
      .update(lines.join("\0"))
      .digest("hex")
      .slice(0, 32);
  } catch {
    return RUNTIME_BUILD_STAMP_UNAVAILABLE;
  }
};
