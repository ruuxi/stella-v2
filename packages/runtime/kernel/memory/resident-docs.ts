/** Effect-native readers for the two memory documents kept resident in v2. */

import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";

import { redactMemoryText } from "./redaction.js";
import { runMemorySync } from "./effect-runtime.js";
import { USER_PROFILE_INJECTED_MAX_CHARS } from "./user-profile-store.js";

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
        "...[resident memory truncated]",
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
      path.join(stellaDataDir, "core-memory.md"),
      path.join(stellaDataDir, "CORE_MEMORY.MD"),
    ]) {
      const content = yield* swallowToUndefined(() =>
        fs.readFileSync(filePath, "utf-8").trim(),
      );
      if (content) return redactMemoryText(content);
    }
    return undefined;
  });

export const readCoreMemory = (stellaDataDir: string): string | undefined =>
  runMemorySync(readCoreMemoryEffect(stellaDataDir));

export const readUserProfileDocEffect = (
  stellaDataDir: string,
): Effect.Effect<string | undefined> =>
  readResidentDocEffect(
    path.join(stellaDataDir, "memories", "profile.md"),
    USER_PROFILE_INJECTED_MAX_CHARS,
  );

export const readUserProfileDoc = (stellaDataDir: string): string | undefined =>
  runMemorySync(readUserProfileDocEffect(stellaDataDir));
