/**
 * On-disk markdown layout owned by Dream.
 *
 * `memory_map.md` is the single resident routing layer. It replaces resident
 * use of `memory_summary.md` and `memory_index.md`; those legacy files remain
 * byte-for-byte on disk and readable for recovery, but Dream cannot write
 * them and runtime injection never consumes them after the cutover.
 */

import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensurePrivateDir } from "../shared/private-fs.js";
import { createRuntimeLogger } from "../debug.js";

const logger = createRuntimeLogger("memory.dream-storage");

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_MAP_FILE = "memory_map.md";
/** Shadow-only delta proposals. Never injected and never searched by Recall. */
export const MEMORY_SHADOW_FILE = "memory_shadow.md";
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
const MIGRATION_STAGING_VERSION = "v2";

const policySection = (
  text: string,
  startAnchor: string,
  endAnchor: string,
): string | null => {
  const start = text.indexOf(startAnchor);
  const end = text.indexOf(endAnchor);
  if (
    start < 0 ||
    end < start + startAnchor.length ||
    text.indexOf(startAnchor, start + startAnchor.length) !== -1 ||
    text.indexOf(endAnchor, end + endAnchor.length) !== -1
  ) {
    return null;
  }
  return text.slice(start + startAnchor.length, end);
};

/**
 * Count model-visible routing/derived lines under the certified map policy.
 * Null means the anchor topology is ambiguous and must fail closed.
 */
export const countMemoryMapPolicyEntries = (text: string): number | null => {
  const routes = policySection(
    text,
    MEMORY_MAP_ROUTES_START_ANCHOR,
    MEMORY_MAP_ROUTES_END_ANCHOR,
  );
  const derived = policySection(
    text,
    MEMORY_MAP_DERIVED_START_ANCHOR,
    MEMORY_MAP_DERIVED_END_ANCHOR,
  );
  if (routes === null || derived === null) return null;
  const placeholders = new Set([
    MEMORY_MAP_ROUTES_PLACEHOLDER,
    MEMORY_MAP_DERIVED_PLACEHOLDER,
  ]);
  return [routes, derived]
    .flatMap((section) => blankInjectedHtmlComments(section).split(/\r?\n/u))
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !placeholders.has(line)).length;
};

export const unicodeCodePointLength = (text: string): number =>
  Array.from(text).length;

export const containsLoneUnicodeSurrogate = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const sha256Hex = (contents: string | Uint8Array): string =>
  createHash("sha256").update(contents).digest("hex");

