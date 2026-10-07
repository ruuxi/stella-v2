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

export const stripLocalFileLinks = (
  markdown: string,
  filePaths: readonly string[],
): string => {
  if (!markdown || filePaths.length === 0) return markdown;
  const hidden = new Set(filePaths);
  const stripped = markdown.replace(MARKDOWN_LINK_RE, (match, angled, bare) => {
    const filePath = parseLocalFileLinkTarget(angled ?? bare ?? "");
    return filePath && hidden.has(filePath) ? "" : match;
  });
  return stripped
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : line.replace(/[ \t]+$/, "")))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
