/**
 * Pure text-edit planning for the `Edit` tool: argument coercion, match
 * diagnostics, the legacy single replacement, and the multi-edit
 * (`edits[]`) form. Dependency-free (shared with the workerd cloud world).
 *
 * Every edit in one call is matched against the ORIGINAL content (never
 * after an earlier edit applied), overlapping edits are rejected, and the
 * result is applied in one pass, so a call either lands completely or not
 * at all. Text and anchor edits share that contract.
 */

import { fuzzyFindText, normalizeToLF } from "./edit-diff.js";
import {
  parseAnchor,
  resolveAnchor,
  stripHashLinePrefixes,
  type HashLineAnchor,
} from "./hashline.js";

export type TextEditSpec = {
  kind: "text";
  oldText: string;
  newText: string;
};

export type AnchorEditSpec = {
  kind: "anchor";
  anchor: HashLineAnchor;
  endAnchor?: HashLineAnchor;
  newText: string;
  insertAfter?: boolean;
};

export type EditSpec = TextEditSpec | AnchorEditSpec;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasValue = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== "";

const looksLikeEdit = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  (typeof value.old_string === "string" ||
    typeof value.oldText === "string" ||
    hasValue(value.anchor));

/**
 * Normalize the `edits` argument in place of a schema-level coercion: some
 * models send `edits` as a JSON string or as one bare edit object. Legacy
 * top-level `old_string`/`anchor` fields sent ALONGSIDE `edits` are folded
 * in as one more edit. Calls without `edits` are returned unchanged so the
 * legacy single-edit path (and replayed transcripts) keep their behavior.
 */
export const prepareEditArguments = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  if (!("edits" in args) || args.edits === undefined || args.edits === null) {
    return args;
  }
  let edits: unknown = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      // Left as a string; validation below reports the shape.
    }
  }
  if (looksLikeEdit(edits)) {
    edits = [edits];
  }
  if (Array.isArray(edits)) {
    // Pi-style `oldText`/`newText` entries → this schema's snake_case keys.
    const entries: unknown[] = edits.map((entry: unknown) => {
      if (!isRecord(entry)) return entry;
      const { oldText, newText, ...restEntry } = entry;
      return {
        ...restEntry,
        ...(typeof oldText === "string" && restEntry.old_string === undefined
          ? { old_string: oldText }
          : {}),
        ...(typeof newText === "string" && restEntry.new_string === undefined
          ? { new_string: newText }
          : {}),
      };
    });
    edits = entries;
    const legacy: Record<string, unknown> = {};
    for (const key of [
      "old_string",
      "anchor",
      "end_anchor",
      "insert_after",
      "new_string",
    ]) {
      if (key in args) legacy[key] = args[key];
    }
    if (typeof legacy.old_string === "string" || hasValue(legacy.anchor)) {
      edits = [...entries, legacy];
    }
  }
  const {
    old_string: _oldString,
    new_string: _newString,
    anchor: _anchor,
    end_anchor: _endAnchor,
    insert_after: _insertAfter,
    ...rest
  } = args;
  return { ...rest, edits };
};

/** Validate and parse coerced `edits` entries. */
export const parseEditSpecs = (edits: unknown): EditSpec[] => {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error(
      "edits must be a non-empty array of { old_string, new_string } or { anchor, end_anchor?, insert_after?, new_string } objects.",
    );
  }
  return edits.map((entry, index): EditSpec => {
    if (!isRecord(entry)) {
      throw new Error(`edits[${index}] must be an object.`);
    }
    const newText = entry.new_string ?? entry.newText;
    if (typeof newText !== "string") {
      throw new Error(
        `edits[${index}].new_string is required (use "" to delete).`,
      );
    }
    if (hasValue(entry.anchor)) {
      return {
        kind: "anchor",
        anchor: parseAnchor(entry.anchor),
        ...(hasValue(entry.end_anchor)
          ? { endAnchor: parseAnchor(entry.end_anchor) }
          : {}),
        newText,
        ...(entry.insert_after === true ? { insertAfter: true } : {}),
      };
    }
    const oldText = entry.old_string ?? entry.oldText;
    if (typeof oldText !== "string") {
      throw new Error(
        `edits[${index}] needs old_string (exact current text) or anchor (LINE#HASH from Read).`,
      );
    }
    return { kind: "text", oldText, newText };
  });
};

const snippetAt = (content: string, index: number): string => {
  const lineNumber = content.slice(0, index).split("\n").length;
  const line = content.split("\n")[lineNumber - 1] ?? "";
  return `L${lineNumber}: ${line.trim().replace(/\s+/g, " ").slice(0, 100)}`;
};

