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
