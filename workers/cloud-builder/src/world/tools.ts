import { absoluteWorldPath, pathWithin, worldRelativeToolPath } from "./path.js";
import { applyAnchoredEdit, formatWithHashLines, parseAnchor } from "./hashline.js";
import type { WorldEntry, WorldToolCall, WorldToolResult } from "./types.js";
import { sanitizeToolVisibleText } from "@stella/runtime/kernel/tools/safety.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOOL_FILE_LIMIT_BYTES = 1_000_000;

export type WorldToolFileApi = {
  stat(path: string): Promise<WorldEntry | null>;
  list(prefix: string, options?: { cursor?: string; limit?: number }): Promise<{ entries: WorldEntry[]; cursor?: string }>;
  readFile(path: string, options?: { offset?: number; length?: number }): Promise<Uint8Array | null>;
  writeFile(path: string, bytes: Uint8Array, options?: { mode?: number; mtime?: number }): Promise<WorldEntry>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
};

const listAll = async (api: WorldToolFileApi, prefix: string): Promise<WorldEntry[]> => {
  const entries: WorldEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api.list(prefix, { ...(cursor ? { cursor } : {}), limit: 10_000 });
    entries.push(...page.entries);
    if (!page.cursor) return entries;
    cursor = page.cursor;
  }
};

const asError = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown file tool error.";

const normalizeLf = (text: string): string => text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
const lineEnding = (text: string): "\r\n" | "\n" => text.includes("\r\n") ? "\r\n" : "\n";
const restoreLineEnding = (text: string, ending: "\r\n" | "\n"): string =>
  ending === "\n" ? text : text.replaceAll("\n", "\r\n");

const stripBom = (text: string): { bom: string; text: string } =>
  text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };

const fuzzyNormalizeText = (text: string): string =>
  text.split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‐‑‒–—―−]/gu, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");

const readText = async (api: WorldToolFileApi, path: string): Promise<string> => {
  const entry = await api.stat(path);
  if (!entry) throw new Error(`File not found: ${absoluteWorldPath(path)}`);
  if (entry.kind !== "file") throw new Error(`Path is not a file: ${absoluteWorldPath(path)}`);
  if (entry.size > TOOL_FILE_LIMIT_BYTES) {
    throw new Error(`File too large to read safely (${entry.size} bytes): ${absoluteWorldPath(path)}`);
  }
  const bytes = await api.readFile(path, {});
  if (!bytes) throw new Error(`File not found: ${absoluteWorldPath(path)}`);
  if (bytes.includes(0)) throw new Error(`Binary files are not supported: ${absoluteWorldPath(path)}`);
  return decoder.decode(bytes);
};

const handleRead = async (api: WorldToolFileApi, args: Record<string, unknown>): Promise<string> => {
  try {
    const path = worldRelativeToolPath(args.file_path);
    if (/\.(?:png|jpe?g|gif|webp)$/iu.test(path)) {
      throw new Error(`Binary files are not supported: ${absoluteWorldPath(path)}`);
    }
    const content = await readText(api, path);
    const offsetValue = Number(args.offset ?? 1);
    const limitValue = Number(args.limit ?? 2000);
    const offset = Number.isFinite(offsetValue) ? offsetValue : 1;
    const limit = Number.isFinite(limitValue) ? Math.max(0, limitValue) : 2000;
    const lines = normalizeLf(content).split("\n");
    const displayLines = normalizeLf(
      sanitizeToolVisibleText(content, { codeFile: true }),
    ).split("\n");
    const formatted = formatWithHashLines(lines, displayLines, offset, limit);
    return `File: ${absoluteWorldPath(path)}\n${formatted.header}\n\n${formatted.body}`;
  } catch (error) {
    throw new Error(`Error reading file: ${asError(error)}`);
  }
};

