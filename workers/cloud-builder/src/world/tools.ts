import {
  absoluteWorldPath,
  pathWithin,
  worldRelativeToolPath,
} from "./path.js";
import {
  applyAnchoredEdit,
  formatWithHashLines,
  parseAnchor,
} from "./hashline.js";
import type { WorldEntry, WorldToolCall, WorldToolResult } from "./types.js";
import { sanitizeToolVisibleText } from "@stella/runtime/kernel/tools/safety.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOOL_FILE_LIMIT_BYTES = 1_000_000;
const TOOL_READ_CHUNK_BYTES = 256 * 1024;
const TOOL_READ_MAX_LINES = 5_000;
const TOOL_OUTPUT_LIMIT_BYTES = 100_000;
const TOOL_GREP_PATTERN_MAX_CHARACTERS = 512;
const TOOL_GREP_SUBJECT_MAX_CHARACTERS = 64 * 1024;
const TOOL_GREP_AGGREGATE_SUBJECT_MAX_CHARACTERS = 8 * 1024 * 1024;
const TOOL_GLOB_DEFAULT_RESULTS = 1_000;

export type WorldToolFileApi = {
  stat(path: string): Promise<WorldEntry | null>;
  list(
    prefix: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ entries: WorldEntry[]; cursor?: string }>;
  readFile(
    path: string,
    options?: { offset?: number; length?: number },
  ): Promise<Uint8Array | null>;
  writeFile(
    path: string,
    bytes: Uint8Array,
    options?: { mode?: number; mtime?: number },
  ): Promise<WorldEntry & { revision: number }>;
  remove(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<{ revision: number }>;
  rename(from: string, to: string): Promise<{ revision: number }>;
};

const pagedEntries = async function* (
  api: WorldToolFileApi,
  prefix: string,
): AsyncGenerator<WorldEntry> {
  let cursor: string | undefined;
  for (;;) {
    const page = await api.list(prefix, {
      ...(cursor ? { cursor } : {}),
      limit: 250,
    });
    for (const entry of page.entries) yield entry;
    if (!page.cursor) return;
    cursor = page.cursor;
  }
};

const asError = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown file tool error.";

const normalizeLf = (text: string): string =>
  text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
const lineEnding = (text: string): "\r\n" | "\n" =>
  text.includes("\r\n") ? "\r\n" : "\n";
const restoreLineEnding = (text: string, ending: "\r\n" | "\n"): string =>
  ending === "\n" ? text : text.replaceAll("\n", "\r\n");

const stripBom = (text: string): { bom: string; text: string } =>
  text.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: text.slice(1) }
    : { bom: "", text };

const fuzzyNormalizeText = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‐‑‒–—―−]/gu, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");

const readText = async (
  api: WorldToolFileApi,
  path: string,
  root: string,
): Promise<string> => {
  const entry = await api.stat(path);
  if (!entry)
    throw new Error(`File not found: ${absoluteWorldPath(path, root)}`);
  if (entry.kind !== "file")
    throw new Error(`Path is not a file: ${absoluteWorldPath(path, root)}`);
  if (entry.size > TOOL_FILE_LIMIT_BYTES) {
    throw new Error(
      `File too large to read safely (${entry.size} bytes): ${absoluteWorldPath(path, root)}`,
    );
  }
  const bytes = await api.readFile(path, {});
  if (!bytes)
    throw new Error(`File not found: ${absoluteWorldPath(path, root)}`);
  if (bytes.includes(0))
    throw new Error(
      `Binary files are not supported: ${absoluteWorldPath(path, root)}`,
    );
  return decoder.decode(bytes);
};

const streamedTextLines = async function* (
  api: WorldToolFileApi,
  path: string,
  size: number,
): AsyncGenerator<{ number: number; text: string }> {
  const streamDecoder = new TextDecoder();
  let pending = "";
  let lineNumber = 1;
  let skipLf = false;
  const consume = function* (
    text: string,
  ): Generator<{ number: number; text: string }> {
    for (const character of text) {
      if (skipLf) {
        skipLf = false;
        if (character === "\n") continue;
      }
      if (character === "\n" || character === "\r") {
        yield { number: lineNumber, text: pending };
        lineNumber += 1;
        pending = "";
        skipLf = character === "\r";
      } else {
        pending += character;
        if (pending.length > TOOL_FILE_LIMIT_BYTES)
          throw new Error(
            `Line ${lineNumber} exceeds the ${TOOL_FILE_LIMIT_BYTES}-character file-tool limit.`,
          );
      }
    }
  };
  for (let offset = 0; offset < size; offset += TOOL_READ_CHUNK_BYTES) {
    const bytes = await api.readFile(path, {
      offset,
      length: Math.min(TOOL_READ_CHUNK_BYTES, size - offset),
    });
    if (!bytes) throw new Error(`File disappeared while reading: ${path}`);
    if (bytes.includes(0))
      throw new Error(`Binary files are not supported: ${path}`);
    yield* consume(streamDecoder.decode(bytes, { stream: true }));
  }
  yield* consume(streamDecoder.decode());
  // Match String.prototype.split: a file ending in a newline has a final empty line.
  yield { number: lineNumber, text: pending };
};

