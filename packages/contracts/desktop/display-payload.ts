import { z } from "zod";
import type { OfficePreviewRef } from "@stella/contracts/office-preview";
import { officePreviewRefSchema } from "@stella/contracts/office-preview";

export type DisplayFileArtifactKind =
  | "office-document"
  | "office-spreadsheet"
  | "office-slides"
  | "delimited-table";

/**
 * Tagged union for resources Stella can surface in chat or the workspace panel.
 *
 * - `canvas-html` — file-backed self-contained HTML written by the orchestrator's
 *              `html` tool to `~/.stella/outputs/html/<slug>.html`. Rendered as an
 *              inline artifact card in chat AND opened in the Canvas panel tab.
 * - `office` — docx/xlsx/pptx live-preview produced by `stella-office preview`.
 *              Renders the existing OfficePreviewCard (iframe + auto-refresh).
 * - `markdown` — local Markdown / MDX files rendered in the panel.
 * - `source-diff` — developer-gated code-file change preview.
 * - `file-artifact` — a previewable local file without an existing live
 *              preview ref. The sidebar resolves it into the right viewer.
 * - `pdf`    — local PDF file rendered with react-pdf in the renderer.
 * - `media`  — generated media (image/video/audio/3d/text) materialized to
 *              `~/.stella/media/outputs/`. Emitted by the media materializer when
 *              any media job for the current owner succeeds.
 * - `trash`  — Stella's deferred-delete trash. The actual UI is intentionally
 *              owned by the future tab implementation; this payload wires the
 *              display tab, list, and force-delete contracts.
 *
 * The IPC channel `display:update` carries structured, tab-compatible
 * `DisplayPayload` objects.
 */
export type DisplayPayload =
  | {
      kind: "canvas-html";
      filePath: string;
      title?: string;
      slug?: string;
      createdAt: number;
    }
  | {
      /**
       * Live URL preview (e.g., per-social-session Vite dev server).
       * Rendered as an iframe in its own dedicated tab.
       */
      kind: "url";
      url: string;
      title: string;
      tabId: string;
      tooltip?: string;
    }
  | { kind: "office"; previewRef: OfficePreviewRef; title?: string }
  | {
      kind: "markdown";
      filePath: string;
      title?: string;
      createdAt?: number;
    }
  | {
      kind: "source-diff";
      filePath: string;
      title?: string;
      patch?: string;
      createdAt?: number;
    }
  | {
      kind: "file-artifact";
      filePath: string;
      artifactKind: DisplayFileArtifactKind;
      title?: string;
      createdAt?: number;
    }
  | { kind: "pdf"; filePath: string; title?: string }
  | {
      kind: "trash";
      title?: string;
      createdAt?: number;
    }
  | {
      kind: "media";
      asset: MediaAsset;
      jobId?: string;
      capability?: string;
      prompt?: string;
      aspectRatio?: string;
      requestedSize?: { width: number; height: number };
      presentation?: "inline-image";
      /** Which image from a multi-image job this inline card represents. */
      imageIndex?: number;
      /** Expected image count for in-flight jobs (placeholders). */
      numImages?: number;
      /** Mobile bridge identity used to replace the matching pending card. */
      toolCallId?: string;
      /** Mobile-only lifecycle metadata; desktop rendering remains unchanged. */
      generationState?: "running" | "completed" | "failed" | "canceled";
      /** Mobile chat insertion position within the owning assistant segment. */
      textOffset?: number;
      createdAt: number;
    };

/**
 * All current display payload kinds can render in the workspace panel as a
 * tab. The historical `html` (inline-only) kind has been replaced by
 * `canvas-html`, which is file-backed and lives in the Canvas tab.
 */
export type DisplayTabPayload = DisplayPayload;

/**
 * What was generated. Mirrors the shape of `OutputMedia` in
 * `desktop/src/app/media/media-store.ts` but uses local file paths instead of
 * remote URLs so we don't depend on time-bounded provider URLs at view time.
 */