const MEMORY_TEMPLATE = `# MEMORY

> Canonical task-group ledger maintained by the Dream agent. Newest blocks at
> the top. Each block describes one cohesive task or thread the user has been
> working on. Supersede, don't append: keep one active block per workstream
> and rewrite it in place as outcomes change. Removed text is preserved in
> archive/MEMORY-superseded.md. The runtime size-rotates old dated blocks into
> quarterly files under archive/; neither Dream nor rotation deletes history.
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

export const memoryShadowPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_SHADOW_FILE);

/** Legacy paths are exposed only for migration and jail diagnostics. */
export const memorySummaryPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_SUMMARY_FILE);

export const memoryIndexPath = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_INDEX_FILE);

const readOptionalFile = async (target: string): Promise<string | null> => {
  try {
    return await fs.readFile(target, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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

/**
 * Blank injected HTML comments without removing their newlines. Recall uses
 * this for line-oriented map search so comment-only terms cannot match while
 * reported line numbers remain aligned with the on-disk file. An unterminated
 * opener is blanked through EOF, matching the stripping variant above.
 */
export const blankInjectedHtmlComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ""))
    .replace(/<!--[\s\S]*$/u, (comment) => comment.replace(/[^\n]/gu, ""));

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

/**
 * Bound by Unicode code points while retaining only complete source lines.
 * CRLF is one indivisible line ending; an overlong first line is omitted
 * instead of being sliced through an emoji, combining sequence, or entry.
 */
export const truncateUnicodeAtLineBoundary = (
  text: string,
  maxChars: number,
  marker: string,
): string => {
  if (unicodeCodePointLength(text) <= maxChars) return text;
  const markerChars = unicodeCodePointLength(marker);
  if (maxChars < markerChars) return "";
  const prefixBudget = maxChars - markerChars;
  let prefix = "";
  const completeLinePattern = /[^\r\n]*(?:\r\n|\r|\n)/gu;
  for (const match of text.matchAll(completeLinePattern)) {
    const candidate = `${prefix}${match[0]}`;
    if (unicodeCodePointLength(candidate) > prefixBudget) break;
    prefix = candidate;
  }
  return `${prefix}${marker}`;
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
    unicodeCodePointLength(stripInjectedHtmlComments(skeleton)) -
    (summaryBody ? 1 : 0);
  const available = Math.max(0, MEMORY_MAP_MAX_CHARS - skeletonChars);
  const routesBudget = indexBody ? Math.floor(available * 0.6) : 0;
  let routes = indexBody
    ? truncateUnicodeAtLineBoundary(
        indexBody,
        routesBudget,
        `[migration cut — remaining entries preserved in ${MEMORY_INDEX_FILE}]`,
      )
    : MEMORY_MAP_ROUTES_PLACEHOLDER;
  const routeLines = routes.split(/\r?\n/u);
  if (routeLines.length > MEMORY_MAP_MAX_ENTRIES) {
    routes = [
      ...routeLines.slice(0, MEMORY_MAP_MAX_ENTRIES - 1),
      `[migration cut — remaining entries preserved in ${MEMORY_INDEX_FILE}]`,
    ].join("\n");
  }
  const summaryBudget = Math.max(
    0,
    available -
      (indexBody
        ? unicodeCodePointLength(stripInjectedHtmlComments(routes))
        : 0),
  );
  let migratedSummary = summaryBody
    ? truncateUnicodeAtLineBoundary(
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
      unicodeCodePointLength(stripInjectedHtmlComments(seeded)) -
      MEMORY_MAP_MAX_CHARS;
    if (excess <= 0) return seeded;
    if (migratedSummary) {
      migratedSummary = truncateUnicodeAtLineBoundary(
        migratedSummary,
        Math.max(0, unicodeCodePointLength(migratedSummary) - excess - 1),
        `[migration cut — full text preserved in ${MEMORY_SUMMARY_FILE}]`,
      );
    } else if (indexBody) {
      routes = truncateUnicodeAtLineBoundary(
        routes,
        Math.max(0, unicodeCodePointLength(routes) - excess - 1),
        `[migration cut — remaining entries preserved in ${MEMORY_INDEX_FILE}]`,
      );
    }
    seeded = buildMemoryMapContent({
      routes: routes || MEMORY_MAP_ROUTES_PLACEHOLDER,
      ...(migratedSummary ? { migratedSummary } : {}),
    });
  }
  return unicodeCodePointLength(stripInjectedHtmlComments(seeded)) <=
    MEMORY_MAP_MAX_CHARS
    ? seeded
    : MEMORY_MAP_TEMPLATE;
};

type PublishResult = "created" | "exists";

type FileIdentity = Pick<
  Stats,
  "dev" | "ino" | "mode" | "nlink" | "size" | "mtimeMs" | "ctimeMs"
>;

type LegacySourceSnapshot =
  | { path: string; exists: false }
  | {
      path: string;
      exists: true;
      raw: string;
      digest: string;
      identity: FileIdentity;
    };

const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const decodeUtf8Strict = (bytes: Uint8Array, filePath: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Refusing invalid UTF-8 memory source ${filePath}.`, {
      cause: error,
    });
  }
};