const handleWrite = async (api: WorldToolFileApi, args: Record<string, unknown>): Promise<string> => {
  try {
    const path = worldRelativeToolPath(args.file_path);
    const previous = await api.stat(path);
    const content = String(args.content ?? "");
    if (content.includes("\0")) throw new Error("File content contains a NUL byte.");
    let final = content;
    if (previous?.kind === "file") {
      const current = await readText(api, path);
      final = restoreLineEnding(normalizeLf(content), lineEnding(current));
    }
    await api.writeFile(path, encoder.encode(final), {});
    return previous ? `Wrote ${absoluteWorldPath(path)}` : `Created ${absoluteWorldPath(path)}`;
  } catch (error) {
    throw new Error(`Error writing file: ${asError(error)}`);
  }
};

const exactEdit = (content: string, oldText: string, newText: string, replaceAll: boolean): { content: string; replacements: number; noChange?: true } => {
  const { bom, text } = stripBom(content);
  const normalized = normalizeLf(text);
  const oldValue = normalizeLf(oldText);
  const newValue = normalizeLf(newText);
  if (!oldValue.trim()) throw new Error("old_string is empty or only whitespace; provide non-blank text to match.");
  if (newValue.length >= 8 && normalized.includes(newValue) && (oldValue === newValue || !normalized.includes(oldValue))) {
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
    throw new Error(`old_string matches ${locations.length} locations. Add surrounding context or set replace_all=true.\nMatches:\n${snippets.join("\n")}${locations.length > snippets.length ? `\n… and ${locations.length - snippets.length} more.` : ""}`);
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
      ? normalized.split("\n")
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.trim() === oldAnchor.trim())
      : [];
    const hints: string[] = [];
    if (matchingLines.length > 0) {
      hints.push(
        `Matching anchor location${matchingLines.length === 1 ? "" : "s"}:\n${matchingLines
          .slice(0, 5)
          .map(({ line, index }) => `L${index + 1}: ${line.trim().replace(/\s+/gu, " ").slice(0, 100)}`)
          .join("\n")}`,
      );
      const whitespaceMatch = matchingLines.find(({ line }) => line !== oldAnchor);
      if (whitespaceMatch) {
        const visualize = (line: string): string => {
          const leading = line.match(/^[\t ]*/u)?.[0] ?? "";
          return `${leading.replaceAll("\t", "→").replaceAll(" ", "·")}${line.slice(leading.length)}`;
        };
        hints.push(`Leading whitespace differs:\nfile has: ${visualize(whitespaceMatch.line)}\nyou sent: ${visualize(oldAnchor)}`);
      }
    }
    hints.push(matchingLines.length > 0
      ? "Re-read around those lines and retry with unique surrounding context."
      : "Re-read the file and retry with current, unique text.");
    throw new Error(`old_string not found in file.\n\n${hints.join("\n\n")}`);
  }
  if (oldValue === newValue) throw new Error("old_string and new_string are identical — no changes made.");
  const next = replaceAll ? normalized.split(oldValue).join(newValue) : replacementContent.slice(0, replacementIndex) + newValue + replacementContent.slice(replacementIndex + replacementLength);
  return { content: bom + restoreLineEnding(next, lineEnding(text)), replacements: replaceAll ? locations.length : 1 };
};