const assertBoundedRegex = (pattern: string): void => {
  if (pattern.length > TOOL_GREP_PATTERN_MAX_CHARACTERS)
    throw new Error(
      `Grep pattern exceeds the ${TOOL_GREP_PATTERN_MAX_CHARACTERS}-character safety limit.`,
    );
  if (/\\(?:[1-9]|k<)/u.test(pattern) || pattern.includes("(?"))
    throw new Error(
      "Grep pattern uses backreferences or special groups, which are unsupported by the bounded regex engine.",
    );

  let inClass = false;
  let escaped = false;
  let quantifiers = 0;
  let quantifierIndex = -1;
  let previousSignificant = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (escaped) {
      escaped = false;
      previousSignificant = "literal";
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "[") {
      inClass = true;
      previousSignificant = "class";
      continue;
    }
    if (character === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (character === "{" || character === "}")
      throw new Error(
        "Grep counted quantifiers are unsupported by the bounded regex engine.",
      );
    if (character === "*" || character === "+" || character === "?") {
      if (previousSignificant === "group")
        throw new Error(
          "Grep quantified groups are unsupported by the bounded regex engine.",
        );
      quantifiers += 1;
      quantifierIndex = index;
      if (quantifiers > 1)
        throw new Error(
          "Grep patterns with multiple quantifiers are rejected to prevent unsafe regex backtracking.",
        );
      previousSignificant = "quantifier";
      continue;
    }
    if (character === ")") previousSignificant = "group";
    else previousSignificant = "literal";
  }
  if (inClass || escaped)
    throw new Error(
      "Grep pattern has an unterminated escape or character class.",
    );
  if (quantifierIndex >= 0 && !pattern.startsWith("^"))
    throw new Error(
      "Grep patterns containing quantifiers must start with ^ to prevent unsafe regex backtracking.",
    );
};

