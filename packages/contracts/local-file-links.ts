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

/**
 * Keep a reply's words when its linked files render as attachments: a link to
 * one of `filePaths` becomes its own label as plain text (the file name when
 * the label is empty or just the path), and an image embed of one is dropped
 * because the image itself shows beside the message. Nothing else changes.
 */
export const unlinkLocalFileLinks = (
  markdown: string,
  filePaths: readonly string[],
): string => {
  if (!markdown || filePaths.length === 0) return markdown;
  const attached = new Set(filePaths);
  return markdown.replace(
    MARKDOWN_LINK_PARTS_RE,
    (match, bang: string, label: string, angled?: string, bare?: string) => {
      const filePath = parseLocalFileLinkTarget(angled ?? bare ?? "");
      if (!filePath || !attached.has(filePath)) return match;
      if (bang) return "";
      const text = label.trim();
      return text && text !== filePath ? label : basenameOfPath(filePath);
    },
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
