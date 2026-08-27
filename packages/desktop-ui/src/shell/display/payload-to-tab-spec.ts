import { createElement } from "react";
import { uiState } from "@/platform/ui-state";
import type {
  DisplayPayload,
  DisplayTabPayload,
} from "@stella/contracts/desktop/display-payload";
import { getDisplayPayloadTitle } from "@stella/contracts/desktop/display-payload";
import {
  UrlTabContent,
  MarkdownTabContent,
  SourceDiffTabContent,
  PdfTabContent,
  OfficeTabContent,
  OfficeFileTabContent,
  DelimitedTableTabContent,
  MediaTabContent,
  TrashTabContent,
} from "./tab-content";
import { CanvasTabContent } from "./canvas-tab/CanvasTabContent";
import { AgentThreadChatTab } from "./AgentThreadChatTab";
import {
  addCanvasHtmlItem,
  canvasDisplayTabId,
} from "./canvas-tab/canvas-items";
import type { DisplayTabSpec } from "@/features/workspace-display/types";
import { kindForPath } from "@/features/workspace-display/path-to-viewer";
import { SOURCE_DIFF_TAB_ID } from "@/features/workspace-display/source-diff-batches";
import {
  registerWorkspaceDisplayPayloadAdapter,
  type AgentThreadTabArgs,
} from "@/features/workspace-display/open-payload";
import { displayTabKindForPayload } from "@/features/workspace-display/payload-kind";
import {
  recordArtifactFileEntry,
  setFileEntries,
  type FileEntry,
} from "@/features/workspace-display/files-index";
import { sidebarSections } from "@/features/workspace-display/sidebar-sections";
import { displayTabs } from "@/features/workspace-display/tab-store";

export const createSourceDiffTabSpec = (): DisplayTabSpec => ({
  id: SOURCE_DIFF_TAB_ID,
  kind: "source-diff",
  title: "Code changes",
  tooltip: "Recent file changes",
  metadata: { kind: "source-diff" },
  render: () => createElement(SourceDiffTabContent),
});

export type GeneratedMediaItem = {
  id: string;
  asset: Extract<DisplayPayload, { kind: "media" }>["asset"];
  prompt?: string;
  capability?: string;
  createdAt: number;
};

const GENERATED_MEDIA_ITEMS_KEY = "stella-display-generated-media-items";
const GENERATED_MEDIA_ITEMS_CAP = 300;

const isGeneratedMediaItem = (value: unknown): value is GeneratedMediaItem => {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GeneratedMediaItem>;
  return (
    typeof record.id === "string" &&
    typeof record.createdAt === "number" &&
    record.asset != null &&
    typeof record.asset === "object" &&
    "kind" in record.asset
  );
};

const loadGeneratedMediaItems = (): GeneratedMediaItem[] => {
  try {
    const parsed = JSON.parse(
      uiState.getItem(GENERATED_MEDIA_ITEMS_KEY) || "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isGeneratedMediaItem)
      .slice(-GENERATED_MEDIA_ITEMS_CAP);
  } catch {
    return [];
  }
};

const persistGeneratedMediaItems = (): void => {
  uiState.setItem(
    GENERATED_MEDIA_ITEMS_KEY,
    JSON.stringify(generatedMediaItems.slice(-GENERATED_MEDIA_ITEMS_CAP)),
  );
};

const generatedMediaItems: GeneratedMediaItem[] = loadGeneratedMediaItems();
const generatedMediaItemIds = new Set(
  generatedMediaItems.map((item) => item.id),
);

let generatedMediaSnapshot: ReadonlyArray<GeneratedMediaItem> = [];

const filePathForMediaItem = (item: GeneratedMediaItem): string | undefined => {
  switch (item.asset.kind) {
    case "image":
      return item.asset.filePaths[0];
    case "video":
    case "audio":
    case "model3d":
    case "download":
      return item.asset.filePath;
    case "text":
      return undefined;
  }
};

const basename = (filePath: string): string =>
  filePath.split(/[\\/]/).pop() || filePath;

const titleForMediaItem = (item: GeneratedMediaItem): string => {
  const filePath = filePathForMediaItem(item);
  if (filePath) return basename(filePath);
  return item.prompt?.trim() || "Text";
};

const toFileEntry = (item: GeneratedMediaItem): FileEntry => {
  const payload: DisplayPayload = {
    kind: "media",
    asset: item.asset,
    createdAt: item.createdAt,
    ...(item.prompt ? { prompt: item.prompt } : {}),
    ...(item.capability ? { capability: item.capability } : {}),
  };
  const filePath = filePathForMediaItem(item);
  return {
    source: "media",

    id: item.id,
    kind: displayTabKindForPayload(payload),
    title: titleForMediaItem(item),
    ...(filePath ? { filePath } : {}),
    createdAt: item.createdAt,
    payload,
  };
};

const refreshGeneratedMediaSnapshot = () => {
  generatedMediaSnapshot = generatedMediaItems.slice();
  setFileEntries("media", generatedMediaItems.map(toFileEntry));
};

refreshGeneratedMediaSnapshot();

const hashText = (text: string): string => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};