const handleRead = async (
  api: WorldToolFileApi,
  args: Record<string, unknown>,
  root: string,
): Promise<string> => {
  try {
    const path = worldRelativeToolPath(args.file_path, root);
    if (/\.(?:png|jpe?g|gif|webp)$/iu.test(path)) {
      throw new Error(
        `Binary files are not supported: ${absoluteWorldPath(path, root)}`,
      );
    }
    const entry = await api.stat(path);
    if (!entry)
      throw new Error(`File not found: ${absoluteWorldPath(path, root)}`);
    if (entry.kind !== "file")
      throw new Error(`Path is not a file: ${absoluteWorldPath(path, root)}`);
    const offsetValue = Number(args.offset ?? 1);
    const limitValue = Number(args.limit ?? 2000);
    const offset = Number.isFinite(offsetValue)
      ? Math.max(1, Math.trunc(offsetValue))
      : 1;
    const requestedLimit = Number.isFinite(limitValue)
      ? Math.max(0, Math.trunc(limitValue))
      : 2000;
    const limit = Math.min(TOOL_READ_MAX_LINES, requestedLimit);
    const limitNotice =
      requestedLimit > TOOL_READ_MAX_LINES
        ? `\n\n[Read limited to ${TOOL_READ_MAX_LINES} lines per call; continue with offset.]`
        : "";
    if (entry.size <= TOOL_FILE_LIMIT_BYTES) {
      const content = await readText(api, path, root);
      const lines = normalizeLf(content).split("\n");
      const displayLines = normalizeLf(
        sanitizeToolVisibleText(content, { codeFile: true }),
      ).split("\n");
      const formatted = formatWithHashLines(lines, displayLines, offset, limit);
      return `File: ${absoluteWorldPath(path, root)}\n${formatted.header}\n\n${formatted.body}${limitNotice}`;
    }
    const selected: string[] = [];
    let selectedCharacters = 0;
    let hasMore = false;
    for await (const line of streamedTextLines(api, path, entry.size)) {
      if (line.number < offset) continue;
      if (
        selected.length >= limit ||
        selectedCharacters + line.text.length > TOOL_FILE_LIMIT_BYTES
      ) {
        hasMore = true;
        break;
      }
      selected.push(line.text);
      selectedCharacters += line.text.length;
    }
    const display = normalizeLf(
      sanitizeToolVisibleText(selected.join("\n"), { codeFile: true }),
    ).split("\n");
    const formatted = formatWithHashLines(
      selected,
      display,
      1,
      selected.length,
    );
    const rows = formatted.body
      .split("\n")
      .map((row, index) =>
        row.replace(/^\s*\d+#/u, `${String(offset + index).padStart(6, " ")}#`),
      )
      .join("\n");
    const end =
      selected.length === 0 ? offset - 1 : offset + selected.length - 1;
    const continuation = hasMore
      ? ` More lines remain; continue with offset=${end + 1}.`
      : " Reached end of file.";
    return `File: ${absoluteWorldPath(path, root)}\nLarge file (${entry.size} bytes). Showing ${offset}-${end}.${continuation} Edit/apply_patch remain unsupported above ${TOOL_FILE_LIMIT_BYTES} bytes because they require an atomic full-file rewrite.\n\n${rows}${limitNotice}`;
  } catch (error) {
    throw new Error(`Error reading file: ${asError(error)}`);
  }
};

const handleWrite = async (
  api: WorldToolFileApi,
  args: Record<string, unknown>,
  root: string,
): Promise<string> => {
  try {
    const path = worldRelativeToolPath(args.file_path, root);
    const previous = await api.stat(path);
    const content = String(args.content ?? "");
    if (content.includes("\0"))
      throw new Error("File content contains a NUL byte.");
    let final = content;
    if (previous?.kind === "file") {
      const sample = await api.readFile(path, {
        offset: 0,
        length: Math.min(previous.size, 64 * 1024),
      });
      if (!sample)
        throw new Error(`File not found: ${absoluteWorldPath(path, root)}`);
      final = restoreLineEnding(
        normalizeLf(content),
        lineEnding(decoder.decode(sample)),
      );
    }
    await api.writeFile(path, encoder.encode(final), {});
    return previous
      ? `Wrote ${absoluteWorldPath(path, root)}`
      : `Created ${absoluteWorldPath(path, root)}`;
  } catch (error) {
    throw new Error(`Error writing file: ${asError(error)}`);
  }
};

const exactEdit = (
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
): { content: string; replacements: number; noChange?: true } => {
  const { bom, text } = stripBom(content);
  const normalized = normalizeLf(text);
  const oldValue = normalizeLf(oldText);
  const newValue = normalizeLf(newText);
  if (!oldValue.trim())
    throw new Error(
      "old_string is empty or only whitespace; provide non-blank text to match.",
    );
  if (
    newValue.length >= 8 &&
    normalized.includes(newValue) &&
    (oldValue === newValue || !normalized.includes(oldValue))
  ) {
    return { content, replacements: 0, noChange: true };
  }
  const locations: number[] = [];
  for (let cursor = 0; cursor <= normalized.length - oldValue.length;) {
    const index = normalized.indexOf(oldValue, cursor);
    if (index < 0) break;
    locations.push(index);
    cursor = index + Math.max(1, oldValue.length);
  }
  if (!replaceAll && locations.length > 1) {
    const lines = normalized.split("\n");
    const snippets = locations.slice(0, 5).map((index) => {
      const lineNumber = normalized.slice(0, index).split("\n").length;
      return `L${lineNumber}: ${(lines[lineNumber - 1] ?? "").trim().replace(/\s+/gu, " ").slice(0, 100)}`;
    });
    throw new Error(
      `old_string matches ${locations.length} locations. Add surrounding context or set replace_all=true.\nMatches:\n${snippets.join("\n")}${locations.length > snippets.length ? `\n… and ${locations.length - snippets.length} more.` : ""}`,
    );
  }
  let replacementContent = normalized;
  let replacementIndex = locations[0] ?? -1;
  let replacementLength = oldValue.length;
  if (replacementIndex < 0 && !replaceAll) {
    const fuzzyContent = fuzzyNormalizeText(normalized);
    const fuzzyOld = fuzzyNormalizeText(oldValue);
    replacementIndex = fuzzyContent.indexOf(fuzzyOld);
    replacementLength = fuzzyOld.length;
    replacementContent = fuzzyContent;
  }
  if (replacementIndex < 0) {
    const oldAnchor = oldValue
      .split("\n")
      .filter((line) => line.trim().length >= 4)
      .sort((left, right) => right.trim().length - left.trim().length)[0];
    const matchingLines = oldAnchor
      ? normalized
          .split("\n")
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.trim() === oldAnchor.trim())
      : [];
    const hints: string[] = [];
    if (matchingLines.length > 0) {
      hints.push(
        `Matching anchor location${matchingLines.length === 1 ? "" : "s"}:\n${matchingLines
          .slice(0, 5)
          .map(
            ({ line, index }) =>
              `L${index + 1}: ${line.trim().replace(/\s+/gu, " ").slice(0, 100)}`,
          )
          .join("\n")}`,
      );
      const whitespaceMatch = matchingLines.find(
        ({ line }) => line !== oldAnchor,
      );
      if (whitespaceMatch) {
        const visualize = (line: string): string => {
          const leading = line.match(/^[\t ]*/u)?.[0] ?? "";
          return `${leading.replaceAll("\t", "→").replaceAll(" ", "·")}${line.slice(leading.length)}`;
        };
        hints.push(
          `Leading whitespace differs:\nfile has: ${visualize(whitespaceMatch.line)}\nyou sent: ${visualize(oldAnchor)}`,
        );
      }
    }
    hints.push(
      matchingLines.length > 0
        ? "Re-read around those lines and retry with unique surrounding context."
        : "Re-read the file and retry with current, unique text.",
    );
    throw new Error(`old_string not found in file.\n\n${hints.join("\n\n")}`);
  }
  if (oldValue === newValue)
    throw new Error(
      "old_string and new_string are identical — no changes made.",
    );
  const next = replaceAll
    ? normalized.split(oldValue).join(newValue)
    : replacementContent.slice(0, replacementIndex) +
      newValue +
      replacementContent.slice(replacementIndex + replacementLength);
  return {
    content: bom + restoreLineEnding(next, lineEnding(text)),
    replacements: replaceAll ? locations.length : 1,
  };
};

