/**
 * On-disk markdown layout owned by Dream.
 *
 * `memory_map.md` is the single resident routing layer. It replaces resident
 * use of `memory_summary.md` and `memory_index.md`; those legacy files remain
 * byte-for-byte on disk and readable for recovery, but Dream cannot write
 * them and runtime injection never consumes them after the cutover.
 *
 * Effect-native: every filesystem access is an Effect; file handles and the
 * cross-process SQLite migration lock are scoped resources
 * (`Effect.acquireRelease`), and the in-process migration queue is a keyed
 * `Semaphore(1)` (replacing the old promise-chain tails). Pure template /
 * parsing / truncation helpers stay plain functions. The exported Promise
 * API is a facade over the shared memory ManagedRuntime and rejects with
 * byte-identical error messages (tagged errors in `errors.ts`).
 */

import { constants as fsConstants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Effect, Semaphore } from "effect";
import { ensurePrivateDir } from "../shared/private-fs.js";
import { createRuntimeLogger } from "../debug.js";
import {
  DreamMemoryRootError,
  LegacyMemorySourceError,
  MemoryLayoutConflictError,
  MigrationSqliteUnavailableError,
  MigrationStagingError,
} from "./errors.js";
import { runMemoryPromise } from "./effect-runtime.js";
import { readOptionalTextFile, tryFs } from "./effect-io.js";

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
export const assertSafeDreamMemoryRootEffect = (
  stellaDataDir: string,
): Effect.Effect<
  string,
  DreamMemoryRootError | NodeJS.ErrnoException
> =>
  Effect.gen(function* () {
    const root = memoriesRoot(stellaDataDir);
    const stat = yield* tryFs(() => fs.lstat(root));
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return yield* Effect.fail(
        new DreamMemoryRootError({ root, reason: "not_directory" }),
      );
    }
    const [canonicalDataDir, canonicalRoot] = yield* Effect.all(
      [
        tryFs(() => fs.realpath(stellaDataDir)),
        tryFs(() => fs.realpath(root)),
      ],
      { concurrency: "unbounded" },
    );
    const expectedRoot = path.join(canonicalDataDir, "memories");
    if (canonicalRoot !== expectedRoot) {
      return yield* Effect.fail(
        new DreamMemoryRootError({ root, reason: "escaped" }),
      );
    }
    return canonicalRoot;
  });

export const assertSafeDreamMemoryRoot = (
  stellaDataDir: string,
): Promise<string> =>
  runMemoryPromise(assertSafeDreamMemoryRootEffect(stellaDataDir));

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

/** lstat with ENOENT mapped to null; other errors re-fail unchanged. */
const lstatOrNull = (
  target: string,
): Effect.Effect<Stats | null, NodeJS.ErrnoException> =>
  tryFs(() => fs.lstat(target)).pipe(
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed(null),
    ),
  );

/** An O_RDONLY(|flags) file handle as a scoped resource. */
const openScopedHandle = (target: string, flags: number) =>
  Effect.acquireRelease(
    tryFs(() => fs.open(target, flags)),
    (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
  );

const readStableLegacySourceEffect = (
  target: string,
  canonicalRoot: string,
): Effect.Effect<LegacySourceSnapshot, Error> =>
  Effect.gen(function* () {
    const pathStat = yield* lstatOrNull(target);
    if (!pathStat) return { path: target, exists: false } as const;
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.nlink !== 1
    ) {
      return yield* Effect.fail(
        new LegacyMemorySourceError({ path: target, reason: "unstable" }),
      );
    }
    const canonicalPath = yield* tryFs(() => fs.realpath(target));
    if (canonicalPath !== path.join(canonicalRoot, path.basename(target))) {
      return yield* Effect.fail(
        new LegacyMemorySourceError({ path: target, reason: "escaped" }),
      );
    }

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* openScopedHandle(
          target,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const before = yield* tryFs(() => handle.stat());
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          !sameFileIdentity(pathStat, before)
        ) {
          return yield* Effect.fail(
            new LegacyMemorySourceError({
              path: target,
              reason: "changed_before_read",
            }),
          );
        }
        const bytes = yield* tryFs(() => handle.readFile());
        const after = yield* tryFs(() => handle.stat());
        if (!sameFileIdentity(before, after)) {
          return yield* Effect.fail(
            new LegacyMemorySourceError({
              path: target,
              reason: "changed_during_read",
            }),
          );
        }
        const raw = yield* Effect.try({
          try: () => decodeUtf8Strict(bytes, target),
          catch: (error) => error as Error,
        });
        return {
          path: target,
          exists: true,
          raw,
          digest: sha256Hex(bytes),
          identity: before,
        } as const;
      }),
    );
  });

