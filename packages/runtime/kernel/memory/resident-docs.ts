/**
 * Effect-native readers for the memory documents kept resident every turn.
 *
 * Each reader shapes what it injects with `shapeResidentMemoryDoc`, which
 * caps at a line boundary with a visible marker (see `memory-layout.ts`).
 * Capping is an injection-time concern only: the file on disk is never
 * modified here, so a document that outgrows its budget loses nothing — the
 * agent is told it is reading a truncated view and can curate the file down
 * with the ordinary file tools.
 */

import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";

import { shapeResidentMemoryDoc } from "./resident-doc-shape.js";
import { runMemorySync } from "./effect-runtime.js";
import {
  CORE_MEMORY_INJECTED_MAX_CHARS,
  MEMORY_INDEX_INJECTED_MAX_CHARS,
  USER_PROFILE_INJECTED_MAX_CHARS,
  coreMemoryPath,
  memoryIndexPath,
  userProfilePath,
} from "./memory-layout.js";

const swallowToUndefined = <A>(
  op: () => A | undefined,
): Effect.Effect<A | undefined> =>
  Effect.try({ try: op, catch: () => undefined }).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );

const readResidentDocEffect = (
  filePath: string,
  maxChars: number,
): Effect.Effect<string | undefined> =>
  swallowToUndefined(() => {
    const bytes = fs.readFileSync(filePath);
    return shapeResidentMemoryDoc(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      maxChars,
    );
  });

export const readCoreMemoryEffect = (
  stellaDataDir: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    for (const filePath of [
      coreMemoryPath(stellaDataDir),
      path.join(stellaDataDir, "CORE_MEMORY.MD"),
    ]) {
      const content = yield* readResidentDocEffect(
        filePath,
        CORE_MEMORY_INJECTED_MAX_CHARS,
      );
      if (content) return content;
    }
    return undefined;
  });

export const readCoreMemory = (stellaDataDir: string): string | undefined =>
  runMemorySync(readCoreMemoryEffect(stellaDataDir));

export const readUserProfileDocEffect = (
  stellaDataDir: string,
): Effect.Effect<string | undefined> =>
  readResidentDocEffect(
    userProfilePath(stellaDataDir),
    USER_PROFILE_INJECTED_MAX_CHARS,
  );

export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  runMemorySync(readUserProfileDocEffect(stellaDataDir));

export const readMemoryIndexDocEffect = (
  stellaDataDir: string,
): Effect.Effect<string | undefined> =>
  readResidentDocEffect(
    memoryIndexPath(stellaDataDir),
    MEMORY_INDEX_INJECTED_MAX_CHARS,
  );

export const readMemoryIndexDoc = (stellaDataDir: string): string | undefined =>
  runMemorySync(readMemoryIndexDocEffect(stellaDataDir));