const handleEdit = async (
  api: WorldToolFileApi,
  args: Record<string, unknown>,
  root: string,
): Promise<string> => {
  const path = worldRelativeToolPath(args.file_path, root);
  const content = await readText(api, path, root).catch((error) => {
    throw new Error(`Error reading file: ${asError(error)}`);
  });
  const hasAnchor =
    args.anchor !== undefined && args.anchor !== null && args.anchor !== "";
  if (hasAnchor) {
    const ending = lineEnding(content);
    const endAnchor =
      args.end_anchor === undefined ||
      args.end_anchor === null ||
      args.end_anchor === ""
        ? undefined
        : parseAnchor(args.end_anchor);
    const applied = applyAnchoredEdit(normalizeLf(content), {
      anchor: parseAnchor(args.anchor),
      ...(endAnchor ? { endAnchor } : {}),
      newText: String(args.new_string ?? ""),
      ...(Boolean(args.insert_after) ? { insertAfter: true } : {}),
    });
    await api.writeFile(
      path,
      encoder.encode(restoreLineEnding(applied.content, ending)),
      {},
    );
    const range =
      applied.startLine === applied.endLine
        ? `line ${applied.startLine}`
        : `lines ${applied.startLine}-${applied.endLine}`;
    const action = applied.linesRemoved === 0 ? "Inserted after" : "Replaced";
    return `${action} ${range} in ${absoluteWorldPath(path, root)} (-${applied.linesRemoved}/+${applied.linesAdded} lines)`;
  }
  const edited = exactEdit(
    content,
    String(args.old_string ?? ""),
    String(args.new_string ?? ""),
    Boolean(args.replace_all),
  );
  if (edited.noChange)
    return `Edit already applied to ${absoluteWorldPath(path, root)}; no write was needed.`;
  await api.writeFile(path, encoder.encode(edited.content), {});
  return `Replaced ${edited.replacements} occurrence(s) in ${absoluteWorldPath(path, root)}`;
};

const globRegex = (pattern: string): RegExp => {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
};

const typeExtensions: Readonly<Record<string, readonly string[]>> = {
  ts: ["ts", "tsx"],
  js: ["js", "jsx", "mjs", "cjs"],
  json: ["json"],
  rust: ["rs"],
  py: ["py"],
  css: ["css", "scss", "sass", "less"],
  html: ["html", "htm"],
  md: ["md", "markdown"],
  yaml: ["yaml", "yml"],
  toml: ["toml"],
  shell: ["sh", "bash", "zsh"],
};