const verifyLegacySourceSnapshotEffect = (
  snapshot: LegacySourceSnapshot,
  canonicalRoot: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const current = yield* readStableLegacySourceEffect(
      snapshot.path,
      canonicalRoot,
    );
    if (!snapshot.exists || !current.exists) {
      if (snapshot.exists !== current.exists) {
        return yield* Effect.fail(
          new LegacyMemorySourceError({
            path: snapshot.path,
            reason: "changed_during_migration",
          }),
        );
      }
      return;
    }
    if (
      snapshot.digest !== current.digest ||
      !sameFileIdentity(snapshot.identity, current.identity)
    ) {
      return yield* Effect.fail(
        new LegacyMemorySourceError({
          path: snapshot.path,
          reason: "changed_during_migration",
        }),
      );
    }
  });

const isIgnorableWin32SyncError = (error: NodeJS.ErrnoException): boolean =>
  process.platform === "win32" &&
  (error.code === "EACCES" ||
    error.code === "EINVAL" ||
    error.code === "EPERM");

const syncDirectoryEffect = (
  directory: string,
): Effect.Effect<void, NodeJS.ErrnoException> =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* openScopedHandle(directory, fsConstants.O_RDONLY);
      yield* tryFs(() => handle.sync());
    }),
  ).pipe(
    Effect.catchIf(isIgnorableWin32SyncError, () => Effect.void),
  );

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

const listMigrationStagingNamesEffect = (
  target: string,
): Effect.Effect<string[], NodeJS.ErrnoException> =>
  tryFs(() => fs.readdir(path.dirname(target))).pipe(
    Effect.map((names) => {
      const genericPrefix = `.${path.basename(target)}.migration-`;
      return names.filter((name) => name.startsWith(genericPrefix));
    }),
  );

/**
 * Remove only an unattached file from this migration's reserved staging
 * namespace when its exact production-shaped name, canonical location,
 * stable inode, link count, and content digest all verify. This runs while
 * the cross-process migration lock is held, so an unattached verified stage
 * cannot belong to a live publisher. Unrecognized or aliased files are left
 * untouched.
 */
const cleanupUnattachedMigrationStagesEffect = (
  target: string,
  canonicalRoot: string,
): Effect.Effect<number, NodeJS.ErrnoException> =>
  Effect.gen(function* () {
    let removed = 0;
    for (const name of yield* listMigrationStagingNamesEffect(target)) {
      const digest = parseStagingDigest(target, name);
      if (!digest) continue;
      const stagingPath = path.join(path.dirname(target), name);
      // A candidate that cannot be proved safe (any verification failure)
      // is not migration-owned and is skipped.
      const didRemove = yield* Effect.gen(function* () {
        const pathStat = yield* tryFs(() => fs.lstat(stagingPath));
        if (
          pathStat.isSymbolicLink() ||
          !pathStat.isFile() ||
          pathStat.nlink !== 1
        ) {
          return false;
        }
        const canonicalPath = yield* tryFs(() => fs.realpath(stagingPath));
        if (canonicalPath !== path.join(canonicalRoot, name)) {
          return false;
        }
        const verified = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* openScopedHandle(
              stagingPath,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
            );
            const before = yield* tryFs(() => handle.stat());
            if (
              !before.isFile() ||
              before.nlink !== 1 ||
              !sameFileIdentity(pathStat, before)
            ) {
              return undefined;
            }
            const bytes = yield* tryFs(() => handle.readFile());
            const after = yield* tryFs(() => handle.stat());
            return sameFileIdentity(before, after) &&
              sha256Hex(bytes) === digest
              ? (after as FileIdentity)
              : undefined;
          }),
        );
        if (!verified) return false;
        const current = yield* tryFs(() => fs.lstat(stagingPath));
        if (!sameFileIdentity(verified, current) || current.nlink !== 1) {
          return false;
        }
        yield* tryFs(() => fs.unlink(stagingPath));
        return true;
      }).pipe(Effect.catch(() => Effect.succeed(false)));
      if (didRemove) removed += 1;
    }
    if (removed > 0) yield* syncDirectoryEffect(path.dirname(target));
    return removed;
  });

/**
 * A crash after link(target) but before unlink(staging) leaves two names for
 * one inode. Only the digest-bearing staging name can authorize unlinking it;
 * every link must be accounted for so an unrelated hard-link alias still
 * fails closed.
 */
