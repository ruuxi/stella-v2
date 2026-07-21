/**
 * On-disk markdown layout owned by Dream.
 *
 * `memory_map.md` is the single resident routing layer. It replaces resident
 * use of `memory_summary.md` and `memory_index.md`; those legacy files remain
 * byte-for-byte on disk and readable for recovery, but Dream cannot write
 * them and runtime injection never consumes them after the cutover.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../shared/private-fs.js";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_MAP_FILE = "memory_map.md";
export const MEMORY_SUMMARY_FILE = "memory_summary.md";
export const MEMORY_INDEX_FILE = "memory_index.md";

/** Hard cap measured on the model-facing, HTML-comment-stripped view. */
export const MEMORY_MAP_MAX_CHARS = 6_000;
export const MEMORY_MAP_MAX_ENTRIES = 80;
export const MEMORY_MAP_STALE_DAYS = 90;

export const MEMORY_MAP_ROUTES_START_ANCHOR = "<!-- DREAM:MAP_START -->";
export const MEMORY_MAP_ROUTES_END_ANCHOR = "<!-- DREAM:MAP_END -->";
export const MEMORY_MAP_DERIVED_START_ANCHOR = "<!-- DREAM:DERIVED_START -->";
export const MEMORY_MAP_DERIVED_END_ANCHOR = "<!-- DREAM:DERIVED_END -->";
const MEMORY_MAP_MIGRATED_START_ANCHOR =
  "<!-- DREAM:MIGRATED_SUMMARY_START -->";
const MEMORY_MAP_MIGRATED_END_ANCHOR = "<!-- DREAM:MIGRATED_SUMMARY_END -->";

const MEMORY_MAP_ROUTES_PLACEHOLDER = "- No routing entries recorded yet.";
const MEMORY_MAP_DERIVED_PLACEHOLDER = "- None pending promotion.";

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

const MEMORY_MAP_CHARTER = `<!-- DREAM:MAP_CHARTER
Memory map — the single resident routing layer, maintained by Dream. It
replaces memory_summary.md and memory_index.md. Pointer-only: what memory
contains and where to find it. No narrative, no restated facts — the durable
facts live in MEMORY.md blocks; this file only routes to them.

Routing entries (between the DREAM:MAP anchors), one line each:
- <task family / topic> -> <best source> (updated YYYY-MM-DD) | aliases: <words the user actually says>
  Best source is one of: MEMORY.md <block date — title>, profile.md,
  threads:<thread_id>, or transcripts.

## Derived constraints (between the DREAM:DERIVED anchors) stages durable
constraints observed in conversation that have not yet been promoted to
profile.md via the Remember tool. One line each, tagged [derived YYYY-MM-DD].
Remove a line once it is promoted. Never edit profile.md yourself.

Hard budget: ${MEMORY_MAP_MAX_CHARS} injected characters (HTML comments are
not counted) and about ${MEMORY_MAP_MAX_ENTRIES} entries. Writes that would
exceed the budget are REJECTED with an error — curate (merge, prune, tighten)
instead of truncating. Prune entries older than ${MEMORY_MAP_STALE_DAYS} days
unless recent usage shows they are still useful. Never store secrets,
credentials, tokens, private keys, auth headers, or sensitive personal data.
Edit only with StrReplace using small unique anchors; keep every DREAM anchor
comment intact.
-->`;

const buildMemoryMapContent = (args: {
  routes: string;
  migratedSummary?: string;
}): string => {
  const sections = [
    MEMORY_MAP_CHARTER,
    "# Memory map",
    "",
    MEMORY_MAP_ROUTES_START_ANCHOR,
    args.routes,
    MEMORY_MAP_ROUTES_END_ANCHOR,
    "",
    "## Derived constraints",
    "",
    MEMORY_MAP_DERIVED_START_ANCHOR,
    MEMORY_MAP_DERIVED_PLACEHOLDER,
    MEMORY_MAP_DERIVED_END_ANCHOR,
  ];
  if (args.migratedSummary) {
    sections.push(
      "",
      "## Migrated focus notes (from memory_summary.md)",
      "",
      "<!-- One-time migration staging: rewrite each line below as a routing entry",
      "or drop it (the facts are already in MEMORY.md), then delete this whole",
      "section including its anchors. -->",
      MEMORY_MAP_MIGRATED_START_ANCHOR,
      args.migratedSummary,
      MEMORY_MAP_MIGRATED_END_ANCHOR,
    );
  }
  return `${sections.join("\n")}\n`;
};