const handleEdit = async (api: WorldToolFileApi, args: Record<string, unknown>): Promise<string> => {
  const path = worldRelativeToolPath(args.file_path);
  const content = await readText(api, path).catch((error) => {
    throw new Error(`Error reading file: ${asError(error)}`);
  });
  const hasAnchor = args.anchor !== undefined && args.anchor !== null && args.anchor !== "";
  if (hasAnchor) {
    const ending = lineEnding(content);
    const endAnchor = args.end_anchor === undefined || args.end_anchor === null || args.end_anchor === "" ? undefined : parseAnchor(args.end_anchor);
    const applied = applyAnchoredEdit(normalizeLf(content), {
      anchor: parseAnchor(args.anchor),
      ...(endAnchor ? { endAnchor } : {}),
      newText: String(args.new_string ?? ""),
      ...(Boolean(args.insert_after) ? { insertAfter: true } : {}),
    });
    await api.writeFile(path, encoder.encode(restoreLineEnding(applied.content, ending)), {});
    const range = applied.startLine === applied.endLine ? `line ${applied.startLine}` : `lines ${applied.startLine}-${applied.endLine}`;
    const action = applied.linesRemoved === 0 ? "Inserted after" : "Replaced";
    return `${action} ${range} in ${absoluteWorldPath(path)} (-${applied.linesRemoved}/+${applied.linesAdded} lines)`;
  }
  const edited = exactEdit(content, String(args.old_string ?? ""), String(args.new_string ?? ""), Boolean(args.replace_all));
  if (edited.noChange) return `Edit already applied to ${absoluteWorldPath(path)}; no write was needed.`;
  await api.writeFile(path, encoder.encode(edited.content), {});
  return `Replaced ${edited.replacements} occurrence(s) in ${absoluteWorldPath(path)}`;
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
  ts: ["ts", "tsx"], js: ["js", "jsx", "mjs", "cjs"], json: ["json"], rust: ["rs"], py: ["py"], css: ["css", "scss", "sass", "less"], html: ["html", "htm"], md: ["md", "markdown"], yaml: ["yaml", "yml"], toml: ["toml"], shell: ["sh", "bash", "zsh"],
};

const handleGrep = async (api: WorldToolFileApi, args: Record<string, unknown>): Promise<string> => {
  const pattern = String(args.pattern ?? "");
  const prefix = args.path === undefined ? "" : worldRelativeToolPath(args.path);
  const base = await api.stat(prefix);
  if (prefix && !base) throw new Error(`Path not found: ${absoluteWorldPath(prefix)}\nCheck the path or search its nearest existing parent directory.`);
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, Boolean(args.case_insensitive) ? "giu" : "gu");
  } catch (error) {
    throw new Error(`Invalid regular expression '${pattern}': ${asError(error)}. Escape metacharacters to search for literal text.`);
  }
  const outputMode = String(args.output_mode ?? "files_with_matches");
  const contextLines = Math.max(0, Number(args.context_lines ?? 0));
  const maxResults = Math.max(1, Math.min(10_000, Number(args.max_results ?? 100)));
  const matchGlob = args.glob ? globRegex(String(args.glob)) : null;
  const extensions = args.type ? typeExtensions[String(args.type)] : undefined;
  const listed = base?.kind === "file" ? [base] : await listAll(api, prefix);
  const output: string[] = [];
  for (const entry of listed) {
    if (entry.kind !== "file" || !pathWithin(entry.path, prefix)) continue;
    const relative = prefix === "" ? entry.path : entry.path.slice(prefix.length + 1);
    if (matchGlob && !matchGlob.test(relative)) continue;
    if (extensions && !extensions.includes(entry.path.split(".").pop()?.toLowerCase() ?? "")) continue;
    const bytes = await api.readFile(entry.path, {});
    if (!bytes || bytes.includes(0)) continue;
    const lines = decoder.decode(bytes).split("\n");
    const matching: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      expression.lastIndex = 0;
      if (expression.test(lines[index] ?? "")) matching.push(index);
      if (matching.length >= maxResults) break;
    }
    if (matching.length === 0) continue;
    const absolute = absoluteWorldPath(entry.path);
    if (outputMode === "files_with_matches") output.push(absolute);
    else if (outputMode === "count") output.push(`${absolute}:${matching.length}`);
    else {
      const included = new Set<number>();
      for (const index of matching) for (let line = Math.max(0, index - contextLines); line <= Math.min(lines.length - 1, index + contextLines); line += 1) included.add(line);
      for (const index of [...included].sort((left, right) => left - right)) {
        output.push(`${base?.kind === "file" ? "" : `${absolute}:`}${index + 1}:${lines[index] ?? ""}`);
      }
    }
    if (output.length >= maxResults) break;
  }
  if (output.length === 0) return `No matches found for pattern: ${pattern}`;
  return `Found matches:\n\n${output.slice(0, maxResults).join("\n").slice(0, 100_000)}\n`;
};