const readStableLegacySource = async (
  target: string,
  canonicalRoot: string,
): Promise<LegacySourceSnapshot> => {
  let pathStat: Stats;
  try {
    pathStat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: target, exists: false };
    }
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) {
    throw new Error(
      `Refusing legacy memory source ${target}: expected a stable regular unaliased file.`,
    );
  }
  const canonicalPath = await fs.realpath(target);
  if (canonicalPath !== path.join(canonicalRoot, path.basename(target))) {
    throw new Error(
      `Refusing legacy memory source ${target}: canonical path escaped the owned memory root.`,
    );
  }

  const handle = await fs.open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !sameFileIdentity(pathStat, before)
    ) {
      throw new Error(`Legacy memory source changed before read: ${target}.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) {
      throw new Error(`Legacy memory source changed during read: ${target}.`);
    }
    return {
      path: target,
      exists: true,
      raw: decodeUtf8Strict(bytes, target),
      digest: sha256Hex(bytes),
      identity: before,
    };
  } finally {
    await handle.close();
  }
};

const verifyLegacySourceSnapshot = async (
  snapshot: LegacySourceSnapshot,
  canonicalRoot: string,
): Promise<void> => {
  const current = await readStableLegacySource(snapshot.path, canonicalRoot);
  if (!snapshot.exists || !current.exists) {
    if (snapshot.exists !== current.exists) {
      throw new Error(
        `Legacy memory source changed during migration: ${snapshot.path}.`,
      );
    }
    return;
  }
  if (
    snapshot.digest !== current.digest ||
    !sameFileIdentity(snapshot.identity, current.identity)
  ) {
    throw new Error(
      `Legacy memory source changed during migration: ${snapshot.path}.`,
    );
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      (code === "EACCES" || code === "EINVAL" || code === "EPERM")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const stagingPrefix = (target: string): string =>
  `.${path.basename(target)}.migration-${MIGRATION_STAGING_VERSION}-`;

const parseStagingDigest = (
  target: string,
  candidateName: string,
): string | null => {
  const prefix = stagingPrefix(target);
  if (!candidateName.startsWith(prefix) || !candidateName.endsWith(".tmp")) {
    return null;
  }
  const remainder = candidateName.slice(prefix.length, -4);
  const match =
    /^([a-f0-9]{64})-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
      remainder,
    );
  return match?.[1] ?? null;
};

const listMigrationStagingNames = async (target: string): Promise<string[]> => {
  const genericPrefix = `.${path.basename(target)}.migration-`;
  return (await fs.readdir(path.dirname(target))).filter((name) =>
    name.startsWith(genericPrefix),
  );
};

/**
 * Remove only an unattached file from this migration's reserved staging
 * namespace when its exact production-shaped name, canonical location,
 * stable inode, link count, and content digest all verify. This runs while
 * the cross-process migration lock is held, so an unattached verified stage
 * cannot belong to a live publisher. Unrecognized or aliased files are left
 * untouched.
 */
const cleanupUnattachedMigrationStages = async (
  target: string,
  canonicalRoot: string,
): Promise<number> => {
  let removed = 0;
  for (const name of await listMigrationStagingNames(target)) {
    const digest = parseStagingDigest(target, name);
    if (!digest) continue;
    const stagingPath = path.join(path.dirname(target), name);
    try {
      const pathStat = await fs.lstat(stagingPath);
      if (
        pathStat.isSymbolicLink() ||
        !pathStat.isFile() ||
        pathStat.nlink !== 1
      ) {
        continue;
      }
      if ((await fs.realpath(stagingPath)) !== path.join(canonicalRoot, name)) {
        continue;
      }
      const handle = await fs.open(
        stagingPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let verified: FileIdentity | undefined;
      try {
        const before = await handle.stat();
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          !sameFileIdentity(pathStat, before)
        ) {
          continue;
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (sameFileIdentity(before, after) && sha256Hex(bytes) === digest) {
          verified = after;
        }
      } finally {
        await handle.close();
      }
      if (!verified) continue;
      const current = await fs.lstat(stagingPath);
      if (!sameFileIdentity(verified, current) || current.nlink !== 1) continue;
      await fs.unlink(stagingPath);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A candidate that cannot be proved safe is not migration-owned.
        continue;
      }
    }
  }
  if (removed > 0) await syncDirectory(path.dirname(target));
  return removed;
};

/**
 * A crash after link(target) but before unlink(staging) leaves two names for
 * one inode. Only the digest-bearing staging name can authorize unlinking it;
 * every link must be accounted for so an unrelated hard-link alias still
 * fails closed.
 */
const recoverPublishedStagingLink = async (
  target: string,
  targetStat: Stats,
): Promise<void> => {
  const targetBytes = await fs.readFile(target);
  const targetDigest = sha256Hex(targetBytes);
  const linkedStages: string[] = [];
  for (const name of await listMigrationStagingNames(target)) {
    const digest = parseStagingDigest(target, name);
    if (!digest) {
      throw new Error(
        `Refusing unverified memory migration staging artifact ${name}.`,
      );
    }
    const stagingPath = path.join(path.dirname(target), name);
    const stat = await fs.lstat(stagingPath);
    if (stat.dev !== targetStat.dev || stat.ino !== targetStat.ino) continue;
    if (!stat.isFile() || digest !== targetDigest) {
      throw new Error(
        `Refusing tampered linked migration staging artifact ${stagingPath}.`,
      );
    }
    linkedStages.push(stagingPath);
  }
  if (linkedStages.length !== targetStat.nlink - 1) {
    throw new Error(
      `Refusing memory layout conflict at ${target}: unaccounted hard-link aliases remain.`,
    );
  }
  for (const stagingPath of linkedStages) await fs.unlink(stagingPath);
  await syncDirectory(path.dirname(target));
  const recovered = await fs.lstat(target);
  if (
    recovered.dev !== targetStat.dev ||
    recovered.ino !== targetStat.ino ||
    recovered.nlink !== 1
  ) {
    throw new Error(
      `Memory migration staging recovery did not converge for ${target}.`,
    );
  }
};

const hasSafeExistingFile = async (target: string): Promise<boolean> => {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Refusing memory layout conflict at ${target}: expected a regular unaliased file.`,
      );
    }
    if (stat.nlink > 1) await recoverPublishedStagingLink(target, stat);
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
  validation?: {
    beforeLink: () => Promise<void>;
    afterLink: () => Promise<void>;
  },
): Promise<PublishResult> => {
  if (await hasSafeExistingFile(target)) return "exists";
  const digest = sha256Hex(contents);
  const temporary = path.join(
    path.dirname(target),
    `${stagingPrefix(target)}${digest}-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let linked = false;
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
    await validation?.beforeLink();
    try {
      await fs.link(temporary, target);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await hasSafeExistingFile(target);
        return "exists";
      }
      throw error;
    }
    await validation?.afterLink();
    await syncDirectory(path.dirname(target));
    return "created";
  } catch (error) {
    if (linked) {
      const [targetStat, stagingStat] = await Promise.all([
        fs.lstat(target).catch(() => null),
        fs.lstat(temporary).catch(() => null),
      ]);
      if (
        targetStat &&
        stagingStat &&
        targetStat.dev === stagingStat.dev &&
        targetStat.ino === stagingStat.ino
      ) {
        await fs.unlink(target).catch(() => undefined);
        await syncDirectory(path.dirname(target)).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
};

const migrationQueueTails = new Map<string, Promise<void>>();
const MIGRATION_LOCK_TIMEOUT_MS = 10_000;

type MigrationLockDatabase = {
  exec: (sql: string) => void;
  close: () => void;
};

type MigrationLockDatabaseCtor = new (
  filePath: string,
) => MigrationLockDatabase;

const dynamicImport = (specifier: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;

const loadMigrationLockDatabaseCtor =
  async (): Promise<MigrationLockDatabaseCtor> => {
    try {
      const nodeSqlite = await dynamicImport("node:sqlite");
      if (typeof nodeSqlite.DatabaseSync === "function") {
        return nodeSqlite.DatabaseSync as MigrationLockDatabaseCtor;
      }
    } catch {}
    const bunSqlite = await dynamicImport("bun:sqlite");
    if (typeof bunSqlite.Database === "function") {
      return bunSqlite.Database as MigrationLockDatabaseCtor;
    }
    throw new Error(
      "No compatible SQLite runtime is available for memory migration locking.",
    );
  };

const acquireMigrationDatabaseLock = async (
  stellaDataDir: string,
): Promise<MigrationLockDatabase> => {
  const lockRoot = path.join(stellaDataDir, "cache");
  await ensurePrivateDir(lockRoot);
  const Database = await loadMigrationLockDatabaseCtor();
  const database = new Database(
    path.join(lockRoot, "memory-layout-migration-lock.sqlite"),
  );
  try {
    database.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
    database.exec("BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const releaseMigrationDatabaseLock = (
  database: MigrationLockDatabase,
): void => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Process death or a compromised connection already released the lock.
  } finally {
    database.close();
  }
};

const withDreamMemoryMigrationLock = async <T>(
  stellaDataDir: string,
  operation: () => Promise<T>,
): Promise<T> => {
  // Queue the same process first: a synchronous SQLite BEGIN waiting behind
  // an async holder would otherwise block that holder's event loop. The
  // SQLite write transaction then serializes independent app/worker processes
  // and is released by the OS on crash.
  let canonicalDataDir: string;
  try {
    canonicalDataDir = await fs.realpath(stellaDataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await ensurePrivateDir(stellaDataDir);
    canonicalDataDir = await fs.realpath(stellaDataDir);
  }
  const key =
    process.platform === "linux"
      ? canonicalDataDir
      : canonicalDataDir.toLowerCase();
  const previous = migrationQueueTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  migrationQueueTails.set(key, turn);
  await previous;
  let database: MigrationLockDatabase | undefined;
  try {
    database = await acquireMigrationDatabaseLock(stellaDataDir);
    return await operation();
  } finally {
    if (database) releaseMigrationDatabaseLock(database);
    release();
    if (migrationQueueTails.get(key) === turn) migrationQueueTails.delete(key);
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
 * publish leaves no live map and the next startup retries safely. Once a
 * verified map exists it is authoritative: later edits to retired legacy
 * files are ignored, including when a retry first has to remove a verified
 * same-inode staging link left beside that already-published map.
 */
export type DreamMemoryLayoutTelemetry = {
  memory: PublishResult;
  map: PublishResult;
  legacyIndex: "used" | "absent" | "not_read";
  legacySummary: "used" | "absent" | "not_read";
  cleanedStagingFiles: number;
};

const ensureDreamMemoryLayoutLocked = async (
  stellaDataDir: string,
): Promise<DreamMemoryLayoutTelemetry> => {
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
  const canonicalRoot = await assertSafeDreamMemoryRoot(stellaDataDir);
  const memoryTarget = memoryFilePath(stellaDataDir);
  const mapTarget = memoryMapPath(stellaDataDir);
  const cleanedStagingFiles =
    (await cleanupUnattachedMigrationStages(memoryTarget, canonicalRoot)) +
    (await cleanupUnattachedMigrationStages(mapTarget, canonicalRoot));
  const memory = await publishFileIfMissing(memoryTarget, MEMORY_TEMPLATE);

  if (await hasSafeExistingFile(mapTarget)) {
    return {
      memory,
      map: "exists",
      legacyIndex: "not_read",
      legacySummary: "not_read",
      cleanedStagingFiles,
    };
  }

  const legacySnapshots = await Promise.all([
    readStableLegacySource(memoryIndexPath(stellaDataDir), canonicalRoot),
    readStableLegacySource(memorySummaryPath(stellaDataDir), canonicalRoot),
  ]);
  const [indexSource, summarySource] = legacySnapshots;
  const verifyLegacySources = async (): Promise<void> => {
    for (const snapshot of legacySnapshots) {
      await verifyLegacySourceSnapshot(snapshot, canonicalRoot);
    }
  };
  const map = await publishFileIfMissing(
    mapTarget,
    buildSeededMemoryMapContent({
      indexRaw: indexSource.exists ? indexSource.raw : null,
      summaryRaw: summarySource.exists ? summarySource.raw : null,
    }),
    { beforeLink: verifyLegacySources, afterLink: verifyLegacySources },
  );
  return {
    memory,
    map,
    legacyIndex: indexSource.exists ? "used" : "absent",
    legacySummary: summarySource.exists ? "used" : "absent",
    cleanedStagingFiles,
  };
};

export const ensureDreamMemoryLayout = async (
  stellaDataDir: string,
): Promise<DreamMemoryLayoutTelemetry> => {
  try {
    const telemetry = await withDreamMemoryMigrationLock(stellaDataDir, () =>
      ensureDreamMemoryLayoutLocked(stellaDataDir),
    );
    logger.info("dream.memory-layout", telemetry);
    return telemetry;
  } catch (error) {
    logger.warn("dream.memory-layout-failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

export const readMemoryFile = async (
  stellaDataDir: string,
): Promise<string | null> => readOptionalFile(memoryFilePath(stellaDataDir));

export const readMemoryMap = async (
  stellaDataDir: string,
): Promise<string | null> => readOptionalFile(memoryMapPath(stellaDataDir));