const idForMediaPayload = (
  payload: Extract<DisplayPayload, { kind: "media" }>,
): string => {
  const { asset } = payload;
  switch (asset.kind) {
    case "image":
      return `image:${asset.filePaths.join("|")}`;
    case "video":
    case "audio":
    case "model3d":
    case "download":
      return `${asset.kind}:${asset.filePath}`;
    case "text":
      return `text:${payload.jobId ?? `${payload.createdAt}:${hashText(asset.text)}`}`;
  }
};

const addGeneratedMediaItem = (
  payload: Extract<DisplayPayload, { kind: "media" }>,
): ReadonlyArray<GeneratedMediaItem> => {
  const payloads =
    payload.asset.kind === "image" && payload.asset.filePaths.length > 1
      ? payload.asset.filePaths.map((filePath) => ({
          ...payload,
          asset: { kind: "image" as const, filePaths: [filePath] },
        }))
      : [payload];

  for (const entry of payloads) {
    const id = idForMediaPayload(entry);
    if (!generatedMediaItemIds.has(id)) {
      generatedMediaItemIds.add(id);
      generatedMediaItems.push({
        id,
        asset: entry.asset,
        ...(entry.prompt ? { prompt: entry.prompt } : {}),
        ...(entry.capability ? { capability: entry.capability } : {}),
        createdAt: entry.createdAt,
      });
    }
  }
  refreshGeneratedMediaSnapshot();
  persistGeneratedMediaItems();
  return generatedMediaSnapshot;
};

const selectedIdForMediaPayload = (
  payload: Extract<DisplayPayload, { kind: "media" }>,
): string =>
  payload.asset.kind === "image" && payload.asset.filePaths.length > 1
    ? `image:${payload.asset.filePaths[0] ?? ""}`
    : idForMediaPayload(payload);

export const removeGeneratedMediaItem = (
  id: string,
): ReadonlyArray<GeneratedMediaItem> => {
  const idx = generatedMediaItems.findIndex((item) => item.id === id);
  if (idx === -1) return generatedMediaSnapshot;
  generatedMediaItems.splice(idx, 1);
  generatedMediaItemIds.delete(id);
  refreshGeneratedMediaSnapshot();
  persistGeneratedMediaItems();
  return generatedMediaSnapshot;
};

const rememberInFiles = (spec: DisplayTabSpec): DisplayTabSpec => {
  if (!displayTabs.getLayoutSnapshot().panelOpen) {
    sidebarSections.setLocation("files", spec.id);
  }
  return spec;
};

const indexInFiles = (
  spec: DisplayTabSpec,
  payload: DisplayTabPayload,
  filePath?: string,
): DisplayTabSpec => {
  recordArtifactFileEntry({
    id: spec.id,
    kind: spec.kind,
    title: spec.title,
    ...(filePath ? { filePath } : {}),

    createdAt: ("createdAt" in payload ? payload.createdAt : null) ?? Date.now(),
    payload,
  });
  return rememberInFiles(spec);
};