const handleGrep = async (
  api: WorldToolFileApi,
  args: Record<string, unknown>,
  root: string,
): Promise<string> => {
  const pattern = String(args.pattern ?? "");
  if (pattern.includes("\n") || pattern.includes("\r"))
    throw new Error(
      "Grep is line-oriented; regular expressions spanning line boundaries are not supported.",
    );
  assertBoundedRegex(pattern);
  const prefix =
    args.path === undefined ? "" : worldRelativeToolPath(args.path, root);
  const base = await api.stat(prefix);
  if (prefix && !base)
    throw new Error(
      `Path not found: ${absoluteWorldPath(prefix, root)}\nCheck the path or search its nearest existing parent directory.`,
    );
  let expression: RegExp;
  try {
    expression = new RegExp(
      pattern,
      Boolean(args.case_insensitive) ? "giu" : "gu",
    );
  } catch (error) {
    throw new Error(
      `Invalid regular expression '${pattern}': ${asError(error)}. Escape metacharacters to search for literal text.`,
    );
  }
  const outputMode = String(args.output_mode ?? "files_with_matches");
  const contextValue = Number(args.context_lines ?? 0);
  const contextLines = Number.isFinite(contextValue)
    ? Math.max(0, Math.min(100, Math.trunc(contextValue)))
    : 0;
  const maxValue = Number(args.max_results ?? 100);
  const maxResults = Number.isFinite(maxValue)
    ? Math.max(1, Math.min(10_000, Math.trunc(maxValue)))
    : 100;
  const matchGlob = args.glob ? globRegex(String(args.glob)) : null;
  const extensions = args.type ? typeExtensions[String(args.type)] : undefined;
  const entries: AsyncIterable<WorldEntry> =
    base?.kind === "file"
      ? (async function* () {
          yield base;
        })()
      : pagedEntries(api, prefix);
  const output: string[] = [];
  let outputBytes = 0;
  let resultCount = 0;
  let incomplete = false;
  let oversizedSubjectsSkipped = 0;
  let subjectCharactersTested = 0;
  let aggregateSubjectLimitReached = false;
  const append = (line: string): boolean => {
    const bytes = encoder.encode(`${line}\n`).byteLength;
    if (outputBytes + bytes > TOOL_OUTPUT_LIMIT_BYTES) {
      incomplete = true;
      return false;
    }
    output.push(line);
    outputBytes += bytes;
    return true;
  };
  outer: for await (const entry of entries) {
    if (entry.kind !== "file" || !pathWithin(entry.path, prefix)) continue;
    const relative =
      prefix === "" ? entry.path : entry.path.slice(prefix.length + 1);
    if (matchGlob && !matchGlob.test(relative)) continue;
    if (
      extensions &&
      !extensions.includes(entry.path.split(".").pop()?.toLowerCase() ?? "")
    )
      continue;
    const absolute = absoluteWorldPath(entry.path, root);
    let matching = 0;
    let lastEmitted = 0;
    let afterUntil = 0;
    const previous: Array<{ number: number; text: string }> = [];
    let previousCharacters = 0;
    let droppedThrough = 0;
    try {
      for await (const line of streamedTextLines(api, entry.path, entry.size)) {
        if (line.text.length > TOOL_GREP_SUBJECT_MAX_CHARACTERS) {
          oversizedSubjectsSkipped += 1;
          incomplete = true;
          continue;
        }
        const subjectCost = Math.max(1, line.text.length);
        if (
          subjectCharactersTested + subjectCost >
          TOOL_GREP_AGGREGATE_SUBJECT_MAX_CHARACTERS
        ) {
          aggregateSubjectLimitReached = true;
          incomplete = true;
          break outer;
        }
        subjectCharactersTested += subjectCost;
        expression.lastIndex = 0;
        const matches = expression.test(line.text);
        if (matches) {
          matching += 1;
          if (
            droppedThrough > 0 &&
            droppedThrough >= line.number - contextLines
          )
            incomplete = true;
          resultCount += 1;
          if (outputMode === "files_with_matches") {
            if (!append(absolute)) break outer;
            if (resultCount >= maxResults) {
              incomplete = true;
              break outer;
            }
            break;
          }
          if (outputMode === "content") {
            for (const context of previous) {
              if (
                context.number > lastEmitted &&
                !append(
                  `${base?.kind === "file" ? "" : `${absolute}:`}${context.number}:${context.text}`,
                )
              )
                break outer;
              lastEmitted = Math.max(lastEmitted, context.number);
            }
            if (
              line.number > lastEmitted &&
              !append(
                `${base?.kind === "file" ? "" : `${absolute}:`}${line.number}:${line.text}`,
              )
            )
              break outer;
            lastEmitted = line.number;
            afterUntil = line.number + contextLines;
          }
          if (resultCount >= maxResults) {
            incomplete = true;
            if (outputMode === "count")
              append(`${absolute}:at least ${matching}`);
            break outer;
          }
        } else if (outputMode === "content" && line.number <= afterUntil) {
          if (
            !append(
              `${base?.kind === "file" ? "" : `${absolute}:`}${line.number}:${line.text}`,
            )
          )
            break outer;
          lastEmitted = line.number;
        }
        if (contextLines > 0) {
          previous.push(line);
          previousCharacters += line.text.length;
          while (
            previous.length > contextLines ||
            previousCharacters > TOOL_OUTPUT_LIMIT_BYTES
          ) {
            const dropped = previous.shift();
            if (!dropped) break;
            previousCharacters -= dropped.text.length;
            droppedThrough = dropped.number;
          }
        }
      }
    } catch (error) {
      // A binary file or an over-limit single line is skipped, but this must be visible.
      incomplete = true;
      if (!append(`[Skipped ${absolute}: ${asError(error)}]`)) break;
    }
    if (outputMode === "count" && matching > 0) {
      if (!append(`${absolute}:${matching}`)) break;
      if (output.length >= maxResults) {
        incomplete = true;
        break;
      }
    }
  }
  if (output.length === 0) {
    if (!incomplete) return `No matches found for pattern: ${pattern}`;
    return (
      `Search incomplete for pattern: ${pattern}\n` +
      `No matches were found in bounded content. ${oversizedSubjectsSkipped} line(s) exceeded the ${TOOL_GREP_SUBJECT_MAX_CHARACTERS}-character regex subject limit; ` +
      `${aggregateSubjectLimitReached ? `the ${TOOL_GREP_AGGREGATE_SUBJECT_MAX_CHARACTERS}-character aggregate regex budget was reached; ` : ""}other unsupported files may also have been skipped.`
    );
  }
  const status = incomplete
    ? `\n[Results incomplete: a result/output bound was reached, context was omitted, an unsupported file was skipped, ${oversizedSubjectsSkipped} oversized line(s) exceeded the regex subject limit${aggregateSubjectLimitReached ? `, or the ${TOOL_GREP_AGGREGATE_SUBJECT_MAX_CHARACTERS}-character aggregate regex budget was reached` : ""}. Narrow the path/pattern to continue.]\n`
    : "\n";
  return `Found matches:\n\n${output.join("\n")}${status}`;
};

