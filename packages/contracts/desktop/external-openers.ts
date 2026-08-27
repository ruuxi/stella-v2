export type ExternalOpenerKind =
  | "app"
  | "default"
  | "reveal";

export type ExternalOpener = {
  id: string;
  label: string;
  kind: ExternalOpenerKind;
};

export const DEVELOPER_EXTS = [

  "c",
  "cc",
  "cpp",
  "cxx",
  "h",
  "hh",
  "hpp",
  "m",
  "mm",

  "cs",
  "fs",
  "vb",

  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "vue",
  "svelte",
  "astro",

  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",

  "java",
  "kt",
  "kts",
  "scala",
  "groovy",
  "clj",
  "cljs",

  "swift",

  "rs",
  "go",
  "zig",
  "nim",

  "py",
  "rb",
  "pl",
  "lua",
  "r",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",

  "json",
  "json5",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "xml",
  "csv",
  "tsv",

  "sql",
  "graphql",
  "gql",
  "proto",

  "txt",
  "md",
  "mdx",
  "log",
  "diff",
  "patch",
  "lock",
  "dockerfile",
  "makefile",

  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "elm",
  "dart",
  "tf",
  "hcl",
  "sol",
];

export const CODE_EXTS = DEVELOPER_EXTS;

export const SLIDE_EXTS = ["key", "pptx", "ppt"];
export const DOC_EXTS = ["pages", "docx", "doc", "rtf", "odt"];
export const SHEET_EXTS = ["numbers", "xlsx", "xls", "ods"];
export const PDF_EXTS = ["pdf"];
export const IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "heic",
  "svg",
  "ico",
];
export const VIDEO_EXTS = [
  "mp4",
  "mov",
  "m4v",
  "avi",
  "mkv",
  "webm",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
];
export const AUDIO_EXTS = [
  "mp3",
  "wav",
  "aac",
  "flac",
  "ogg",
  "oga",
  "m4a",
  "aiff",
  "aif",
  "opus",
  "wma",
];
export const HTML_EXTS = ["html", "htm", "xhtml"];

export const BROWSER_EXTS = [...IMAGE_EXTS, ...PDF_EXTS, ...HTML_EXTS];

export const extOf = (filePath: string): string => {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return base.toLowerCase();
  }
  return base.slice(dot + 1).toLowerCase();
};