export const payloadToTabSpec = (
  payload: DisplayTabPayload,
): DisplayTabSpec => {
  const title = getDisplayPayloadTitle(payload);

  switch (payload.kind) {
    case "canvas-html": {
      const items = addCanvasHtmlItem(payload);
      const item = items.find((entry) => entry.filePath === payload.filePath)!;
      return rememberInFiles({
        id: canvasDisplayTabId(payload.filePath),
        kind: "canvas",
        title: item.title,
        tooltip: payload.filePath,
        metadata: { kind: "canvas-html", filePath: payload.filePath },
        render: () => createElement(CanvasTabContent, { item }),
      });
    }

    case "url":
      return indexInFiles(
        {
          id: payload.tabId,
          kind: "url",
          title,
          ...(payload.tooltip ? { tooltip: payload.tooltip } : {}),
          metadata: { kind: "url", url: payload.url },
          render: () =>
            createElement(UrlTabContent, {
              url: payload.url,
              title,
            }),
        },
        payload,
      );

    case "markdown":
      return indexInFiles(
        {
          id: `markdown:${payload.filePath}`,
          kind: "markdown",
          title,
          tooltip: payload.filePath,
          metadata: { kind: "markdown", filePath: payload.filePath },
          render: () =>
            createElement(MarkdownTabContent, {
              filePath: payload.filePath,
              ...(payload.title ? { title: payload.title } : {}),
            }),
        },
        payload,
        payload.filePath,
      );

    case "source-diff":

      return indexInFiles(createSourceDiffTabSpec(), payload);

    case "office": {
      const sourcePath = payload.previewRef.sourcePath;
      const kind = kindForPath(sourcePath);
      return indexInFiles(
        {
          id: `office:${sourcePath}`,
          kind:
            kind === "office-spreadsheet" || kind === "office-slides"
              ? kind
              : "office-document",
          title,
          tooltip: sourcePath,
          metadata: { kind: "office", sourcePath },
          render: () =>
            createElement(OfficeTabContent, { previewRef: payload.previewRef }),
        },
        payload,
        sourcePath,
      );
    }

    case "file-artifact":
      return indexInFiles(
        {
          id: `file-artifact:${payload.filePath}`,
          kind:
            payload.artifactKind === "delimited-table"
              ? "office-spreadsheet"
              : payload.artifactKind,
          title,
          tooltip: payload.filePath,
          metadata: {
            kind: "file-artifact",
            filePath: payload.filePath,
            artifactKind: payload.artifactKind,
          },
          render: () =>
            payload.artifactKind === "delimited-table"
              ? createElement(DelimitedTableTabContent, {
                  filePath: payload.filePath,
                  title,
                })
              : createElement(OfficeFileTabContent, {
                  filePath: payload.filePath,
                  title,
                  refreshToken: payload.createdAt,
                }),
        },
        payload,
        payload.filePath,
      );

    case "pdf":
      return indexInFiles(
        {
          id: `pdf:${payload.filePath}`,
          kind: "pdf",
          title,
          tooltip: payload.filePath,
          metadata: { kind: "pdf", filePath: payload.filePath },
          render: () =>
            createElement(PdfTabContent, {
              filePath: payload.filePath,
              ...(payload.title ? { title: payload.title } : {}),
            }),
        },
        payload,
        payload.filePath,
      );

    case "trash":

      return {
        id: "trash:deferred-delete",
        kind: "trash",
        title,
        metadata: { kind: "trash", createdAt: payload.createdAt },
        render: () => createElement(TrashTabContent),
      };

    case "media": {
      const items = addGeneratedMediaItem(payload);

      const itemId = selectedIdForMediaPayload(payload);
      const item = items.find((entry) => entry.id === itemId)!;
      return rememberInFiles({
        id: item.id,
        kind: displayTabKindForPayload(payload),
        title: titleForMediaItem(item),
        ...(payload.capability ? { tooltip: payload.capability } : {}),
        metadata: {
          kind: "media",
          ...(payload.jobId ? { jobId: payload.jobId } : {}),
          ...(payload.capability ? { capability: payload.capability } : {}),
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
        },
        render: () => createElement(MediaTabContent, { item }),
      });
    }
  }
};

export const createAgentThreadTabSpec = (
  args: AgentThreadTabArgs,
): DisplayTabSpec => ({
  id: `agent-thread:${args.threadId}`,
  kind: "chat",
  title: args.title,
  tooltip:
    args.source === "claude-native"
      ? "Claude subagent · read-only"
      : `${args.agentType} · read-only`,
  metadata: {
    kind: "agent-thread",
    threadId: args.threadId,
    conversationId: args.conversationId,
    source: args.source ?? "stella",
    readOnly: args.readOnly ?? true,
    ...(args.parentAgentId ? { parentAgentId: args.parentAgentId } : {}),
  },
  render: () =>
    createElement(AgentThreadChatTab, {
      threadId: args.threadId,
      conversationId: args.conversationId,
      agentType: args.agentType,
      source: args.source ?? "stella",
      readOnly: args.readOnly ?? true,
      parentAgentId: args.parentAgentId,
    }),
});

registerWorkspaceDisplayPayloadAdapter({
  payloadToTabSpec,
  createSourceDiffTabSpec,
  createAgentThreadTabSpec,
});