type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      moveTo?: string;
      hunks: Array<{
        header?: string;
        lines: Array<{ kind: "context" | "remove" | "add"; text: string }>;
        eof?: boolean;
      }>;
    };

const parsePatch = (value: string, root: string): PatchOp[] => {
  let text = value.replaceAll("\r\n", "\n").trim();
  const wrapped = text.split("\n");
  if (
    ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(wrapped[0] ?? "") &&
    wrapped.at(-1)?.endsWith("EOF")
  )
    text = wrapped.slice(1, -1).join("\n");
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "*** Begin Patch")
    throw new Error("apply_patch input must start with `*** Begin Patch`.");
  const ops: PatchOp[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "*** End Patch") return ops;
    if (line.startsWith("*** Add File: ")) {
      const path = worldRelativeToolPath(line.slice(14).trim(), root);
      const added: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("*** ")) {
        const next = lines[index] ?? "";
        if (!next.startsWith("+"))
          throw new Error(
            `apply_patch: lines under '*** Add File: ${absoluteWorldPath(path, root)}' must start with '+'. Saw: '${next}'`,
          );
        added.push(next.slice(1));
        index += 1;
      }
      ops.push({ kind: "add", path, lines: added });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      ops.push({
        kind: "delete",
        path: worldRelativeToolPath(line.slice(17).trim(), root),
      });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = worldRelativeToolPath(line.slice(17).trim(), root);
      index += 1;
      let moveTo: string | undefined;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        moveTo = worldRelativeToolPath(
          (lines[index] ?? "").slice(13).trim(),
          root,
        );
        index += 1;
      }
      const hunks: Extract<PatchOp, { kind: "update" }>["hunks"] = [];
      while (
        index < lines.length &&
        (!(lines[index] ?? "").startsWith("*** ") ||
          lines[index] === "*** End of File")
      ) {
        if ((lines[index] ?? "").trim() === "") {
          index += 1;
          continue;
        }
        const hunk: (typeof hunks)[number] = { lines: [] };
        if ((lines[index] ?? "").startsWith("@@")) {
          const header = (lines[index] ?? "").slice(2).trim();
          if (header) hunk.header = header;
          index += 1;
        } else if (hunks.length > 0)
          throw new Error(
            `apply_patch: expected '@@' header inside Update File '${absoluteWorldPath(path, root)}'.`,
          );
        while (index < lines.length) {
          const next = lines[index] ?? "";
          if (next === "*** End of File") {
            hunk.eof = true;
            index += 1;
            break;
          }
          if (next.startsWith("*** ") || next.startsWith("@@")) break;
          if (next === "") hunk.lines.push({ kind: "context", text: "" });
          else if (next[0] === "+")
            hunk.lines.push({ kind: "add", text: next.slice(1) });
          else if (next[0] === "-")
            hunk.lines.push({ kind: "remove", text: next.slice(1) });
          else if (next[0] === " ")
            hunk.lines.push({ kind: "context", text: next.slice(1) });
          else
            throw new Error(
              `apply_patch: hunk lines must start with '+', '-', or ' '. Saw: '${next}'`,
            );
          index += 1;
        }
        if (hunk.lines.length === 0 && !hunk.eof) {
          throw new Error(
            `apply_patch: empty hunk inside Update File '${absoluteWorldPath(path, root)}'.`,
          );
        }
        hunks.push(hunk);
      }
      if (hunks.length === 0) {
        throw new Error(
          `apply_patch: Update File '${absoluteWorldPath(path, root)}' has no hunks.`,
        );
      }
      ops.push({ kind: "update", path, ...(moveTo ? { moveTo } : {}), hunks });
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    throw new Error(`apply_patch: unexpected line outside of an op: '${line}'`);
  }
  throw new Error("apply_patch: missing `*** End Patch` terminator.");
};

