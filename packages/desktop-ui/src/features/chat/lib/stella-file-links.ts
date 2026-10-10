import { cloudWorldDrivePath } from "@stella/contracts/cloud-world-paths";
import type { Plugin } from "unified";
import type { Image, Link, Parent, Root, RootContent, Text } from "mdast";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import { parseLocalFileLinkTarget } from "@stella/contracts/local-file-links";
import { parseStellaAppUrl } from "@stella/contracts/workspace-apps";
import {
  basenameOf,
  extensionOf,
} from "@/features/workspace-display/path-to-viewer";
import { buildPayloadFromBarePath } from "./derive-turn-resource";

export const STELLA_FILE_TAG = "stella-file";
export const STELLA_FILE_TAG_ATTRIBUTES = ["path", "label"] as const;
/** `stella://app/<slug>` links become `<stella-app slug label>` the same way. */
export const STELLA_APP_TAG = "stella-app";
export const STELLA_APP_TAG_ATTRIBUTES = ["slug", "label"] as const;

export const parseStellaFileUrl = parseLocalFileLinkTarget;

export const displayPayloadForStellaFile = (
  filePath: string,
  createdAt: number,
): DisplayPayload | null => {
  const ext = extensionOf(filePath);
  if (ext === "html" || ext === "htm") {
    const fromOutputs = buildPayloadFromBarePath(filePath, createdAt);
    if (fromOutputs?.kind === "canvas-html") return fromOutputs;
    return {
      kind: "canvas-html",
      filePath,
      title: basenameOf(filePath),
      createdAt,
    };
  }
  const payload = buildPayloadFromBarePath(filePath, createdAt);

  return payload && payload.kind !== "source-diff" ? payload : null;
};

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
const isImage = (node: RootContent): node is Image => node.type === "image";

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

const transformChildren = (parent: Parent, hiddenPaths: ReadonlySet<string>): void => {

  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index]!;
    if (isLink(child as RootContent)) {
      const appSlug = parseStellaAppUrl((child as Link).url ?? "");
      if (appSlug) {
        const label = textOfChildren(child as Parent).trim() || appSlug;
        parent.children.splice(index, 1, {
          type: "text",
          value: label,
          data: {
            hName: STELLA_APP_TAG,
            hProperties: { slug: appSlug, label },
            hChildren: [{ type: "text", value: label }],
          },
        } as unknown as RootContent);
        continue;
      }
      const path = parseLocalFileLinkTarget((child as Link).url ?? "");
      if (path) {
        const identity = cloudWorldDrivePath(path) ? `cloud:${cloudWorldDrivePath(path)}` : `local:${path}`;
        const label = textOfChildren(child as Parent);
        if (hiddenPaths.has(identity)) {
          parent.children.splice(index, 1, {
            type: "text",
            value: label.trim() && label.trim() !== path ? label : basenameOf(path),
          } as Text);
          continue;
        }
        parent.children.splice(index, 1, buildStellaFileNode(path, label));
        continue;
      }
    }
    if (isImage(child as RootContent)) {
      const path = parseLocalFileLinkTarget((child as Image).url ?? "");
      const identity = path
        ? cloudWorldDrivePath(path) ? `cloud:${cloudWorldDrivePath(path)}` : `local:${path}`
        : null;
      if (identity && hiddenPaths.has(identity)) {
        parent.children.splice(index, 1);
        continue;
      }
    }
    if (isText(child as RootContent)) {
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
      transformChildren(child as Parent, hiddenPaths);
      if (["paragraph", "listItem", "list"].includes(type) &&
          (child as Parent).children.every((node) => node.type === "text" && !(node as Text).value.trim())) {
        parent.children.splice(index, 1);
      }
    }
  }
};

export const remarkStellaFileLinks: Plugin<[(readonly string[])?], Root> = (hiddenPaths = []) => {
  return (tree) => {
    transformChildren(tree as Parent, new Set(hiddenPaths));
  };
};
