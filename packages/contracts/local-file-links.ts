const isWindowsAbsolutePath = (candidate: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(candidate);

export const isAbsoluteLocalFilePath = (candidate: string): boolean =>
  (candidate.startsWith("/") && !candidate.startsWith("//")) ||
  isWindowsAbsolutePath(candidate);

const decodeLinkTarget = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseLocalFileLinkTarget = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const decoded = decodeLinkTarget(trimmed);
  return isAbsoluteLocalFilePath(decoded) && decoded !== "/" ? decoded : null;
};

const MARKDOWN_LINK_RE =
  /!?\[[^\]]*?\]\(\s*(?:<([^>\r\n]+)>|([^()<>\s]+))\s*(?:["'][^"'\r\n]*["'])?\s*\)/g;

const withoutMarkdownCode = (markdown: string): string =>
  markdown
    .replace(
      /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g,
      "$1",
    )
    .replace(/(`+)[\s\S]*?\1/g, "");

const MARKDOWN_LINK_PARTS_RE =
  /(!?)\[([^\]]*?)\]\(\s*(?:<([^>\r\n]+)>|([^()<>\s]+))\s*(?:["'][^"'\r\n]*["'])?\s*\)/g;

const basenameOfPath = (filePath: string): string =>
  filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);

const FENCE_LINE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const LINE_MARKER_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+|>\s*)*/;
const SEPARATORS_ONLY_RE = /^(?:\s|[·•∙|/\\,;:.&+*_~—–-]|\band\b|\bor\b)*$/i;

/**
 * Rewrite a reply's prose line by line, leaving fenced code untouched.
 * `rewrite` returns the new line, or null to drop it; the blank lines a
 * dropped line leaves never stack up into an empty paragraph.
 */
const rewriteProseLines = (
  markdown: string,
  rewrite: (line: string) => string | null,
): string => {
  let fence: string | null = null;
  let dropped = false;
  const kept: string[] = [];
  for (const line of markdown.split("\n")) {
    const fenceMatch = FENCE_LINE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      kept.push(line);
      continue;
    }
    if (fence !== null) {
      kept.push(line);
      continue;
    }
    const next = rewrite(line);
    if (next === null) dropped = true;
    else kept.push(next);
  }
  const joined = kept.join("\n");
  return dropped ? joined.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim() : joined;
};

/** True when `line` is nothing but links to attached files plus separators. */
const isAttachmentOnlyLine = (
  line: string,
  isAttached: (filePath: string) => boolean,
): boolean => {
  let linked = false;
  const rest = line.replace(
    MARKDOWN_LINK_PARTS_RE,
    (match, _bang: string, _label: string, angled?: string, bare?: string) => {
      const filePath = parseLocalFileLinkTarget(angled ?? bare ?? "");
      if (!filePath || !isAttached(filePath)) return match;
      linked = true;
      return "";
    },
  );
  return linked && SEPARATORS_ONLY_RE.test(rest.replace(LINE_MARKER_RE, ""));
};

/**
 * Drop every line that is nothing but links to attached files plus separator
 * punctuation (`·`, `/`, `|`, `,`, dashes, "and"), such as a closing
 * `[Live homepage](…) · [Before](…) / [after](…)`: the attachments already show
 * those files, and keeping the line would leave a stray `· /` behind. Lines
 * with any other words are untouched.
 */
export const dropAttachmentOnlyLines = (
  markdown: string,
  isAttached: (filePath: string) => boolean,
): string =>
  markdown
    ? rewriteProseLines(markdown, (line) =>
        isAttachmentOnlyLine(line, isAttached) ? null : line,
      )
    : markdown;

/**
 * Keep a reply's words when its linked files render as attachments: a line of
 * nothing but such links goes (see `dropAttachmentOnlyLines`), a link inside a
 * sentence becomes its own label as plain text (the file name when the label
 * is empty or just the path), and an image embed of one is dropped because
 * the image itself shows beside the message. Code blocks are left alone.
 */
export const unlinkLocalFileLinks = (
  markdown: string,
  filePaths: readonly string[],
): string => {
  if (!markdown || filePaths.length === 0) return markdown;
  const attached = new Set(filePaths);
  const isAttached = (filePath: string) => attached.has(filePath);
  return rewriteProseLines(markdown, (line) =>
    isAttachmentOnlyLine(line, isAttached)
      ? null
      : line.replace(
          MARKDOWN_LINK_PARTS_RE,
          (match, bang: string, label: string, angled?: string, bare?: string) => {
            const filePath = parseLocalFileLinkTarget(angled ?? bare ?? "");
            if (!filePath || !attached.has(filePath)) return match;
            if (bang) return "";
            const text = label.trim();
            return text && text !== filePath ? label : basenameOfPath(filePath);
          },
        ),
  );
};

export const extractLocalFileLinkPaths = (markdown: string): string[] => {
  if (!markdown) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of withoutMarkdownCode(markdown).matchAll(MARKDOWN_LINK_RE)) {
    const filePath = parseLocalFileLinkTarget(match[1] ?? match[2] ?? "");
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
};