const fuzzy = (value: string): string =>
  value
    .trim()
    .replace(/[‐‑‒–—―−]/gu, "-")
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/\s/gu, " ");
const seek = (
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number => {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return -1;
  const first = eof ? lines.length - pattern.length : start;
  for (const compare of [
    (a: string, b: string) => a === b,
    (a: string, b: string) => a.trimEnd() === b.trimEnd(),
    (a: string, b: string) => a.trim() === b.trim(),
    (a: string, b: string) => fuzzy(a) === fuzzy(b),
  ]) {
    for (let index = first; index <= lines.length - pattern.length; index += 1)
      if (
        pattern.every((line, offset) =>
          compare(lines[index + offset] ?? "", line),
        )
      )
        return index;
  }
  return -1;
};

const exactLocations = (lines: string[], pattern: string[]): number[] => {
  if (pattern.length === 0 || pattern.length > lines.length) return [];
  const locations: number[] = [];
  for (let index = 0; index <= lines.length - pattern.length; index += 1) {
    if (pattern.every((line, offset) => lines[index + offset] === line))
      locations.push(index);
  }
  return locations;
};

const patchMissHint = (lines: string[], expected: string[]): string => {
  const anchors = expected
    .map((line) => ({ line, normalized: fuzzy(line) }))
    .filter(({ normalized }) => normalized.length >= 4)
    .sort((left, right) => right.normalized.length - left.normalized.length);
  const fallback = anchors[0];
  if (!fallback)
    return "Re-read the file and retry with a non-empty, unique context anchor.";
  let anchor = fallback;
  let locations: number[] = [];
  for (const candidate of anchors) {
    const found = lines.flatMap((line, index) =>
      fuzzy(line) === candidate.normalized ? [index] : [],
    );
    if (found.length > 0) {
      anchor = candidate;
      locations = found;
      break;
    }
  }
  const parts: string[] = [];
  if (locations.length > 0) {
    const shown = locations.slice(0, 5).map((index) => {
      const compact = (lines[index] ?? "").trim().replace(/\s+/gu, " ");
      return `L${index + 1}: ${compact.length > 100 ? `${compact.slice(0, 100)}…` : compact}`;
    });
    parts.push(
      `Matching anchor location${locations.length === 1 ? "" : "s"}:\n${shown.join("\n")}${locations.length > shown.length ? `\n… and ${locations.length - shown.length} more.` : ""}`,
    );
  }
  const whitespaceLocation = locations.find(
    (index) =>
      (lines[index] ?? "").trim() === anchor.line.trim() &&
      lines[index] !== anchor.line,
  );
  if (whitespaceLocation !== undefined) {
    const visualize = (line: string): string => {
      const leading = line.match(/^[\t ]*/u)?.[0] ?? "";
      return `${leading.replaceAll("\t", "→").replaceAll(" ", "·")}${line.slice(leading.length)}`;
    };
    parts.push(
      `Leading whitespace differs:\nfile has: ${visualize(lines[whitespaceLocation] ?? "")}\nyou sent: ${visualize(anchor.line)}`,
    );
  }
  parts.push(
    locations.length > 0
      ? "Re-read around those lines and retry with the exact surrounding context."
      : "No matching anchor line was found. Re-read the file and retry with current context.",
  );
  return parts.join("\n\n");
};

const handlePatch = async (
  api: WorldToolFileApi,
  args: Record<string, unknown>,
  root: string,
): Promise<string> => {
  const patch = String(args.input ?? args.patch ?? "").trim();
  if (!patch) throw new Error("apply_patch requires a patch envelope.");
  const results: Array<Record<string, unknown>> = [];
  for (const op of parsePatch(patch, root)) {
    if (op.kind === "add") {
      if (await api.stat(op.path))
        throw new Error(
          `apply_patch: file already exists for Add: ${absoluteWorldPath(op.path, root)}`,
        );
      await api.writeFile(
        op.path,
        encoder.encode(op.lines.join("\n") + (op.lines.length ? "\n" : "")),
        {},
      );
      results.push({ kind: "add", path: absoluteWorldPath(op.path, root) });
      continue;
    }
    if (op.kind === "delete") {
      if (!(await api.stat(op.path)))
        throw new Error(
          `apply_patch: file not found for Delete: ${absoluteWorldPath(op.path, root)}`,
        );
      await api.remove(op.path, {});
      results.push({ kind: "delete", path: absoluteWorldPath(op.path, root) });
      continue;
    }
    let content: string;
    try {
      content = await readText(api, op.path, root);
    } catch (error) {
      throw new Error(
        `apply_patch: cannot update ${absoluteWorldPath(op.path, root)}: ${asError(error)}`,
      );
    }
    const trailing = content.endsWith("\n");
    const lines = trailing
      ? content.split("\n").slice(0, -1)
      : content.split("\n");
    let cursor = 0;
    const replacements: Array<{
      start: number;
      count: number;
      lines: string[];
    }> = [];
    let alreadyAppliedHunks = 0;
    for (const hunk of op.hunks) {
      if (hunk.header) {
        const location = seek(lines, [hunk.header], cursor, false);
        if (location < 0)
          throw new Error(
            `apply_patch: failed to find context '${hunk.header}' in ${absoluteWorldPath(op.path, root)}.\n\n${patchMissHint(lines, [hunk.header])}`,
          );
        cursor = location + 1;
      }
      const originalOldLines = hunk.lines
        .filter((line) => line.kind !== "add")
        .map((line) => line.text);
      let oldLines = originalOldLines;
      let newLines = hunk.lines
        .filter((line) => line.kind !== "remove")
        .map((line) => line.text);
      if (oldLines.length === 0) {
        replacements.push({ start: lines.length, count: 0, lines: newLines });
        cursor = lines.length;
        continue;
      }
      let location = seek(lines, oldLines, cursor, hunk.eof === true);
      if (location < 0 && oldLines.at(-1) === "") {
        const trimmedOld = oldLines.slice(0, -1);
        const trimmedNew =
          newLines.at(-1) === "" ? newLines.slice(0, -1) : newLines;
        const retry = seek(lines, trimmedOld, cursor, hunk.eof === true);
        if (retry >= 0) {
          oldLines = trimmedOld;
          newLines = trimmedNew;
          location = retry;
        }
      }
      if (location < 0) {
        const newText = newLines.join("\n");
        if (
          newText.length >= 8 &&
          newLines.length > 0 &&
          exactLocations(lines, newLines).length > 0 &&
          exactLocations(lines, oldLines).length === 0
        ) {
          alreadyAppliedHunks += 1;
          continue;
        }
        throw new Error(
          `apply_patch: failed to find expected lines in ${absoluteWorldPath(op.path, root)}:\n${originalOldLines.join("\n")}\n\n${patchMissHint(lines, originalOldLines)}`,
        );
      }
      replacements.push({
        start: location,
        count: oldLines.length,
        lines: newLines,
      });
      cursor = location + oldLines.length;
    }
    if (replacements.length === 0 && alreadyAppliedHunks > 0) {
      results.push({
        kind: "noop",
        path: absoluteWorldPath(op.path, root),
        note: `Patch already applied to ${absoluteWorldPath(op.path, root)}; no write was needed.`,
      });
      continue;
    }
    for (const replacement of replacements.sort(
      (left, right) => right.start - left.start,
    ))
      lines.splice(replacement.start, replacement.count, ...replacement.lines);
    const next = lines.join("\n") + (trailing ? "\n" : "");
    const target = op.moveTo ?? op.path;
    await api.writeFile(target, encoder.encode(next), {});
    if (op.moveTo && op.moveTo !== op.path) await api.remove(op.path, {});
    results.push({
      kind: "update",
      path: absoluteWorldPath(op.path, root),
      ...(op.moveTo ? { movedTo: absoluteWorldPath(op.moveTo, root) } : {}),
      written: absoluteWorldPath(target, root),
    });
  }
  return JSON.stringify({ results });
};

const handleGlob = async (
  api: WorldToolFileApi,
  args: Record<string, unknown>,
  root: string,
): Promise<string> => {
  const pattern = String(args.pattern ?? args.glob ?? "**/*");
  const prefix =
    args.path === undefined ? "" : worldRelativeToolPath(args.path, root);
  const expression = globRegex(pattern);
  const requested = Number(args.max_results ?? TOOL_GLOB_DEFAULT_RESULTS);
  const maxResults = Number.isFinite(requested)
    ? Math.max(1, Math.min(10_000, Math.trunc(requested)))
    : TOOL_GLOB_DEFAULT_RESULTS;
  let cursor =
    typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
  const output: string[] = [];
  let outputBytes = 0;
  for (;;) {
    const pageCursor = cursor;
    const page = await api.list(prefix, {
      ...(cursor ? { cursor } : {}),
      limit: Math.max(1, Math.min(25, maxResults - output.length)),
    });
    const matches = page.entries
      .filter((entry) =>
        expression.test(
          prefix === "" ? entry.path : entry.path.slice(prefix.length + 1),
        ),
      )
      .map((entry) => absoluteWorldPath(entry.path, root));
    const pageBytes = matches.reduce(
      (total, value) => total + encoder.encode(`${value}\n`).byteLength,
      0,
    );
    if (outputBytes + pageBytes > TOOL_OUTPUT_LIMIT_BYTES) {
      const continuation = pageCursor ?? "<start>";
      return `${output.join("\n")}${output.length ? "\n" : ""}[Glob results truncated before a complete listing page. Continue with cursor=${JSON.stringify(continuation)}, or narrow the path/pattern.]`;
    }
    output.push(...matches);
    outputBytes += pageBytes;
    if (!page.cursor) return output.join("\n");
    if (output.length >= maxResults)
      return `${output.join("\n")}\n[Glob results truncated at ${output.length} matches. Continue with cursor=${JSON.stringify(page.cursor)}.]`;
    cursor = page.cursor;
  }
};

export const executeWorldTool = async (
  api: WorldToolFileApi,
  call: WorldToolCall,
  root: string,
): Promise<WorldToolResult> => {
  try {
    const output =
      call.name === "Read"
        ? await handleRead(api, call.arguments, root)
        : call.name === "Write"
          ? await handleWrite(api, call.arguments, root)
          : call.name === "Edit"
            ? await handleEdit(api, call.arguments, root)
            : call.name === "Grep"
              ? await handleGrep(api, call.arguments, root)
              : call.name === "apply_patch"
                ? await handlePatch(api, call.arguments, root)
                : await handleGlob(api, call.arguments, root);
    return { ok: true, output, revision: 0 };
  } catch (error) {
    return { ok: false, output: asError(error), revision: 0 };
  }
};
