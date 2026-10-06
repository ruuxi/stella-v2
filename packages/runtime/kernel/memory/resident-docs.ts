/**
 * Effect-native readers for the memory documents kept resident every turn.
 *
 * Each reader caps what it injects at a line boundary with a visible marker
 * (see `memory-layout.ts`). Capping is an injection-time concern only: the
 * file on disk is never modified here, so a document that outgrows its budget
 * loses nothing — the agent is told it is reading a truncated view and can
 * curate the file down with the ordinary file tools.
 */

import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";

import { redactMemoryText } from "./redaction.js";
import { runMemorySync } from "./effect-runtime.js";
import {
  CORE_MEMORY_INJECTED_MAX_CHARS,
  MEMORY_INDEX_INJECTED_MAX_CHARS,
  USER_PROFILE_INJECTED_MAX_CHARS,
  coreMemoryPath,
  memoryIndexPath,
  userProfilePath,
} from "./memory-layout.js";

const unicodeCodePointLength = (text: string): number => Array.from(text).length;

const stripInjectedHtmlComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!--[\s\S]*$/u, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

const truncateUnicodeAtLineBoundary = (
  text: string,
  maxChars: number,
  marker: string,
): string => {
  if (unicodeCodePointLength(text) <= maxChars) return text;
  const markerChars = unicodeCodePointLength(marker);
  if (maxChars < markerChars) return "";
  const prefixBudget = maxChars - markerChars;
  let prefix = "";
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)/gu)) {
    const candidate = `${prefix}${match[0]}`;
    if (unicodeCodePointLength(candidate) > prefixBudget) break;
    prefix = candidate;
  }
  if (!prefix) {
    prefix = [...text].slice(0, prefixBudget).join("");
  }
  return `${prefix}${marker}`;
};

const capResidentDoc = (content: string, maxChars: number): string =>
  unicodeCodePointLength(content) <= maxChars
    ? content
    : truncateUnicodeAtLineBoundary(
        content,
        maxChars,
        "\n...[truncated for context budget — the file on disk is complete; edit it down]",
      );

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
    const content = stripInjectedHtmlComments(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return content
      ? capResidentDoc(redactMemoryText(content), maxChars)
      : undefined;
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
