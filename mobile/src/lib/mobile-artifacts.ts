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

const formatBytes = (bytes: number | undefined): string | null => {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
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
      return typeof value.filePath === "string";
    case "pdf":
      return (
        typeof value.filePath === "string" &&
        (value.localUri === undefined || typeof value.localUri === "string") &&
        (value.sizeBytes === undefined || isFiniteNumber(value.sizeBytes))
      );
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
        isFiniteNumber(value.createdAt) &&
        // Per-agent file sections are optional (older desktops omit them)
        // but must be structurally sound when present.
        (value.agents === undefined ||
          (Array.isArray(value.agents) &&
            value.agents.every(
              (section) =>
                isRecord(section) &&
                isString(section.agentId) &&
                typeof section.title === "string" &&
                Array.isArray(section.files) &&
                section.files.every(isMobileDisplayPayload),
            )))
      );
    case "map-route": {
      if (!Array.isArray(value.markers) || value.markers.length === 0) {
        return false;
      }
      const markersOk = value.markers.every(
        (marker) =>
          isRecord(marker) &&
          isString(marker.id) &&
          isString(marker.name) &&
          isFiniteNumber(marker.lat) &&
          isFiniteNumber(marker.lng),
      );
      if (!markersOk) return false;
      if (value.route === undefined) return true;
      return (
        isRecord(value.route) &&
        isString(value.route.polyline) &&
        isFiniteNumber(value.route.distanceMeters) &&
        isFiniteNumber(value.route.durationSeconds)
      );
    }
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
    case "map-route":
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
    case "map-route": {
      if (payload.title) return payload.title;
      if (payload.route) {
        const origin = payload.markers.find(
          (marker) => marker.id === payload.route?.originId,
        );
        const destination = payload.markers.find(
          (marker) => marker.id === payload.route?.destinationId,
        );
        if (origin && destination) {
          return `${origin.name} → ${destination.name}`;
        }
      }
      return payload.markers.length === 1
        ? (payload.markers[0]?.name ?? "Map")
        : `${payload.markers.length} places`;
    }
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
    case "pdf": {
      const base = withFormat("PDF", payload.filePath);
      const size = formatBytes(payload.sizeBytes);
      return size ? `${base} · ${size}` : base;
    }
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
    case "map-route":
      if (payload.route) {
        const km = payload.route.distanceMeters / 1000;
        const minutes = Math.max(
          1,
          Math.round(payload.route.durationSeconds / 60),
        );
        const duration =
          minutes < 60
            ? `${minutes} min`
            : `${Math.floor(minutes / 60)} hr${minutes % 60 > 0 ? ` ${minutes % 60} min` : ""}`;
        return `Route · ${km >= 100 ? Math.round(km) : km.toFixed(1)} km · ${duration}`;
      }
      return payload.markers.length === 1 ? "Map · 1 place" : `Map · ${payload.markers.length} places`;
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
    case "map-route":
      return "globe";
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