type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Array<{ header?: string; lines: Array<{ kind: "context" | "remove" | "add"; text: string }>; eof?: boolean }> };

const parsePatch = (value: string): PatchOp[] => {
  let text = value.replaceAll("\r\n", "\n").trim();
  const wrapped = text.split("\n");
  if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(wrapped[0] ?? "") && wrapped.at(-1)?.endsWith("EOF")) text = wrapped.slice(1, -1).join("\n");
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "*** Begin Patch") throw new Error("apply_patch input must start with `*** Begin Patch`.");
  const ops: PatchOp[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "*** End Patch") return ops;
    if (line.startsWith("*** Add File: ")) {
      const path = worldRelativeToolPath(line.slice(14).trim());
      const added: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("*** ")) {
        const next = lines[index] ?? "";
        if (!next.startsWith("+")) throw new Error(`apply_patch: lines under '*** Add File: ${absoluteWorldPath(path)}' must start with '+'. Saw: '${next}'`);
        added.push(next.slice(1));
        index += 1;
      }
      ops.push({ kind: "add", path, lines: added });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", path: worldRelativeToolPath(line.slice(17).trim()) });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = worldRelativeToolPath(line.slice(17).trim());
      index += 1;
      let moveTo: string | undefined;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        moveTo = worldRelativeToolPath((lines[index] ?? "").slice(13).trim());
        index += 1;
      }
      const hunks: Extract<PatchOp, { kind: "update" }>["hunks"] = [];
      while (index < lines.length && (!(lines[index] ?? "").startsWith("*** ") || lines[index] === "*** End of File")) {
        if ((lines[index] ?? "").trim() === "") { index += 1; continue; }
        const hunk: (typeof hunks)[number] = { lines: [] };
        if ((lines[index] ?? "").startsWith("@@")) {
          const header = (lines[index] ?? "").slice(2).trim();
          if (header) hunk.header = header;
          index += 1;
        } else if (hunks.length > 0) throw new Error(`apply_patch: expected '@@' header inside Update File '${absoluteWorldPath(path)}'.`);
        while (index < lines.length) {
          const next = lines[index] ?? "";
          if (next === "*** End of File") { hunk.eof = true; index += 1; break; }
          if (next.startsWith("*** ") || next.startsWith("@@")) break;
          if (next === "") hunk.lines.push({ kind: "context", text: "" });
          else if (next[0] === "+") hunk.lines.push({ kind: "add", text: next.slice(1) });
          else if (next[0] === "-") hunk.lines.push({ kind: "remove", text: next.slice(1) });
          else if (next[0] === " ") hunk.lines.push({ kind: "context", text: next.slice(1) });
          else throw new Error(`apply_patch: hunk lines must start with '+', '-', or ' '. Saw: '${next}'`);
          index += 1;
        }
        if (hunk.lines.length === 0 && !hunk.eof) {
          throw new Error(`apply_patch: empty hunk inside Update File '${absoluteWorldPath(path)}'.`);
        }
        hunks.push(hunk);
      }
      if (hunks.length === 0) {
        throw new Error(`apply_patch: Update File '${absoluteWorldPath(path)}' has no hunks.`);
      }
      ops.push({ kind: "update", path, ...(moveTo ? { moveTo } : {}), hunks });
      continue;
    }
    if (line.trim() === "") { index += 1; continue; }
    throw new Error(`apply_patch: unexpected line outside of an op: '${line}'`);
  }
  throw new Error("apply_patch: missing `*** End Patch` terminator.");
};

const fuzzy = (value: string): string => value.trim().replace(/[‐‑‒–—―−]/gu, "-").replace(/[‘’‚‛]/gu, "'").replace(/[“”„‟]/gu, '"').replace(/\s/gu, " ");
const seek = (lines: string[], pattern: string[], start: number, eof: boolean): number => {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return -1;
  const first = eof ? lines.length - pattern.length : start;
  for (const compare of [(a: string, b: string) => a === b, (a: string, b: string) => a.trimEnd() === b.trimEnd(), (a: string, b: string) => a.trim() === b.trim(), (a: string, b: string) => fuzzy(a) === fuzzy(b)]) {
    for (let index = first; index <= lines.length - pattern.length; index += 1) if (pattern.every((line, offset) => compare(lines[index + offset] ?? "", line))) return index;
  }
  return -1;
};