const MEMORY_MAP_TEMPLATE = buildMemoryMapContent({
  routes: MEMORY_MAP_ROUTES_PLACEHOLDER,
});

export const memoriesRoot = (stellaDataDir: string): string =>
  path.join(stellaDataDir, "memories");

/**
 * Resolve the owned memory root without allowing the `memories` directory to
 * redirect writes through a symlink. The configured Stella data directory may
 * itself be reached through an operator-selected alias; ownership begins at
 * its canonical identity, and its direct `memories` child must be real.
 */
export const assertSafeDreamMemoryRoot = async (
  stellaDataDir: string,
): Promise<string> => {
  const root = memoriesRoot(stellaDataDir);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `Refusing Dream memory root ${root}: expected a real directory owned by Stella.`,
    );
  }
  const [canonicalDataDir, canonicalRoot] = await Promise.all([
    fs.realpath(stellaDataDir),
    fs.realpath(root),
  ]);
  const expectedRoot = path.join(canonicalDataDir, "memories");
  if (canonicalRoot !== expectedRoot) {
    throw new Error(
      `Refusing Dream memory root ${root}: canonical path escaped the Stella data directory.`,
    );
  }
  return canonicalRoot;
};

export const memoryFilePath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_FILE);

export const memoryMapPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_MAP_FILE);

/** Legacy paths are exposed only for migration and jail diagnostics. */
export const memorySummaryPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_SUMMARY_FILE);

export const memoryIndexPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_INDEX_FILE);

const readOptionalFile = async (target: string): Promise<string | null> => {
  try {
    return await fs.readFile(target, "utf-8");
  } catch {
    return null;
  }
};

/**
 * Strip retired HTML-comment transport from model-facing views. Files remain
 * untouched. An unterminated opener is stripped through EOF so malformed
 * retired content cannot leak back into a prompt.
 */
export const stripInjectedHtmlComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!--[\s\S]*$/u, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const extractAnchoredBody = (
  raw: string,
  startAnchor: string,
  endAnchor: string,
): string => {
  const start = raw.indexOf(startAnchor);
  const end = raw.indexOf(endAnchor);
  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start + startAnchor.length, end).trim();
  }
  return stripInjectedHtmlComments(raw);
};

const dropPlaceholder = (body: string, placeholder: string): string =>
  body === placeholder ? "" : body;

const truncateAtLineBoundary = (
  text: string,
  maxChars: number,
  marker: string,
): string => {
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length + 1) return "";
  const contentLimit = maxChars - marker.length - 1;
  const slice = text.slice(0, contentLimit);
  const lastNewline = slice.lastIndexOf("\n");
  const prefix = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
  return `${prefix}\n${marker}`;
};