export type MediaAsset =
  | { kind: "image"; filePaths: string[] }
  | { kind: "video"; filePath: string }
  | { kind: "audio"; filePath: string }
  | { kind: "model3d"; filePath: string; label?: string }
  | { kind: "download"; filePath: string; label: string }
  | { kind: "text"; text: string };

const httpUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
});

const anyNumber = z.custom<number>((value) => typeof value === "number");

const mediaAssetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), filePaths: z.array(z.string()) }),
  z.object({ kind: z.literal("video"), filePath: z.string() }),
  z.object({ kind: z.literal("audio"), filePath: z.string() }),
  z.object({ kind: z.literal("model3d"), filePath: z.string() }),
  z.object({ kind: z.literal("download"), filePath: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string() }),
]);

const markdownLikeShape = {
  filePath: z.string(),
  title: z.string().optional(),
  patch: z.string().optional(),
  createdAt: z.number().optional(),
};

const displayPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("canvas-html"),
    filePath: z.string(),
    createdAt: z.number(),
    title: z.string().optional(),
    slug: z.string().optional(),
  }),
  z.object({
    kind: z.literal("url"),
    url: httpUrlSchema,
    title: z.string(),
    tabId: z.string(),
  }),
  z.object({ kind: z.literal("office"), previewRef: officePreviewRefSchema }),
  z.object({ kind: z.literal("markdown"), ...markdownLikeShape }),
  z.object({ kind: z.literal("source-diff"), ...markdownLikeShape }),
  z.object({
    kind: z.literal("file-artifact"),
    filePath: z.string(),
    artifactKind: z.enum([
      "office-document",
      "office-spreadsheet",
      "office-slides",
      "delimited-table",
    ]),
    createdAt: z.number().optional(),
  }),
  z.object({ kind: z.literal("pdf"), filePath: z.string() }),
  z.object({
    kind: z.literal("trash"),
    title: z.string().optional(),
    createdAt: z.number().optional(),
  }),
  z.object({
    kind: z.literal("media"),
    asset: mediaAssetSchema,
    createdAt: anyNumber,
  }),
]);

export const isDisplayPayload = (value: unknown): value is DisplayPayload =>
  displayPayloadSchema.safeParse(value).success;

export const isDisplayTabPayload = (
  value: unknown,
): value is DisplayTabPayload => isDisplayPayload(value);

/** Validate payloads accepted by the workspace panel's display channel. */
export const normalizeDisplayPayload = (
  value: unknown,
): DisplayTabPayload | null => (isDisplayTabPayload(value) ? value : null);

/** Quick title helper for the sidebar header / external open. */
export const getDisplayPayloadTitle = (payload: DisplayPayload): string => {
  if (payload.kind === "canvas-html") {
    return payload.title ?? payload.filePath.split("/").pop() ?? "Canvas";
  }
  if (payload.kind === "url") return payload.title;
  if (payload.kind === "office") {
    return payload.title ?? payload.previewRef.title;
  }
  if (payload.kind === "markdown" || payload.kind === "source-diff") {
    return payload.title ?? payload.filePath.split("/").pop() ?? "File";
  }
  if (payload.kind === "file-artifact") {
    return payload.title ?? payload.filePath.split("/").pop() ?? "File";
  }
  if (payload.kind === "pdf") {
    return payload.title ?? payload.filePath.split("/").pop() ?? "Document";
  }
  if (payload.kind === "trash") {
    return payload.title ?? "Trash";
  }
  // payload.kind === "media"
  if (payload.prompt) return payload.prompt;
  if (payload.capability) return payload.capability.replace(/_/g, " ");
  switch (payload.asset.kind) {
    case "image":
      return payload.asset.filePaths.length > 1
        ? "Generated images"
        : "Generated image";
    case "video":
      return "Generated video";
    case "audio":
      return "Generated audio";
    case "model3d":
      return payload.asset.label ?? "Generated 3D model";
    case "download":
      return payload.asset.label;
    case "text":
      return "Generated text";
  }
};