const recoverPublishedStagingLinkEffect = (
  target: string,
  targetStat: Stats,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const targetBytes = yield* tryFs(() => fs.readFile(target));
    const targetDigest = sha256Hex(targetBytes);
    const linkedStages: string[] = [];
    for (const name of yield* listMigrationStagingNamesEffect(target)) {
      const digest = parseStagingDigest(target, name);
      if (!digest) {
        return yield* Effect.fail(
          new MigrationStagingError({ path: name, reason: "unverified" }),
        );
      }
      const stagingPath = path.join(path.dirname(target), name);
      const stat = yield* tryFs(() => fs.lstat(stagingPath));
      if (stat.dev !== targetStat.dev || stat.ino !== targetStat.ino) continue;
      if (!stat.isFile() || digest !== targetDigest) {
        return yield* Effect.fail(
          new MigrationStagingError({
            path: stagingPath,
            reason: "tampered_link",
          }),
        );
      }
      linkedStages.push(stagingPath);
    }
    if (linkedStages.length !== targetStat.nlink - 1) {
      return yield* Effect.fail(
        new MemoryLayoutConflictError({
          target,
          reason: "unaccounted_aliases",
        }),
      );
    }
    for (const stagingPath of linkedStages) {
      yield* tryFs(() => fs.unlink(stagingPath));
    }
    yield* syncDirectoryEffect(path.dirname(target));
    const recovered = yield* tryFs(() => fs.lstat(target));
    if (
      recovered.dev !== targetStat.dev ||
      recovered.ino !== targetStat.ino ||
      recovered.nlink !== 1
    ) {
      return yield* Effect.fail(
        new MigrationStagingError({
          path: target,
          reason: "recovery_diverged",
        }),
      );
    }
  });

const hasSafeExistingFileEffect = (
  target: string,
): Effect.Effect<boolean, Error> =>
  Effect.gen(function* () {
    const stat = yield* lstatOrNull(target);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return yield* Effect.fail(
        new MemoryLayoutConflictError({
          target,
          reason: "not_regular_file",
        }),
      );
    }
    if (stat.nlink > 1) {
      yield* recoverPublishedStagingLinkEffect(target, stat);
    }
    return true;
  });

type PublishValidation = {
  beforeLink: Effect.Effect<void, Error>;
  afterLink: Effect.Effect<void, Error>;
};

/**
 * Publish a fully-written file without overwriting a concurrently-created
 * destination. The same-directory hard link is an atomic create-if-absent;
 * a crash can leave only a hidden staging file, never a partial live map.
 *
 * Cleanup mirrors the pre-Effect try/catch/finally exactly: a failure after
 * a successful link unlinks the just-linked target (same-inode check), and
 * the staging temp file and any open handle are always released.
 */
