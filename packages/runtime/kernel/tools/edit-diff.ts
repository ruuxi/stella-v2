/**
 * Pure edit-diff text utilities: line endings, BOM, and exact-then-fuzzy
 * matching with original-offset mapping. Dependency-free so workerd hosts
 * (the cloud world's Edit) share the exact same matching as the Node host.
 */

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

const FUZZY_ASCII_LINE = /^[\x00-\x7f]*$/;
// One base character plus its combining marks: NFKC composes within such a
// cluster, so normalizing clusters one by one keeps an offset map exact.
const FUZZY_CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;

const normalizeFuzzyCluster = (cluster: string): string =>
  cluster
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");

interface FuzzyNormalized {
  text: string;
  /**
   * Original offset for each normalized offset used as a match START, or -1
   * inside the expansion of one source cluster (NFKC "ﬁ" → "fi").
   */
  startMap: Int32Array;
  /**
   * Same as `startMap` except at a line end whose trailing whitespace was
   * stripped: a match ENDING there maps to before that whitespace, so the
   * file's own trailing whitespace survives a replacement.
   */
  endMap: Int32Array;
}

/**
 * Fuzzy view of `text` (NFKC, trailing whitespace stripped per line, smart
 * quotes/dashes/special spaces folded to ASCII) with a map back to `text`
 * offsets, so a fuzzy match can be applied to the original bytes.
 */
function normalizeForFuzzyMatchWithMap(text: string): FuzzyNormalized {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let lineOffset = 0;
  // Original offset just before the previous line's stripped whitespace.
  let previousStrippedFrom = 0;
  const lines = text.split("\n");
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      // The boundary after the previous line's kept text: a match starting
      // there begins at the newline, one ending there stops before the
      // whitespace that was stripped.
      parts.push("\n");
      starts.push(lineOffset - 1);
      ends.push(previousStrippedFrom);
    }
    let lineText: string;
    const lineMap: number[] = [];
    if (FUZZY_ASCII_LINE.test(line)) {
      lineText = line;
      for (let index = 0; index < line.length; index++) {
        lineMap.push(lineOffset + index);
      }
    } else {
      const pieces: string[] = [];
      for (const match of line.matchAll(FUZZY_CLUSTER)) {
        const normalized = normalizeFuzzyCluster(match[0]);
        pieces.push(normalized);
        for (let index = 0; index < normalized.length; index++) {
          lineMap.push(index === 0 ? lineOffset + (match.index ?? 0) : -1);
        }
      }
      lineText = pieces.join("");
    }
    // Strip trailing whitespace, but never split one cluster's expansion.
    let kept = lineText.trimEnd().length;
    while (kept < lineText.length && lineMap[kept] === -1) kept++;
    previousStrippedFrom =
      kept < lineText.length ? lineMap[kept]! : lineOffset + line.length;
    parts.push(lineText.slice(0, kept));
    for (let index = 0; index < kept; index++) {
      starts.push(lineMap[index]!);
      ends.push(lineMap[index]!);
    }
    lineOffset += line.length + 1;
  });
  starts.push(text.length);
  ends.push(previousStrippedFrom);
  return {
    text: parts.join(""),
    startMap: Int32Array.from(starts),
    endMap: Int32Array.from(ends),
  };
}

function normalizeForFuzzyMatch(text: string): string {
  return normalizeForFuzzyMatchWithMap(text).text;
}

export interface FuzzyMatchResult {
  found: boolean;
  /** Match start in the ORIGINAL content. */
  index: number;
  /** Match length in the ORIGINAL content. */
  matchLength: number;
  usedFuzzyMatch: boolean;
  /** Non-overlapping occurrences in the space that produced the match. */
  occurrences: number;
  /** Original-content starts of the first few occurrences. */
  locations: number[];
  /**
   * Normalized text to wrap around the replacement when a fuzzy match edge
   * fell inside one source cluster's expansion and the span was widened to
   * the whole cluster. Empty for exact matches.
   */
  leading: string;
  trailing: string;
}

const MAX_REPORTED_LOCATIONS = 5;

const findOccurrences = (haystack: string, needle: string): number[] => {
  const found: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    found.push(index);
    cursor = index + Math.max(1, needle.length);
  }
  return found;
};

/**
 * Find `oldText` in `content`: exact first, then fuzzy. Offsets are always
 * in the original content, so callers replace only the matched span and
 * every other byte of the file is preserved.
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const notFound: FuzzyMatchResult = {
    found: false,
    index: -1,
    matchLength: 0,
    usedFuzzyMatch: false,
    occurrences: 0,
    locations: [],
    leading: "",
    trailing: "",
  };
  const exact = oldText.length > 0 ? findOccurrences(content, oldText) : [];
  if (exact.length > 0) {
    return {
      found: true,
      index: exact[0]!,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      occurrences: exact.length,
      locations: exact.slice(0, MAX_REPORTED_LOCATIONS),
      leading: "",
      trailing: "",
    };
  }
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (!fuzzyOldText) return notFound;
  const fuzzy = normalizeForFuzzyMatchWithMap(content);
  const matches = findOccurrences(fuzzy.text, fuzzyOldText);
  if (matches.length === 0) return notFound;
  const toOriginal = (normalizedStart: number) => {
    const normalizedEnd = normalizedStart + fuzzyOldText.length;
    let start = normalizedStart;
    while (start > 0 && fuzzy.startMap[start] === -1) start--;
    let end = normalizedEnd;
    while (end < fuzzy.text.length && fuzzy.endMap[end] === -1) end++;
    const originalStart = fuzzy.startMap[start]!;
    const originalEnd = Math.max(originalStart, fuzzy.endMap[end]!);
    return {
      index: originalStart,
      matchLength: originalEnd - originalStart,
      leading: fuzzy.text.slice(start, normalizedStart),
      trailing: fuzzy.text.slice(normalizedEnd, end),
    };
  };
  return {
    found: true,
    ...toOriginal(matches[0]!),
    usedFuzzyMatch: true,
    occurrences: matches.length,
    locations: matches
      .slice(0, MAX_REPORTED_LOCATIONS)
      .map((match) => toOriginal(match).index),
  };
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}