/** Error for an `old_string` that matches more than one location. */
export const duplicateMatchError = (
  content: string,
  occurrences: number,
  locations: readonly number[],
  advice: string,
): Error => {
  const snippets = locations
    .slice(0, 5)
    .map((index) => snippetAt(content, index));
  return new Error(
    `old_string matches ${occurrences} locations. ${advice}\nMatches:\n${snippets.join("\n")}${
      occurrences > snippets.length
        ? `\n… and ${occurrences - snippets.length} more.`
        : ""
    }`,
  );
};

/** Error for an `old_string` that matches nowhere, with recovery hints. */
export const missingTextError = (content: string, oldText: string): Error => {
  const oldAnchor = oldText
    .split("\n")
    .filter((line) => line.trim().length >= 4)
    .sort((left, right) => right.trim().length - left.trim().length)[0];
  const lines = content.split("\n");
  const matchingLines = oldAnchor
    ? lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.trim() === oldAnchor.trim())
    : [];
  const hintParts: string[] = [];
  if (matchingLines.length > 0) {
    hintParts.push(
      `Matching anchor location${matchingLines.length === 1 ? "" : "s"}:\n${matchingLines
        .slice(0, 5)
        .map(
          ({ line, index }) =>
            `L${index + 1}: ${line.trim().replace(/\s+/g, " ").slice(0, 100)}`,
        )
        .join("\n")}`,
    );
    const whitespaceMatch = matchingLines.find(
      ({ line }) => line !== oldAnchor,
    );
    if (whitespaceMatch) {
      const visualize = (line: string) => {
        const leading = line.match(/^[\t ]*/)?.[0] ?? "";
        return `${leading.replaceAll("\t", "→").replaceAll(" ", "·")}${line.slice(leading.length)}`;
      };
      hintParts.push(
        `Leading whitespace differs:\nfile has: ${visualize(whitespaceMatch.line)}\nyou sent: ${visualize(oldAnchor)}`,
      );
    }
  }
  hintParts.push(
    matchingLines.length > 0
      ? "Re-read around those lines and retry with unique surrounding context."
      : "Re-read the file and retry with current, unique text.",
  );
  return new Error(`old_string not found in file.\n\n${hintParts.join("\n\n")}`);
};

export type StringReplacementResult = {
  content: string;
  replacements: number;
  /** The edit is already present (idempotent replay); nothing to write. */
  noChange?: true;
};

/**
 * The legacy single `old_string`/`new_string` replacement on LF-normalized,
 * BOM-free content: exact match first (unique unless `replaceAll`), then a
 * fuzzy match that must also be unique. Offsets are always in the original
 * content, so only the matched span changes and every other byte survives.
 */
export const applyStringReplacement = (
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): StringReplacementResult => {
  const normalizedOld = normalizeToLF(oldString);
  const normalizedNew = normalizeToLF(newString);

  if (!normalizedOld.trim()) {
    throw new Error(
      "old_string is empty or only whitespace; provide non-blank text to match.",
    );
  }

  const editAlreadyApplied =
    normalizedNew.length >= 8 &&
    content.includes(normalizedNew) &&
    (normalizedOld === normalizedNew || !content.includes(normalizedOld));
  if (editAlreadyApplied) {
    return { content, replacements: 0, noChange: true };
  }

  const exactLocations: number[] = [];
  let exactCursor = 0;
  while (exactCursor <= content.length - normalizedOld.length) {
    const index = content.indexOf(normalizedOld, exactCursor);
    if (index === -1) break;
    exactLocations.push(index);
    exactCursor = index + Math.max(1, normalizedOld.length);
  }

  if (!replaceAll && exactLocations.length > 1) {
    throw duplicateMatchError(
      content,
      exactLocations.length,
      exactLocations,
      "Add surrounding context or set replace_all=true.",
    );
  }

  if (replaceAll) {
    const occurrences = content.split(normalizedOld).length - 1;
    if (occurrences === 0) {
      throw new Error("old_string not found in file.");
    }
    return {
      content: content.split(normalizedOld).join(normalizedNew),
      replacements: occurrences,
    };
  }

  const matchResult = fuzzyFindText(content, normalizedOld);
  if (!matchResult.found) {
    throw missingTextError(content, normalizedOld);
  }
  // A fuzzy match must be as unique as an exact one; never silently edit
  // the first of several near-identical spans.
  if (matchResult.occurrences > 1) {
    throw duplicateMatchError(
      content,
      matchResult.occurrences,
      matchResult.locations,
      "Add surrounding context or set replace_all=true.",
    );
  }

  // Offsets are in the original content: only the matched span changes,
  // so trailing whitespace and Unicode punctuation elsewhere survive a
  // fuzzy match byte for byte.
  const replaced =
    content.substring(0, matchResult.index) +
    matchResult.leading +
    normalizedNew +
    matchResult.trailing +
    content.substring(matchResult.index + matchResult.matchLength);

  if (content === replaced) {
    throw new Error(
      "old_string and new_string are identical — no changes made.",
    );
  }
  return { content: replaced, replacements: 1 };
};