const exactLocations = (lines: string[], pattern: string[]): number[] => {
  if (pattern.length === 0 || pattern.length > lines.length) return [];
  const locations: number[] = [];
  for (let index = 0; index <= lines.length - pattern.length; index += 1) {
    if (pattern.every((line, offset) => lines[index + offset] === line)) locations.push(index);
  }
  return locations;
};

const patchMissHint = (lines: string[], expected: string[]): string => {
  const anchors = expected
    .map((line) => ({ line, normalized: fuzzy(line) }))
    .filter(({ normalized }) => normalized.length >= 4)
    .sort((left, right) => right.normalized.length - left.normalized.length);
  const fallback = anchors[0];
  if (!fallback) return "Re-read the file and retry with a non-empty, unique context anchor.";
  let anchor = fallback;
  let locations: number[] = [];
  for (const candidate of anchors) {
    const found = lines.flatMap((line, index) => fuzzy(line) === candidate.normalized ? [index] : []);
    if (found.length > 0) { anchor = candidate; locations = found; break; }
  }
  const parts: string[] = [];
  if (locations.length > 0) {
    const shown = locations.slice(0, 5).map((index) => {
      const compact = (lines[index] ?? "").trim().replace(/\s+/gu, " ");
      return `L${index + 1}: ${compact.length > 100 ? `${compact.slice(0, 100)}…` : compact}`;
    });
    parts.push(`Matching anchor location${locations.length === 1 ? "" : "s"}:\n${shown.join("\n")}${locations.length > shown.length ? `\n… and ${locations.length - shown.length} more.` : ""}`);
  }
  const whitespaceLocation = locations.find((index) => (lines[index] ?? "").trim() === anchor.line.trim() && lines[index] !== anchor.line);
  if (whitespaceLocation !== undefined) {
    const visualize = (line: string): string => {
      const leading = line.match(/^[\t ]*/u)?.[0] ?? "";
      return `${leading.replaceAll("\t", "→").replaceAll(" ", "·")}${line.slice(leading.length)}`;
    };
    parts.push(`Leading whitespace differs:\nfile has: ${visualize(lines[whitespaceLocation] ?? "")}\nyou sent: ${visualize(anchor.line)}`);
  }
  parts.push(locations.length > 0
    ? "Re-read around those lines and retry with the exact surrounding context."
    : "No matching anchor line was found. Re-read the file and retry with current context.");
  return parts.join("\n\n");
};

