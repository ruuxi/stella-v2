import type {
  ChatArtifact,
  MobileDisplayPayload,
  MobileMediaAsset,
} from "../types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object";

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const basenameOf = (filePath: string): string => {
  const cleaned = filePath.trim().split(/[?#]/)[0] ?? filePath.trim();
  const slash = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
};

const extensionOf = (filePath: string): string | null => {
  const tail = basenameOf(filePath);
  const dot = tail.lastIndexOf(".");
  return dot <= 0 || dot === tail.length - 1
    ? null
    : tail.slice(dot + 1).toUpperCase();
};

const isMediaAsset = (value: unknown): value is MobileMediaAsset => {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "image":
      return (
        Array.isArray(value.filePaths) &&
        value.filePaths.every((item) => typeof item === "string")
      );
    case "video":
    case "audio":
    case "model3d":
      return typeof value.filePath === "string";
    case "download":
      return (
        typeof value.filePath === "string" && typeof value.label === "string"
      );
    case "text":
      return typeof value.text === "string";
    default:
      return false;
  }
};

export const isMobileDisplayPayload = (
  value: unknown,
): value is MobileDisplayPayload => {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case "canvas-html":
      return (
        typeof value.filePath === "string" && isFiniteNumber(value.createdAt)
      );
    case "url":
      return typeof value.url === "string" && typeof value.title === "string";
    case "office":
      return (
        isRecord(value.previewRef) &&
        typeof value.previewRef.sessionId === "string" &&
        typeof value.previewRef.title === "string" &&
        typeof value.previewRef.sourcePath === "string"
      );
    case "markdown":
    case "source-diff":
    case "pdf":
      return typeof value.filePath === "string";
    case "file-artifact":
      return (
        typeof value.filePath === "string" &&
        (value.artifactKind === "office-document" ||
          value.artifactKind === "office-spreadsheet" ||
          value.artifactKind === "office-slides" ||
          value.artifactKind === "delimited-table")
      );
    case "media":
      return isMediaAsset(value.asset);
    case "agent-work":
      return (
        (value.state === "running" || value.state === "done") &&
        isString(value.title) &&
        isString(value.subtitle) &&
        isFiniteNumber(value.total) &&
        isFiniteNumber(value.completed) &&
        isFiniteNumber(value.createdAt)
      );
    default:
      return false;
  }
};

export const parseChatArtifacts = (
  value: unknown,
  conversationId: string,
): ChatArtifact[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index): ChatArtifact | null => {
      const payload =
        isRecord(entry) && "payload" in entry ? entry.payload : entry;
      if (!isMobileDisplayPayload(payload)) return null;
      const id =
        isRecord(entry) && typeof entry.id === "string"
          ? entry.id
          : artifactId(payload, conversationId, index);
      const artifactConversationId =
        isRecord(entry) && typeof entry.conversationId === "string"
          ? entry.conversationId
          : conversationId;
      return { id, conversationId: artifactConversationId, payload };
    })
    .filter((entry): entry is ChatArtifact => Boolean(entry));
};

export const artifactPrimaryFilePath = (
  payload: MobileDisplayPayload,
): string | null => {
  switch (payload.kind) {
    case "canvas-html":
    case "markdown":
    case "source-diff":
    case "file-artifact":
    case "pdf":
      return payload.filePath;
    case "office":
      return payload.previewRef.sourcePath;
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return payload.asset.filePaths[0] ?? null;
        case "video":
        case "audio":
        case "model3d":
        case "download":
          return payload.asset.filePath;
        case "text":
          return null;
      }
    case "url":
    case "agent-work":
      return null;
  }
};

export const artifactTitle = (payload: MobileDisplayPayload): string => {
  switch (payload.kind) {
    case "canvas-html":
      return payload.title ?? basenameOf(payload.filePath) ?? "Canvas";
    case "url":
      return payload.title;
    case "office":
      return payload.title ?? payload.previewRef.title;
    case "markdown":
    case "source-diff":
    case "file-artifact":
    case "pdf":
      return payload.title ?? basenameOf(payload.filePath);
    case "media":
      if (payload.prompt?.trim()) return payload.prompt.trim();
      switch (payload.asset.kind) {
        case "image":
          return payload.asset.filePaths.length > 1
            ? "Generated images"
            : basenameOf(payload.asset.filePaths[0] ?? "") || "Image";
        case "video":
          return basenameOf(payload.asset.filePath) || "Video";
        case "audio":
          return basenameOf(payload.asset.filePath) || "Audio";
        case "model3d":
          return (
            payload.asset.label ??
            basenameOf(payload.asset.filePath) ??
            "3D model"
          );
        case "download":
          return payload.asset.label;
        case "text":
          return "Generated text";
      }
    case "agent-work":
      return payload.title;
  }
};

export const artifactSubtitle = (payload: MobileDisplayPayload): string => {
  const withFormat = (category: string, filePath?: string | null) => {
    const ext = filePath ? extensionOf(filePath) : null;
    return ext ? `${category} · ${ext}` : category;
  };
  switch (payload.kind) {
    case "canvas-html":
      return "Canvas · HTML";
    case "url":
      return "Live preview";
    case "office":
      return withFormat("Document", payload.previewRef.sourcePath);
    case "markdown":
      return withFormat("Markdown", payload.filePath);
    case "source-diff":
      return withFormat("Code changes", payload.filePath);
    case "file-artifact":
      if (payload.artifactKind === "office-spreadsheet") {
        return withFormat("Spreadsheet", payload.filePath);
      }
      if (payload.artifactKind === "office-slides") {
        return withFormat("Slides", payload.filePath);
      }
      if (payload.artifactKind === "delimited-table") {
        return withFormat("Table", payload.filePath);
      }
      return withFormat("Document", payload.filePath);
    case "pdf":
      return withFormat("PDF", payload.filePath);
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return withFormat("Image", payload.asset.filePaths[0]);
        case "video":
          return withFormat("Video", payload.asset.filePath);
        case "audio":
          return withFormat("Audio", payload.asset.filePath);
        case "model3d":
          return withFormat("3D model", payload.asset.filePath);
        case "download":
          return withFormat("File", payload.asset.filePath);
        case "text":
          return "Text";
      }
    case "agent-work":
      return payload.subtitle;
  }
};

export const artifactIconName = (payload: MobileDisplayPayload) => {
  switch (payload.kind) {
    case "canvas-html":
    case "url":
      return "panel-top";
    case "markdown":
    case "office":
    case "file-artifact":
    case "pdf":
      return "file-text";
    case "source-diff":
      return "git-branch";
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return "image";
        case "video":
          return "video";
        case "audio":
          return "volume-2";
        case "model3d":
          return "box";
        default:
          return "file";
      }
    case "agent-work":
      return payload.state === "done" ? "check" : "cpu";
  }
};

export const agentWorkArtifactId = (agentIds: readonly string[]): string => {
  const key = agentIds
    .map((id) => id.trim())
    .filter(Boolean)
    .sort()
    .join(",");
  return key ? `agent-work:${key}` : "agent-work";
};

export const artifactId = (
  payload: MobileDisplayPayload,
  conversationId: string,
  index = 0,
) => {
  const filePath = artifactPrimaryFilePath(payload);
  if (filePath) return `${conversationId}:${payload.kind}:${filePath}`;
  if (payload.kind === "url") return `${conversationId}:url:${payload.tabId}`;
  if (payload.kind === "agent-work") {
    return `${conversationId}:agent-work:${payload.createdAt}:${payload.title}`;
  }
  return `${conversationId}:${payload.kind}:${index}`;
};