type PlannedReplacement = {
  editIndex: number;
  start: number;
  end: number;
  text: string;
};

const lineStarts = (content: string): number[] => {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
};

const planAnchorEdit = (
  content: string,
  lines: string[],
  starts: number[],
  edit: AnchorEditSpec,
): { start: number; end: number; text: string } => {
  const startIndex = resolveAnchor(lines, edit.anchor);
  const endIndex = edit.endAnchor
    ? resolveAnchor(lines, edit.endAnchor)
    : startIndex;
  if (endIndex < startIndex) {
    throw new Error(
      `end_anchor (line ${endIndex + 1}) resolves before anchor (line ${startIndex + 1}). ` +
        `The range must run top to bottom; re-read the file if lines moved.`,
    );
  }
  const newText = normalizeToLF(stripHashLinePrefixes(edit.newText));
  const lineEnd = (index: number) => starts[index]! + lines[index]!.length;
  if (edit.insertAfter) {
    const at = lineEnd(startIndex);
    return { start: at, end: at, text: `\n${newText}` };
  }
  if (newText !== "") {
    return { start: starts[startIndex]!, end: lineEnd(endIndex), text: newText };
  }
  // Deleting whole lines also removes one line separator.
  if (endIndex + 1 < lines.length) {
    return { start: starts[startIndex]!, end: starts[endIndex + 1]!, text: "" };
  }
  if (startIndex > 0) {
    return { start: lineEnd(startIndex - 1), end: content.length, text: "" };
  }
  return { start: 0, end: content.length, text: "" };
};

export type AppliedEditsSummary = {
  content: string;
  /** 1-based first ORIGINAL line touched by each edit, in input order. */
  lines: number[];
};

/**
 * Apply `edits` to LF-normalized, BOM-free content. Each text edit must
 * match exactly one location (exact first, then fuzzy, offsets always in
 * the original content); anchors resolve against the original lines.
 */
export const applyEditsToContent = (
  content: string,
  edits: readonly EditSpec[],
): AppliedEditsSummary => {
  const lines = content.split("\n");
  const starts = lineStarts(content);
  const planned: PlannedReplacement[] = edits.map((edit, editIndex) => {
    try {
      if (edit.kind === "anchor") {
        return { editIndex, ...planAnchorEdit(content, lines, starts, edit) };
      }
      const oldText = normalizeToLF(edit.oldText);
      if (!oldText.trim()) {
        throw new Error(
          "old_string is empty or only whitespace; provide non-blank text to match.",
        );
      }
      const match = fuzzyFindText(content, oldText);
      if (!match.found) throw missingTextError(content, oldText);
      if (match.occurrences > 1) {
        throw duplicateMatchError(
          content,
          match.occurrences,
          match.locations,
          "Add surrounding context so it is unique.",
        );
      }
      return {
        editIndex,
        start: match.index,
        end: match.index + match.matchLength,
        text: match.leading + normalizeToLF(edit.newText) + match.trailing,
      };
    } catch (error) {
      throw new Error(`edits[${editIndex}]: ${(error as Error).message}`);
    }
  });

  const ordered = [...planned].sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.editIndex - right.editIndex,
  );
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (previous.end > current.start) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap. Merge them into one edit or target disjoint regions; every edit matches the original file, not the result of earlier edits.`,
      );
    }
  }

  let next = content;
  for (let index = ordered.length - 1; index >= 0; index--) {
    const replacement = ordered[index]!;
    next =
      next.slice(0, replacement.start) +
      replacement.text +
      next.slice(replacement.end);
  }
  if (next === content) {
    throw new Error("The edits produced identical content; no changes made.");
  }
  const lineOf = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  return {
    content: next,
    lines: planned.map((replacement) => lineOf(replacement.start)),
  };
};
