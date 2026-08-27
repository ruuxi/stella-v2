import type { Plugin } from "unified";
import type { Link, Parent, Root, RootContent, Text } from "mdast";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import {
  basenameOf,
  extensionOf,
} from "@/features/workspace-display/path-to-viewer";
import { buildPayloadFromBarePath } from "./derive-turn-resource";

export const STELLA_FILE_URL_PREFIX = "stella://file";

export const STELLA_FILE_TAG = "stella-file";
export const STELLA_FILE_TAG_ATTRIBUTES = ["path", "label"] as const;

const isWindowsAbsolutePath = (candidate: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(candidate);

const isAbsoluteLocalPath = (candidate: string): boolean =>
  candidate.startsWith("/") || isWindowsAbsolutePath(candidate);

export const parseStellaFileUrl = (url: string): string | null => {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith(STELLA_FILE_URL_PREFIX)) return null;
  let rest = trimmed.slice(STELLA_FILE_URL_PREFIX.length);
  if (rest.startsWith("/")) {

    rest = rest.replace(/^\/+/, "");
  } else if (rest.length > 0) {

    return null;
  }
  if (!rest) return null;
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {

  }
  const path = isWindowsAbsolutePath(decoded) ? decoded : `/${decoded}`;
  if (!isAbsoluteLocalPath(path)) return null;

  if (path === "/") return null;
  return path;
};

export const displayPayloadForStellaFile = (
  filePath: string,
  createdAt: number,
): DisplayPayload | null => {
  const ext = extensionOf(filePath);
  if (ext === "html" || ext === "htm") {
    const fromOutputs = buildPayloadFromBarePath(filePath, createdAt, {
      produced: true,
    });
    if (fromOutputs?.kind === "canvas-html") return fromOutputs;
    return {
      kind: "canvas-html",
      filePath,
      title: basenameOf(filePath),
      createdAt,
    };
  }
  const payload = buildPayloadFromBarePath(filePath, createdAt, {
    produced: true,
  });

  return payload && payload.kind !== "source-diff" ? payload : null;
};

const BARE_STELLA_FILE_RE = /stella:\/\/file\/[^\s<>()"'`]+/gi;

const trimTrailingPunctuation = (raw: string): string =>
  raw.replace(/[.,;:!?]+$/, "");

type StellaFileNode = RootContent & {
  data: {
    hName: string;
    hProperties: { path: string; label: string };
    hChildren: Array<{ type: "text"; value: string }>;
  };
};

const buildStellaFileNode = (path: string, label: string): StellaFileNode => {
  const displayLabel = label.trim() || basenameOf(path);
  return {

    type: "text",
    value: displayLabel,
    data: {
      hName: STELLA_FILE_TAG,
      hProperties: { path, label: displayLabel },
      hChildren: [{ type: "text", value: displayLabel }],
    },
  } as unknown as StellaFileNode;
};

const isText = (node: RootContent): node is Text => node.type === "text";
const isLink = (node: RootContent): node is Link => node.type === "link";

const textOfChildren = (parent: Parent): string => {
  let out = "";
  for (const child of parent.children) {
    if (isText(child as RootContent)) {
      out += (child as Text).value;
    } else if ("children" in child && Array.isArray((child as Parent).children)) {
      out += textOfChildren(child as Parent);
    }
  }
  return out;
};

const splitTextNode = (node: Text): RootContent[] | null => {
  const value = node.value;
  if (!value || !value.toLowerCase().includes(STELLA_FILE_URL_PREFIX)) {
    return null;
  }
  BARE_STELLA_FILE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let cursor = 0;
  const out: RootContent[] = [];
  let touched = false;
  while ((match = BARE_STELLA_FILE_RE.exec(value)) !== null) {
    const raw = trimTrailingPunctuation(match[0]);
    const path = parseStellaFileUrl(raw);
    if (!path) continue;
    if (match.index > cursor) {
      out.push({
        type: "text",
        value: value.slice(cursor, match.index),
      } satisfies Text);
    }
    out.push(buildStellaFileNode(path, basenameOf(path)));
    cursor = match.index + raw.length;
    touched = true;
  }
  if (!touched) return null;
  if (cursor < value.length) {
    out.push({ type: "text", value: value.slice(cursor) } satisfies Text);
  }
  return out;
};

const transformChildren = (parent: Parent): void => {

  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index]!;
    if (isLink(child as RootContent)) {
      const path = parseStellaFileUrl((child as Link).url ?? "");
      if (path) {
        const label = textOfChildren(child as Parent);
        parent.children.splice(index, 1, buildStellaFileNode(path, label));
        continue;
      }
    }
    if (isText(child as RootContent)) {
      const replacements = splitTextNode(child as Text);
      if (replacements) {
        parent.children.splice(
          index,
          1,
          ...(replacements as Parent["children"]),
        );
      }
      continue;
    }

    const type = String((child as RootContent).type);
    if (
      type === "code" ||
      type === "inlineCode" ||
      type === "html" ||
      type === "math" ||
      type === "inlineMath"
    ) {
      continue;
    }
    if ("children" in child && Array.isArray((child as Parent).children)) {
      transformChildren(child as Parent);
    }
  }
};

export const remarkStellaFileLinks: Plugin<[], Root> = () => {
  return (tree) => {
    transformChildren(tree as Parent);
  };
};
