import type { ToolStep } from "./lib/tool-activity";

export type MobileDisplayFileArtifactKind =
  | "office-document"
  | "office-spreadsheet"
  | "office-slides"
  | "delimited-table";

export type MobileMediaAsset =
  | { kind: "image"; filePaths: string[] }
  | { kind: "video"; filePath: string }
  | { kind: "audio"; filePath: string }
  | { kind: "model3d"; filePath: string; label?: string }
  | { kind: "download"; filePath: string; label: string }
  | { kind: "text"; text: string };

export type MobileOfficePreviewRef = {
  sessionId: string;
  title: string;
  sourcePath: string;
};

export type MobileDisplayPayload =
  | {
      kind: "canvas-html";
      filePath: string;
      title?: string;
      slug?: string;
      createdAt: number;
    }
  | { kind: "url"; url: string; title: string; tabId: string; tooltip?: string }
  | { kind: "office"; previewRef: MobileOfficePreviewRef; title?: string }
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
      artifactKind: MobileDisplayFileArtifactKind;
      title?: string;
      createdAt?: number;
    }
  | { kind: "pdf"; filePath: string; title?: string }
  | {
      kind: "media";
      asset: MobileMediaAsset;
      createdAt: number;
      prompt?: string;
      capability?: string;
    }
  | {
      /**
       * Inline "background work" card — work the computer kicked off in the
       * background (the mobile companion to the desktop agent card). Built
       * desktop-side from agent lifecycle events; not openable. State is
       * sync-time (running → done flips on the next sync).
       */
      kind: "agent-work";
      state: "running" | "done";
      total: number;
      completed: number;
      title: string;
      subtitle: string;
      createdAt: number;
    };

export type ChatArtifact = {
  id: string;
  conversationId: string;
  payload: MobileDisplayPayload;
};

export type ChatMessage = {
  id: string;
  /**
   * Desktop-local message id this row reconciled to. Mobile keeps `id` stable
   * for the just-streamed row so sync does not remount the bubble.
   */
  canonicalId?: string;
  /**
   * Desktop request id linking a row to its turn. Canonical assistant rows are
   * stamped with the turn's user-message id desktop-side; the streamed local
   * reply adopts it at turn end so later syncs can link the canonical reply to
   * the bubble instead of duplicating it.
   */
  requestId?: string;
  /**
   * Creation time (ms epoch) used to order the transcript. Local rows stamp
   * this at send time; desktop rows carry the canonical desktop `timestamp`.
   * Sync merges sort by this so synced history lands in its true chronological
   * slot instead of being appended to the tail. May be absent on legacy rows
   * persisted before this field existed.
   */
  createdAt?: number;
  role: "assistant" | "user";
  text: string;
  artifacts?: ChatArtifact[];
  /**
   * Assistant message: settled tool calls for this turn (oldest first), folded
   * into the inline tool-activity trace. Paired desktop-side and sent over the
   * bridge; see {@link import("./lib/tool-activity").deriveToolActivity}.
   */
  toolSteps?: ToolStep[];
  /**
   * Background tasks spawned by this turn. Collected conversation-wide into the
   * activity pill + tray; carried on the spawning message.
   */
  tasks?: MobileTask[];
  /** Present when the user attached images (text may be a short label like "Photo"). */
  hasImage?: boolean;
  /**
   * URIs of attached photo thumbnails for user messages, up to a few.
   * Best-effort: the file paths come from `expo-image-picker` results so
   * they survive in-session reloads but may become unreachable after a
   * reinstall or if the user deletes the source image — the `<Image>`
   * fallback covers that gracefully.
   */
  thumbnailUris?: string[];
  /**
   * User message: the message is queued behind an in-flight reply and has
   * not been dispatched yet. Renders dimmed with a small "Queued" label.
   */
  queued?: boolean;
  /**
   * Assistant message: the user pressed Stop before the reply completed.
   * Renders with a trailing "Stopped" affordance.
   */
  stopped?: boolean;
  /**
   * Assistant message: the paired desktop was unreachable, so this reply was
   * answered by the fallback responder instead. Renders a small "Answered
   * while your computer was offline" caption.
   */
  cloudFallback?: boolean;
};

/**
 * One background task (spawned agent) for the activity pill + tray. Folded
 * desktop-side from the turn's `agent-*` lifecycle events and sent over the
 * bridge on the spawning message.
 */
export type MobileTask = {
  id: string;
  title: string;
  status: "running" | "completed" | "error" | "canceled";
  /** Live narration while running ("Reading file…"). */
  statusText?: string;
  /**
   * Short reasoning summaries for this agent, ordered oldest→newest. Bridged
   * from the desktop and shown under the agent in the activity tray. May be
   * absent (older desktop builds) — treat undefined/empty as "no summary".
   */
  reasoningSummaries?: string[];
  createdAt: number;
  completedAt?: number;
};

export type DesktopBridgeStatus = {
  available: boolean;
  baseUrls: string[];
  platform: string | null;
  updatedAt: number | null;
};