const handlePatch = async (api: WorldToolFileApi, args: Record<string, unknown>): Promise<string> => {
  const patch = String(args.input ?? args.patch ?? "").trim();
  if (!patch) throw new Error("apply_patch requires a patch envelope.");
  const results: Array<Record<string, unknown>> = [];
  for (const op of parsePatch(patch)) {
    if (op.kind === "add") {
      if (await api.stat(op.path)) throw new Error(`apply_patch: file already exists for Add: ${absoluteWorldPath(op.path)}`);
      await api.writeFile(op.path, encoder.encode(op.lines.join("\n") + (op.lines.length ? "\n" : "")), {});
      results.push({ kind: "add", path: absoluteWorldPath(op.path) });
      continue;
    }
    if (op.kind === "delete") {
      if (!(await api.stat(op.path))) throw new Error(`apply_patch: file not found for Delete: ${absoluteWorldPath(op.path)}`);
      await api.remove(op.path, {});
      results.push({ kind: "delete", path: absoluteWorldPath(op.path) });
      continue;
    }
    let content: string;
    try { content = await readText(api, op.path); } catch { throw new Error(`apply_patch: file not found for Update: ${absoluteWorldPath(op.path)}`); }
    const trailing = content.endsWith("\n");
    const lines = trailing ? content.split("\n").slice(0, -1) : content.split("\n");
    let cursor = 0;
    const replacements: Array<{ start: number; count: number; lines: string[] }> = [];
    let alreadyAppliedHunks = 0;
    for (const hunk of op.hunks) {
      if (hunk.header) {
        const location = seek(lines, [hunk.header], cursor, false);
        if (location < 0) throw new Error(`apply_patch: failed to find context '${hunk.header}' in ${absoluteWorldPath(op.path)}.\n\n${patchMissHint(lines, [hunk.header])}`);
        cursor = location + 1;
      }
      const originalOldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
      let oldLines = originalOldLines;
      let newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
      if (oldLines.length === 0) {
        replacements.push({ start: lines.length, count: 0, lines: newLines });
        cursor = lines.length;
        continue;
      }
      let location = seek(lines, oldLines, cursor, hunk.eof === true);
      if (location < 0 && oldLines.at(-1) === "") {
        const trimmedOld = oldLines.slice(0, -1);
        const trimmedNew = newLines.at(-1) === "" ? newLines.slice(0, -1) : newLines;
        const retry = seek(lines, trimmedOld, cursor, hunk.eof === true);
        if (retry >= 0) { oldLines = trimmedOld; newLines = trimmedNew; location = retry; }
      }
      if (location < 0) {
        const newText = newLines.join("\n");
        if (newText.length >= 8 && newLines.length > 0 && exactLocations(lines, newLines).length > 0 && exactLocations(lines, oldLines).length === 0) {
          alreadyAppliedHunks += 1;
          continue;
        }
        throw new Error(`apply_patch: failed to find expected lines in ${absoluteWorldPath(op.path)}:\n${originalOldLines.join("\n")}\n\n${patchMissHint(lines, originalOldLines)}`);
      }
      replacements.push({ start: location, count: oldLines.length, lines: newLines });
      cursor = location + oldLines.length;
    }
    if (replacements.length === 0 && alreadyAppliedHunks > 0) {
      results.push({ kind: "noop", path: absoluteWorldPath(op.path), note: `Patch already applied to ${absoluteWorldPath(op.path)}; no write was needed.` });
      continue;
    }
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) lines.splice(replacement.start, replacement.count, ...replacement.lines);
    const next = lines.join("\n") + (trailing ? "\n" : "");
    const target = op.moveTo ?? op.path;
    await api.writeFile(target, encoder.encode(next), {});
    if (op.moveTo && op.moveTo !== op.path) await api.remove(op.path, {});
    results.push({
      kind: "update",
      path: absoluteWorldPath(op.path),
      ...(op.moveTo ? { movedTo: absoluteWorldPath(op.moveTo) } : {}),
      written: absoluteWorldPath(target),
    });
  }
  return JSON.stringify({ results });
};

const handleGlob = async (api: WorldToolFileApi, args: Record<string, unknown>): Promise<string> => {
  const pattern = String(args.pattern ?? args.glob ?? "**/*");
  const prefix = args.path === undefined ? "" : worldRelativeToolPath(args.path);
  const expression = globRegex(pattern);
  const listing = await listAll(api, prefix);
  return listing.filter((entry) => expression.test(prefix === "" ? entry.path : entry.path.slice(prefix.length + 1))).map((entry) => absoluteWorldPath(entry.path)).join("\n");
};

export const executeWorldTool = async (api: WorldToolFileApi, call: WorldToolCall): Promise<WorldToolResult> => {
  try {
    const output = call.name === "Read" ? await handleRead(api, call.arguments)
      : call.name === "Write" ? await handleWrite(api, call.arguments)
      : call.name === "Edit" ? await handleEdit(api, call.arguments)
      : call.name === "Grep" ? await handleGrep(api, call.arguments)
      : call.name === "apply_patch" ? await handlePatch(api, call.arguments)
      : await handleGlob(api, call.arguments);
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: asError(error) };
  }
};