const publishFileIfMissingEffect = (
  target: string,
  contents: string,
  validation?: PublishValidation,
): Effect.Effect<PublishResult, Error> =>
  Effect.suspend(() => {
    const digest = sha256Hex(contents);
    const temporary = path.join(
      path.dirname(target),
      `${stagingPrefix(target)}${digest}-${process.pid}-${randomUUID()}.tmp`,
    );
    let openHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let linked = false;

    const body = Effect.gen(function* () {
      if (yield* hasSafeExistingFileEffect(target)) {
        return "exists" as const;
      }
      const handle = yield* tryFs(() =>
        fs.open(
          temporary,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600,
        ),
      );
      openHandle = handle;
      yield* tryFs(() => handle.writeFile(contents, "utf-8"));
      yield* tryFs(() => handle.sync());
      yield* tryFs(() => handle.close());
      openHandle = undefined;
      if (validation) yield* validation.beforeLink;
      const linkOutcome = yield* tryFs(() => fs.link(temporary, target)).pipe(
        Effect.as("linked" as const),
        Effect.catchIf(
          (error) => error.code === "EEXIST",
          () => Effect.succeed("exists" as const),
        ),
      );
      if (linkOutcome === "exists") {
        yield* hasSafeExistingFileEffect(target);
        return "exists" as const;
      }
      linked = true;
      if (validation) yield* validation.afterLink;
      yield* syncDirectoryEffect(path.dirname(target));
      return "created" as const;
    });

    // On failure after a successful link, roll the published name back if it
    // still aliases our staging inode (the pre-Effect `catch` block).
    const rollbackLinked = Effect.gen(function* () {
      if (!linked) return;
      const [targetStat, stagingStat] = yield* Effect.all(
        [
          lstatOrNull(target).pipe(Effect.catch(() => Effect.succeed(null))),
          lstatOrNull(temporary).pipe(
            Effect.catch(() => Effect.succeed(null)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (
        targetStat &&
        stagingStat &&
        targetStat.dev === stagingStat.dev &&
        targetStat.ino === stagingStat.ino
      ) {
        yield* tryFs(() => fs.unlink(target)).pipe(Effect.ignore);
        yield* syncDirectoryEffect(path.dirname(target)).pipe(Effect.ignore);
      }
    });

    // Always release the handle and remove the staging temp (the pre-Effect
    // `finally` block); best-effort on both.
    const cleanup = Effect.promise(async () => {
      await openHandle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    });

    return body.pipe(
      Effect.tapError(() => rollbackLinked),
      Effect.ensuring(cleanup),
    );
  });

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

const loadMigrationLockDatabaseCtorEffect: Effect.Effect<
  MigrationLockDatabaseCtor,
  Error
> = Effect.gen(function* () {
  const nodeSqlite = yield* Effect.tryPromise({
    try: () => dynamicImport("node:sqlite"),
    catch: (error) => error,
  }).pipe(Effect.catch(() => Effect.succeed(null)));
  if (nodeSqlite && typeof nodeSqlite.DatabaseSync === "function") {
    return nodeSqlite.DatabaseSync as unknown as MigrationLockDatabaseCtor;
  }
  const bunSqlite = yield* Effect.tryPromise({
    try: () => dynamicImport("bun:sqlite"),
    catch: (error) => error as Error,
  });
  if (typeof bunSqlite.Database === "function") {
    return bunSqlite.Database as unknown as MigrationLockDatabaseCtor;
  }
  return yield* Effect.fail(new MigrationSqliteUnavailableError());
});

const acquireMigrationDatabaseLockEffect = (
  stellaDataDir: string,
): Effect.Effect<MigrationLockDatabase, Error> =>
  Effect.gen(function* () {
    const lockRoot = path.join(stellaDataDir, "cache");
    yield* tryFs(() => ensurePrivateDir(lockRoot));
    const Database = yield* loadMigrationLockDatabaseCtorEffect;
    const database = yield* Effect.try({
      try: () =>
        new Database(
          path.join(lockRoot, "memory-layout-migration-lock.sqlite"),
        ),
      catch: (error) => error as Error,
    });
    yield* Effect.try({
      try: () => {
        database.exec(`PRAGMA busy_timeout = ${MIGRATION_LOCK_TIMEOUT_MS}`);
        database.exec("BEGIN IMMEDIATE");
      },
      catch: (error) => error as Error,
    }).pipe(Effect.tapError(() => Effect.sync(() => database.close())));
    return database;
  });

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

/**
 * In-process FIFO serialization per canonical data dir. Queue the same
 * process first: a synchronous SQLite BEGIN waiting behind an async holder
 * would otherwise block that holder's event loop. The SQLite write
 * transaction then serializes independent app/worker processes and is
 * released by the OS on crash.
 */
const migrationSemaphores = new Map<string, Semaphore.Semaphore>();

const migrationSemaphoreForKey = (key: string): Semaphore.Semaphore => {
  const existing = migrationSemaphores.get(key);
  if (existing) return existing;
  const created = Semaphore.makeUnsafe(1);
  migrationSemaphores.set(key, created);
  return created;
};

const withDreamMemoryMigrationLockEffect = <A, E>(
  stellaDataDir: string,
  operation: Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> =>
  Effect.gen(function* () {
    const canonicalDataDir = yield* tryFs(() =>
      fs.realpath(stellaDataDir),
    ).pipe(
      Effect.catchIf(
        (error) => error.code === "ENOENT",
        () =>
          tryFs(() => ensurePrivateDir(stellaDataDir)).pipe(
            Effect.andThen(tryFs(() => fs.realpath(stellaDataDir))),
          ),
      ),
    );
    const key =
      process.platform === "linux"
        ? canonicalDataDir
        : canonicalDataDir.toLowerCase();
    return yield* migrationSemaphoreForKey(key).withPermit(
      Effect.scoped(
        Effect.acquireRelease(
          acquireMigrationDatabaseLockEffect(stellaDataDir),
          (database) =>
            Effect.sync(() => releaseMigrationDatabaseLock(database)),
        ).pipe(Effect.flatMap(() => operation)),
      ),
    );
  });

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

/** Test-only coordination point for deterministic filesystem race coverage. */
export type DreamMemoryMigrationTestHooks = {
  afterLegacySnapshotsRead?: () => void | Promise<void>;
};

const ensureDreamMemoryLayoutLockedEffect = (
  stellaDataDir: string,
  hooks?: DreamMemoryMigrationTestHooks,
): Effect.Effect<DreamMemoryLayoutTelemetry, Error> =>
  Effect.gen(function* () {
    const root = memoriesRoot(stellaDataDir);
    const existingRoot = yield* lstatOrNull(root);
    if (
      existingRoot &&
      (existingRoot.isSymbolicLink() || !existingRoot.isDirectory())
    ) {
      return yield* Effect.fail(
        new DreamMemoryRootError({ root, reason: "not_directory" }),
      );
    }
    yield* tryFs(() => ensurePrivateDir(root));
    const canonicalRoot = yield* assertSafeDreamMemoryRootEffect(stellaDataDir);
    const memoryTarget = memoryFilePath(stellaDataDir);
    const mapTarget = memoryMapPath(stellaDataDir);
    const cleanedStagingFiles =
      (yield* cleanupUnattachedMigrationStagesEffect(
        memoryTarget,
        canonicalRoot,
      )) +
      (yield* cleanupUnattachedMigrationStagesEffect(
        mapTarget,
        canonicalRoot,
      ));
    const memory = yield* publishFileIfMissingEffect(
      memoryTarget,
      MEMORY_TEMPLATE,
    );

    if (yield* hasSafeExistingFileEffect(mapTarget)) {
      return {
        memory,
        map: "exists" as const,
        legacyIndex: "not_read" as const,
        legacySummary: "not_read" as const,
        cleanedStagingFiles,
      };
    }

    const legacySnapshots = yield* Effect.all(
      [
        readStableLegacySourceEffect(
          memoryIndexPath(stellaDataDir),
          canonicalRoot,
        ),
        readStableLegacySourceEffect(
          memorySummaryPath(stellaDataDir),
          canonicalRoot,
        ),
      ],
      { concurrency: "unbounded" },
    );
    const [indexSource, summarySource] = legacySnapshots;
    if (hooks?.afterLegacySnapshotsRead) {
      const afterLegacySnapshotsRead = hooks.afterLegacySnapshotsRead;
      yield* Effect.tryPromise({
        try: async () => {
          await afterLegacySnapshotsRead();
        },
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      });
    }
    const verifyLegacySources = Effect.forEach(
      legacySnapshots,
      (snapshot) => verifyLegacySourceSnapshotEffect(snapshot, canonicalRoot),
      { discard: true },
    );
    const map = yield* publishFileIfMissingEffect(
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
      legacyIndex: indexSource.exists ? ("used" as const) : ("absent" as const),
      legacySummary: summarySource.exists
        ? ("used" as const)
        : ("absent" as const),
      cleanedStagingFiles,
    };
  });

export const ensureDreamMemoryLayoutEffect = (
  stellaDataDir: string,
  hooks?: DreamMemoryMigrationTestHooks,
): Effect.Effect<DreamMemoryLayoutTelemetry, Error> =>
  withDreamMemoryMigrationLockEffect(
    stellaDataDir,
    ensureDreamMemoryLayoutLockedEffect(stellaDataDir, hooks),
  ).pipe(
    Effect.tap((telemetry) =>
      Effect.sync(() => logger.info("dream.memory-layout", telemetry)),
    ),
    Effect.tapError((error) =>
      Effect.sync(() =>
        logger.warn("dream.memory-layout-failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  );

export const ensureDreamMemoryLayout = (
  stellaDataDir: string,
  hooks?: DreamMemoryMigrationTestHooks,
): Promise<DreamMemoryLayoutTelemetry> =>
  runMemoryPromise(ensureDreamMemoryLayoutEffect(stellaDataDir, hooks));

export const readMemoryFileEffect = (
  stellaDataDir: string,
): Effect.Effect<string | null, NodeJS.ErrnoException> =>
  readOptionalTextFile(memoryFilePath(stellaDataDir));

export const readMemoryFile = (
  stellaDataDir: string,
): Promise<string | null> =>
  runMemoryPromise(readMemoryFileEffect(stellaDataDir));

export const readMemoryMapEffect = (
  stellaDataDir: string,
): Effect.Effect<string | null, NodeJS.ErrnoException> =>
  readOptionalTextFile(memoryMapPath(stellaDataDir));

export const readMemoryMap = (
  stellaDataDir: string,
): Promise<string | null> =>
  runMemoryPromise(readMemoryMapEffect(stellaDataDir));