const buildSeededMemoryMapContent = (args: {
  indexRaw: string | null;
  summaryRaw: string | null;
}): string => {
  const indexBody = args.indexRaw
    ? dropPlaceholder(
        extractAnchoredBody(
          args.indexRaw,
          "<!-- DREAM:INDEX_START -->",
          "<!-- DREAM:INDEX_END -->",
        ),
        MEMORY_MAP_ROUTES_PLACEHOLDER,
      )
    : "";
  const summaryBody = args.summaryRaw
    ? dropPlaceholder(
        extractAnchoredBody(
          args.summaryRaw,
          "<!-- DREAM:SUMMARY_START -->",
          "<!-- DREAM:SUMMARY_END -->",
        ),
        "- No active focus recorded yet.",
      )
    : "";
  if (!indexBody && !summaryBody) return MEMORY_MAP_TEMPLATE;

  const skeleton = buildMemoryMapContent({
    routes: indexBody ? "" : MEMORY_MAP_ROUTES_PLACEHOLDER,
    ...(summaryBody ? { migratedSummary: "x" } : {}),
  });
  const skeletonChars =
    stripInjectedHtmlComments(skeleton).length - (summaryBody ? 1 : 0);
  const available = Math.max(0, MEMORY_MAP_MAX_CHARS - skeletonChars);
  const routesBudget = indexBody ? Math.floor(available * 0.6) : 0;
  let routes = indexBody
    ? truncateAtLineBoundary(
        indexBody,
        routesBudget,
        `[migration cut — remaining entries preserved in ${MEMORY_INDEX_FILE}]`,
      )
    : MEMORY_MAP_ROUTES_PLACEHOLDER;
  const summaryBudget = Math.max(
    0,
    available - (indexBody ? stripInjectedHtmlComments(routes).length : 0),
  );
  let migratedSummary = summaryBody
    ? truncateAtLineBoundary(
        summaryBody,
        summaryBudget,
        `[migration cut — full text preserved in ${MEMORY_SUMMARY_FILE}]`,
      )
    : undefined;
  let seeded = buildMemoryMapContent({
    routes,
    ...(migratedSummary ? { migratedSummary } : {}),
  });

  // Exact final backstop for newline-collapsing edge cases in the visible
  // view. Tighten migrated notes first, then routes; legacy bytes remain in
  // their original files no matter how much must be folded out of the map.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const excess =
      stripInjectedHtmlComments(seeded).length - MEMORY_MAP_MAX_CHARS;
    if (excess <= 0) return seeded;
    if (migratedSummary) {
      migratedSummary = truncateAtLineBoundary(
        migratedSummary,
        Math.max(0, migratedSummary.length - excess - 1),
        `[migration cut — full text preserved in ${MEMORY_SUMMARY_FILE}]`,
      );
    } else if (indexBody) {
      routes = truncateAtLineBoundary(
        routes,
        Math.max(0, routes.length - excess - 1),
        `[migration cut — remaining entries preserved in ${MEMORY_INDEX_FILE}]`,
      );
    }
    seeded = buildMemoryMapContent({
      routes: routes || MEMORY_MAP_ROUTES_PLACEHOLDER,
      ...(migratedSummary ? { migratedSummary } : {}),
    });
  }
  return stripInjectedHtmlComments(seeded).length <= MEMORY_MAP_MAX_CHARS
    ? seeded
    : MEMORY_MAP_TEMPLATE;
};

type PublishResult = "created" | "exists";

const hasSafeExistingFile = async (target: string): Promise<boolean> => {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(
        `Refusing memory layout conflict at ${target}: expected a regular unaliased file.`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * Publish a fully-written file without overwriting a concurrently-created
 * destination. The same-directory hard link is an atomic create-if-absent;
 * a crash can leave only a hidden staging file, never a partial live map.
 */
const publishFileIfMissing = async (
  target: string,
  contents: string,
): Promise<PublishResult> => {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.migration-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(contents, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fs.link(temporary, target);
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await hasSafeExistingFile(target);
        return "exists";
      }
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
};

/**
 * Ensure the staged Dream layout.
 *
 * Unlike v1's retirement-banner rewrite, this migration has one atomic
 * mutation: create `memory_map.md` if absent. Rewriting two legacy files after
 * publishing the map cannot be made transactional on the filesystem and made
 * a crash require ambiguous rollback. v2 therefore preserves both retired
 * files byte-for-byte, copies their useful view into the create-only map, and
 * enforces retirement at the read/write ownership boundaries. A failed
 * publish leaves no live map and the next startup retries safely; an existing
 * map is treated as user-owned conflict and is never overwritten or merged.
 */
export const ensureDreamMemoryLayout = async (
  stellaDataDir: string,
): Promise<void> => {
  const root = memoriesRoot(stellaDataDir);
  try {
    const existingRoot = await fs.lstat(root);
    if (existingRoot.isSymbolicLink() || !existingRoot.isDirectory()) {
      throw new Error(
        `Refusing Dream memory root ${root}: expected a real directory owned by Stella.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensurePrivateDir(root);
  await assertSafeDreamMemoryRoot(stellaDataDir);
  await publishFileIfMissing(memoryFilePath(stellaDataDir), MEMORY_TEMPLATE);

  const mapTarget = memoryMapPath(stellaDataDir);
  if (await hasSafeExistingFile(mapTarget)) return;

  const [indexRaw, summaryRaw] = await Promise.all([
    readOptionalFile(memoryIndexPath(stellaDataDir)),
    readOptionalFile(memorySummaryPath(stellaDataDir)),
  ]);
  await publishFileIfMissing(
    mapTarget,
    buildSeededMemoryMapContent({ indexRaw, summaryRaw }),
  );
};

export const readMemoryFile = async (
  stellaDataDir: string,
): Promise<string | null> => readOptionalFile(memoryFilePath(stellaDataDir));

export const readMemoryMap = async (
  stellaDataDir: string,
): Promise<string | null> => readOptionalFile(memoryMapPath(stellaDataDir));
