/**
 * On-disk markdown layout the Dream agent edits.
 *
 * The Dream agent never CREATES these files — `ensureDreamMemoryLayout` seeds
 * them with stable templates the first time the scheduler runs (or on
 * startup). The agent then surgically edits them via StrReplace using the
 * unique anchor markers below.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_MAP_FILE = "memory_map.md";
export const MEMORY_MAP_MAX_CHARS = 6_000;
export const MEMORY_MAP_MAX_ENTRIES = 80;
export const MEMORY_MAP_STALE_DAYS = 90;

const MEMORY_TEMPLATE = `# MEMORY

> Canonical task-group ledger maintained by the Dream agent. Newest blocks at
> the top. Each block describes one cohesive task or thread the user has been
> working on. Stale blocks (>30 days, superseded) are moved under the trailing
> Archive heading instead of being deleted.
>
> Schema for each block (do not break the format):
>
>     ## <YYYY-MM-DD HH:MM> — <short title>
>     Threads: <thread_id>:<run_id>, ...
>     Why this matters: <one sentence>
>     Outcome: <what shipped, what is pending>
>     Recall hooks: <comma-separated keywords>

<!-- DREAM:ACTIVE_BLOCKS_START -->
<!-- DREAM:ACTIVE_BLOCKS_END -->

## Archive

<!-- DREAM:ARCHIVE_START -->
<!-- DREAM:ARCHIVE_END -->
`;

const MEMORY_MAP_TEMPLATE = `# Memory map

> Compact, discriminative routing map maintained by Dream. Keep task families,
> aliases, repo names, paths, prior-decision hooks, and the best retrieval
> source. Loaded on every Orchestrator turn and searched before deeper memory.
> Maximum ${MEMORY_MAP_MAX_ENTRIES} entries and ${MEMORY_MAP_MAX_CHARS} characters. Each entry carries an
> updated date; prune entries older than ${MEMORY_MAP_STALE_DAYS} days unless recent usage shows they remain useful.
> Never store secrets, credentials, tokens, private keys, auth headers, or
> sensitive personal data here. This file contains routing metadata only.

<!-- DREAM:MAP_START -->
- No routing entries recorded yet.
<!-- DREAM:MAP_END -->
`;

export const memoriesRoot = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "memories");

export const memoryFilePath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_FILE);

export const memoryMapPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_MAP_FILE);

const writeIfMissing = async (
  target: string,
  contents: string,
): Promise<void> => {
  try {
    await fs.access(target);
  } catch {
    await fs.writeFile(target, contents, "utf-8");
  }
};

export const ensureDreamMemoryLayout = async (
  stellaDataDir: string,
): Promise<void> => {
  const root = memoriesRoot(stellaDataDir);
  await fs.mkdir(root, { recursive: true });
  await writeIfMissing(memoryFilePath(stellaDataDir), MEMORY_TEMPLATE);
  await writeIfMissing(memoryMapPath(stellaDataDir), MEMORY_MAP_TEMPLATE);
};

export const readMemoryFile = async (
  stellaDataDir: string,
): Promise<string | null> => {
  try {
    return await fs.readFile(memoryFilePath(stellaDataDir), "utf-8");
  } catch {
    return null;
  }
};

export const readMemoryMap = async (
  stellaDataDir: string,
): Promise<string | null> => {
  try {
    return await fs.readFile(memoryMapPath(stellaDataDir), "utf-8");
  } catch {
    return null;
  }
};
