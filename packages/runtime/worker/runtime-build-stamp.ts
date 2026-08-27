import crypto from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

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

    }
    lines.push(`${relPath}\n${size}\n${mtimeMs}`);
  }
};

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
