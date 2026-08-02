/**
 * Non-destructive MEMORY.md lifecycle.
 *
 * Dream edits preserve removed spans in a Recall-visible supersede journal.
 * Completed Dream passes size-rotate the oldest dated blocks into quarterly
 * archives. Archive copies land and fsync before the active ledger changes;
 * every replacement is atomic and verified, so retries may duplicate work
 * transiently but cannot lose a block.
 *
 * Effect-native: all reads/writes are Effects and the per-file critical
 * sections run under the same cross-tool write lock the file tools use
 * (`withFileWriteLockEffect`). Parsing/selection stays pure. The exported
 * Promise API is a facade over the shared memory ManagedRuntime.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Effect } from "effect";

import { createRuntimeLogger } from "../debug.js";
import {
  canonicalFileWriteLockPath,
  writeFileAtomicWithVerify,
} from "../tools/file-write-lock.js";
import { memoriesRoot, memoryFilePath } from "./dream-storage.js";
import { runMemoryPromise } from "./effect-runtime.js";
import {
  readOptionalTextFile,
  tryFs,
  withFileWriteLockEffect,
} from "./effect-io.js";

const logger = createRuntimeLogger("memory.memory-rotation");

export const MEMORY_ARCHIVE_DIR_NAME = "archive";
export const MEMORY_ROTATION_THRESHOLD_BYTES = 300_000;
export const MEMORY_ROTATION_TARGET_BYTES = 240_000;
export const MEMORY_ROTATION_MIN_ACTIVE_BLOCKS = 5;
export const MEMORY_SUPERSEDED_ARCHIVE_FILE = "MEMORY-superseded.md";

export const memoryArchiveRoot = (stellaDataDir: string): string =>
  path.join(memoriesRoot(stellaDataDir), MEMORY_ARCHIVE_DIR_NAME);

export const memorySupersededArchivePath = (stellaDataDir: string): string =>
  path.join(memoryArchiveRoot(stellaDataDir), MEMORY_SUPERSEDED_ARCHIVE_FILE);

export const archiveFileNameForBlockDate = (isoDate: string): string => {
  const [year, month] = isoDate.split("-");
  const quarter = Math.floor((Number(month) - 1) / 3) + 1;
  return `MEMORY-${year}-Q${quarter}.md`;
};

export const listMemoryArchiveFilesEffect = (
  stellaDataDir: string,
): Effect.Effect<string[], NodeJS.ErrnoException> =>
  tryFs(() => fs.readdir(memoryArchiveRoot(stellaDataDir))).pipe(
    Effect.map((names) =>
      names.filter((name) => name.endsWith(".md")).sort(),
    ),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.succeed([] as string[]),
    ),
  );

export const listMemoryArchiveFiles = (
  stellaDataDir: string,
): Promise<string[]> => runMemoryPromise(listMemoryArchiveFilesEffect(stellaDataDir));

const ACTIVE_START = "<!-- DREAM:ACTIVE_BLOCKS_START -->";
const ACTIVE_END = "<!-- DREAM:ACTIVE_BLOCKS_END -->";
const ARCHIVE_START = "<!-- DREAM:ARCHIVE_START -->";
const ARCHIVE_END = "<!-- DREAM:ARCHIVE_END -->";
const BLOCK_DATE_RE = /^## (\d{4}-\d{2}-\d{2})/u;

const archiveHeader = (name: string): string =>
  [
    `# MEMORY archive — ${name.replace(/^MEMORY-|\.md$/gu, "")}`,
    "",
    "> Blocks rotated from MEMORY.md. Recall searches this file; Dream must",
    "> never edit or delete it.",
    "",
  ].join("\n");

const supersededHeader = (): string =>
  [
    "# MEMORY superseded-text journal",
    "",
    "> Text removed by Dream while superseding an active workstream block.",
    "> Recall searches this file; Dream must never edit or delete it.",
    "",
  ].join("\n");

const appendToArchiveEffect = (
  targetInput: string,
  header: string,
  text: string,
  dedupeText = text,
): Effect.Effect<void, NodeJS.ErrnoException> =>
  Effect.gen(function* () {
    yield* tryFs(() =>
      fs.mkdir(path.dirname(targetInput), { recursive: true }),
    );
    const target = yield* Effect.promise(() =>
      canonicalFileWriteLockPath(targetInput),
    );
    yield* withFileWriteLockEffect(
      target,
      Effect.gen(function* () {
        const existing = yield* readOptionalTextFile(target);
        const preserved = text.trim();
        if (existing?.includes(dedupeText.trim())) return;
        const base = existing ?? header;
        yield* tryFs(() =>
          writeFileAtomicWithVerify(
            target,
            `${base.replace(/\n*$/u, "")}\n\n${preserved}\n`,
          ),
        );
      }),
    );
  });

export const appendSupersededMemoryTextEffect = (
  stellaDataDir: string,
  removedText: string,
): Effect.Effect<void, NodeJS.ErrnoException> =>
  Effect.suspend(() => {
    const text = removedText.trim();
    if (!text) return Effect.void;
    return appendToArchiveEffect(
      memorySupersededArchivePath(stellaDataDir),
      supersededHeader(),
      `## superseded ${new Date().toISOString()}\n${text}`,
      text,
    );
  });

export const appendSupersededMemoryText = (
  stellaDataDir: string,
  removedText: string,
): Promise<void> =>
  runMemoryPromise(appendSupersededMemoryTextEffect(stellaDataDir, removedText));

type MemoryBlock = {
  text: string;
  isoDate?: string;
  section: "active" | "archive";
};

type ParsedMemory = {
  raw: string;
  activeBody: string;
  archiveBody: string;
  blocks: MemoryBlock[];
};

const countOccurrences = (value: string, needle: string): number =>
  value.split(needle).length - 1;

const parseBlocks = (
  body: string,
  section: MemoryBlock["section"],
): MemoryBlock[] => {
  const blocks: MemoryBlock[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (!current) return;
    const text = current.join("\n").trim();
    if (text) {
      const isoDate = BLOCK_DATE_RE.exec(text)?.[1];
      blocks.push({ text, section, ...(isoDate ? { isoDate } : {}) });
    }
    current = null;
  };
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return blocks;
};

const parseMemory = (raw: string): ParsedMemory | null => {
  for (const marker of [ACTIVE_START, ACTIVE_END, ARCHIVE_START, ARCHIVE_END]) {
    if (countOccurrences(raw, marker) !== 1) return null;
  }
  const activeStart = raw.indexOf(ACTIVE_START);
  const activeEnd = raw.indexOf(ACTIVE_END);
  const archiveStart = raw.indexOf(ARCHIVE_START);
  const archiveEnd = raw.indexOf(ARCHIVE_END);
  if (
    activeStart < 0 ||
    activeEnd <= activeStart ||
    archiveStart <= activeEnd ||
    archiveEnd <= archiveStart
  ) {
    return null;
  }
  const activeBody = raw.slice(activeStart + ACTIVE_START.length, activeEnd);
  const archiveBody = raw.slice(
    archiveStart + ARCHIVE_START.length,
    archiveEnd,
  );
  return {
    raw,
    activeBody,
    archiveBody,
    blocks: [
      ...parseBlocks(archiveBody, "archive"),
      ...parseBlocks(activeBody, "active"),
    ],
  };
};

const removeSelected = (
  body: string,
  section: MemoryBlock["section"],
  selected: readonly MemoryBlock[],
): string => {
  let updated = body;
  for (const block of selected) {
    if (block.section !== section) continue;
    const at = updated.indexOf(block.text);
    if (at < 0) continue;
    const before = updated.slice(0, at).replace(/\n+$/u, "");
    const after = updated.slice(at + block.text.length).replace(/^\n+/u, "");
    updated = before
      ? after
        ? `${before}\n\n${after}`
        : `${before}\n`
      : after
        ? `\n${after}`
        : "\n";
  }
  return updated;
};

const replaceSection = (
  raw: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string => {
  const start = raw.indexOf(startMarker);
  const end = raw.indexOf(endMarker);
  return `${raw.slice(0, start + startMarker.length)}${body}${raw.slice(end)}`;
};

export type MemoryRotationResult = {
  rotatedBlocks: number;
  archiveFiles: string[];
  bytesBefore: number;
  bytesAfter: number;
};

export type MemoryRotationHooks = {
  beforeActiveRewrite?: () => void | Promise<void>;
};

const rotateLockedEffect = (
  stellaDataDir: string,
  activePath: string,
  hooks?: MemoryRotationHooks,
): Effect.Effect<MemoryRotationResult | null, unknown> =>
  Effect.gen(function* () {
    const raw = yield* readOptionalTextFile(activePath);
    if (raw === null) return null;
    const bytesBefore = Buffer.byteLength(raw, "utf-8");
    if (bytesBefore <= MEMORY_ROTATION_THRESHOLD_BYTES) return null;
    const parsed = parseMemory(raw);
    if (!parsed) {
      logger.warn("memory-rotation.unparseable", { bytesBefore });
      return null;
    }
    const archiveCandidates = parsed.blocks.filter(
      (block) => block.section === "archive" && block.isoDate,
    );
    const activeCandidates = parsed.blocks
      .filter((block) => block.section === "active" && block.isoDate)
      .slice(MEMORY_ROTATION_MIN_ACTIVE_BLOCKS)
      .reverse();
    const selected: MemoryBlock[] = [];
    let projectedBytes = bytesBefore;
    for (const block of [...archiveCandidates, ...activeCandidates]) {
      if (projectedBytes <= MEMORY_ROTATION_TARGET_BYTES) break;
      selected.push(block);
      projectedBytes -= Buffer.byteLength(block.text, "utf-8");
    }
    if (selected.length === 0) return null;

    const groups = new Map<string, MemoryBlock[]>();
    for (const block of selected) {
      const file = archiveFileNameForBlockDate(block.isoDate!);
      groups.set(file, [...(groups.get(file) ?? []), block]);
    }
    for (const [file, blocks] of groups) {
      const target = path.join(memoryArchiveRoot(stellaDataDir), file);
      for (const block of [...blocks].sort((a, b) =>
        a.isoDate!.localeCompare(b.isoDate!),
      )) {
        yield* appendToArchiveEffect(target, archiveHeader(file), block.text);
      }
    }

    yield* Effect.tryPromise({
      try: async () => {
        await hooks?.beforeActiveRewrite?.();
      },
      catch: (error) => error,
    });

    let rewritten = replaceSection(
      parsed.raw,
      ACTIVE_START,
      ACTIVE_END,
      removeSelected(parsed.activeBody, "active", selected),
    );
    rewritten = replaceSection(
      rewritten,
      ARCHIVE_START,
      ARCHIVE_END,
      removeSelected(parsed.archiveBody, "archive", selected),
    );
    yield* tryFs(() => writeFileAtomicWithVerify(activePath, rewritten));
    const result = {
      rotatedBlocks: selected.length,
      archiveFiles: [...groups.keys()].sort(),
      bytesBefore,
      bytesAfter: Buffer.byteLength(rewritten, "utf-8"),
    };
    logger.info("memory-rotation.rotated", result);
    return result;
  });

export const rotateMemoryFileIfNeededEffect = (
  stellaDataDir: string,
  hooks?: MemoryRotationHooks,
): Effect.Effect<MemoryRotationResult | null, unknown> =>
  Effect.gen(function* () {
    const activePath = yield* Effect.promise(() =>
      canonicalFileWriteLockPath(memoryFilePath(stellaDataDir)),
    );
    return yield* withFileWriteLockEffect(
      activePath,
      rotateLockedEffect(stellaDataDir, activePath, hooks),
    );
  });

export const rotateMemoryFileIfNeeded = (
  stellaDataDir: string,
  hooks?: MemoryRotationHooks,
): Promise<MemoryRotationResult | null> =>
  runMemoryPromise(rotateMemoryFileIfNeededEffect(stellaDataDir, hooks));
