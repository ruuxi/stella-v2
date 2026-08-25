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

export type MobileMapTravelMode = "driving" | "walking" | "cycling" | "transit";

export type MobileMapMarker = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string;
  placeId?: string;
  rating?: number;
  ratingCount?: number;
  role?: "origin" | "destination" | "place";
};

export type MobileMapRoute = {
  mode: MobileMapTravelMode;
  originId: string;
  destinationId: string;
  distanceMeters: number;
  durationSeconds: number;
  summary?: string;

  polyline: string;
  steps?: { instruction: string; distanceMeters: number }[];
};

export type MobileAgentWorkFileSection = {
  agentId: string;

  title: string;
  files: MobileDisplayPayload[];

  summary?: string;
};

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
  | {
      kind: "pdf";
      filePath: string;
      title?: string;

      localUri?: string;

      sizeBytes?: number;
      textOffset?: number;
      toolCallId?: string;
    }
  | {
      kind: "media";
      asset: MobileMediaAsset;
      createdAt: number;
      prompt?: string;
      capability?: string;
      presentation?: "inline-image";
      aspectRatio?: string;
      numImages?: number;
      toolCallId?: string;
      generationState?: "running" | "completed" | "failed" | "canceled";

      textOffset?: number;
    }
  | {
      kind: "agent-work";
      state: "running" | "done";

      agentIds?: string[];
      total: number;
      completed: number;
      title: string;
      subtitle: string;
      createdAt: number;

      textOffset?: number;

      textOffsetsByAgentId?: Record<string, number>;

      agents?: MobileAgentWorkFileSection[];

      followUp?: boolean;

      failed?: boolean;
    }
  | {
      kind: "map-route";
      version: 1;
      title?: string;
      markers: MobileMapMarker[];
      route?: MobileMapRoute;
    };

export type ChatArtifact = {
  id: string;
  conversationId: string;
  payload: MobileDisplayPayload;

  textOffset?: number;
};

export type ComposerQuote = {
  id: string;
  text: string;
};

export type ChatMessage = {
  id: string;

  canonicalId?: string;

  requestId?: string;

  createdAt?: number;

  canonicalCreatedAt?: number;
  /**
   * Durable desktop source row used for backward keyset pagination. Synthetic
   * mobile projections (for example `:agent` cards) keep their own stable id,
   * but paging must continue from the real SessionStore row that produced
   * them.
   */
  sourceMessageId?: string;
  sourceTimestamp?: number;
  /**
   * Authoritative monotonic ordering key from the desktop (chat-ordering
   * re-architecture). When every row carries it the transcript is ordered by it
   * (jump-free, clock-independent). Present on canonical rows; absent on
   * in-flight optimistic rows until they reconcile, and on rows from a peer
   * desktop on an older build that never sends it — in those windows the merge
   * falls back to canonical insertion order (see rederiveOrder) so a row never
   * inverts above its neighbours.
   */
  sequence?: number;
  role: "assistant" | "user";
  text: string;
  artifacts?: ChatArtifact[];

  toolSteps?: ToolStep[];

  tasks?: MobileTask[];

  hasImage?: boolean;

  thumbnailUris?: string[];

  quotedText?: string;

  queued?: boolean;

  stopped?: boolean;

  cloudFallback?: boolean;
};

export type MobileTask = {
  id: string;
  title: string;

  agentType?: string;

  parentAgentId?: string;
  status: "running" | "completed" | "error" | "canceled";

  updatedAt?: number;

  statusText?: string;

  resultText?: string;

  errorMessage?: string;

  reasoningSummaries?: string[];
  createdAt: number;
  completedAt?: number;
};

export type DesktopBridgeStatus = {
  available: boolean;
  baseUrls: string[];
  platform: string | null;
  updatedAt: number | null;

  lastKnownRegistration: DesktopBridgeRegistrationDescriptor | null;
};

export type DesktopBridgeRegistrationDescriptor = {
  desktopDeviceId: string;
  baseUrls: string[];
  platform: string | null;
  desktopPublicKey: string | null;
  updatedAt: number;
};
