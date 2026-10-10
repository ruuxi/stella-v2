import {
  cloudWorldDriveName,
  cloudWorldDrivePath,
  isCloudWorkspacePath,
} from "@stella/contracts/cloud-world-paths";
import {
  extractLocalFileLinkPaths,
  isAbsoluteLocalFilePath,
} from "@stella/contracts/local-file-links";
import { cloudFileArtifact } from "./cloud-file-payload";
import { artifactPrimaryFilePath } from "./mobile-artifacts";
import { displayPayloadForStellaFile } from "./stella-file-links";
import type { ChatArtifact, MobileDisplayPayload } from "../types";

/**
 * Every file Stella put in front of the user in one conversation, read from
 * that conversation's cloud journal: files linked in Stella's replies and in
 * the reports agents finished with, `files` cards, files the display tools
 * (`html`, `image_gen`) produced, and the attachments sent with the user's
 * own messages. These are the same records the desktop grants a paired
 * phone's file reads from (`cloud-conversation-file-grants.ts`).
 *
 * The journal names where each one lives. A drive path is in the cloud; an
 * absolute path is on the computer whose turn wrote the record, which the
 * turn id carries (`desktop:<deviceId>:…`).
 */

export type ConversationFileSource =
  | { kind: "cloud" }
  | { kind: "computer"; deviceId: string | null }
  | { kind: "upload" };

export type ConversationFile = {
  key: string;
  artifact: ChatArtifact;
  createdAt: number;
  source: ConversationFileSource;
};

export type JournalEntry = {
  seq: number;
  turnId: string;
  kind: string;
  role: string | null;
  createdAt: number;
  body: Record<string, unknown> | null;
};

type FoundFile = {
  path: string;
  name?: string;
  upload?: boolean;
};

const DISPLAY_TOOLS = new Set(["html", "image_gen"]);

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseJson = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const messageTexts = (payload: Record<string, unknown>): string[] => {
  const content = payload.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block?.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts;
};

const linksIn = (text: unknown): FoundFile[] =>
  typeof text === "string"
    ? extractLocalFileLinkPaths(text).map((path) => ({ path }))
    : [];

const uploadsIn = (payload: Record<string, unknown>): FoundFile[] => {
  const found: FoundFile[] = [];
  if (Array.isArray(payload.attachments)) {
    for (const entry of payload.attachments) {
      const attachment = asRecord(entry);
      const drivePath = attachment?.drivePath;
      if (typeof drivePath !== "string" || !drivePath.trim()) continue;
      found.push({
        path: drivePath,
        upload: true,
        ...(typeof attachment?.name === "string" ? { name: attachment.name } : {}),
      });
    }
  }
  const context = asRecord(payload.providerContext)?.attachments;
  if (Array.isArray(context)) {
    for (const entry of context) {
      if (typeof entry === "string" && entry.trim()) {
        found.push({ path: entry, upload: true });
      }
    }
  }
  return found;
};

const entryFiles = (entry: JournalEntry): FoundFile[] => {
  const body = entry.body;
  if (!body) return [];
  if (entry.kind === "message") {
    const role = entry.role ?? (typeof body.role === "string" ? body.role : null);
    if (role === "assistant") return messageTexts(body).flatMap(linksIn);
    if (role === "user") {
      const reports =
        body.source === "agent-thread" ? messageTexts(body).flatMap(linksIn) : [];
      return [...reports, ...uploadsIn(body)];
    }
    if (
      role === "toolResult" &&
      typeof body.toolName === "string" &&
      DISPLAY_TOOLS.has(body.toolName) &&
      body.isError !== true
    ) {
      const details = asRecord(body.details);
      const found: FoundFile[] = [];
      if (typeof details?.filePath === "string") {
        found.push({ path: details.filePath });
      }
      if (Array.isArray(details?.drivePaths)) {
        for (const drivePath of details.drivePaths) {
          if (typeof drivePath === "string" && drivePath.trim()) {
            found.push({ path: drivePath });
          }
        }
      }
      return found;
    }
    return [];
  }
  if (entry.kind === "card") {
    if (body.type === "files" && Array.isArray(body.files)) {
      return body.files.flatMap((value) => {
        const file = asRecord(value);
        return typeof file?.path === "string" && file.path.trim()
          ? [
              {
                path: file.path,
                ...(typeof file.name === "string" ? { name: file.name } : {}),
              },
            ]
          : [];
      });
    }
    if (body.type === "agent-lifecycle") {
      const event = asRecord(body.event);
      if (event?.type === "agent-completed") {
        return linksIn(asRecord(event.payload)?.result);
      }
    }
  }
  return [];
};

const desktopDeviceOfTurn = (turnId: string): string | null => {
  const match = /^desktop:([^:]+):/.exec(turnId);
  return match?.[1] ?? null;
};

const extensionOf = (path: string): string => {
  const name = path.split(/[?#]/)[0] ?? path;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);

/** A drive file as the viewer opens it: real media for media, else the files-card shape. */
const driveArtifact = (
  drivePath: string,
  name: string,
  conversationId: string,
  createdAt: number,
): ChatArtifact => {
  const ext = extensionOf(drivePath);
  const media: MobileDisplayPayload | null = IMAGE_EXTS.has(ext)
    ? {
        kind: "media",
        asset: { kind: "image", filePaths: [drivePath] },
        createdAt,
        driveBacked: true,
      }
    : VIDEO_EXTS.has(ext)
      ? {
          kind: "media",
          asset: { kind: "video", filePath: drivePath },
          createdAt,
          driveBacked: true,
        }
      : AUDIO_EXTS.has(ext)
        ? {
            kind: "media",
            asset: { kind: "audio", filePath: drivePath },
            createdAt,
            driveBacked: true,
          }
        : null;
  if (media) {
    return {
      id: `${conversationId}:drive:${drivePath}`,
      conversationId,
      payload: media,
    };
  }
  return cloudFileArtifact(
    { path: drivePath, name, sizeBytes: 0, contentType: "application/octet-stream" },
    conversationId,
    createdAt,
  );
};

const localArtifact = (
  filePath: string,
  conversationId: string,
  createdAt: number,
): ChatArtifact => {
  const payload = displayPayloadForStellaFile(filePath, createdAt);
  return {
    id: `${conversationId}:${payload.kind}:${filePath}`,
    conversationId,
    payload,
  };
};

const toConversationFile = (
  found: FoundFile,
  entry: JournalEntry,
  conversationId: string,
): ConversationFile | null => {
  const raw = found.path.trim();
  if (!raw) return null;
  const absolute = isAbsoluteLocalFilePath(raw);
  const drivePath = absolute ? cloudWorldDrivePath(raw) : raw.replace(/^\/+/, "");
  if (drivePath) {
    const name = found.name?.trim() || cloudWorldDriveName(drivePath);
    return {
      key: `drive:${drivePath}`,
      artifact: driveArtifact(drivePath, name, conversationId, entry.createdAt),
      createdAt: entry.createdAt,
      source: found.upload ? { kind: "upload" } : { kind: "cloud" },
    };
  }
  if (!absolute) return null;
  return {
    key: `path:${raw}`,
    artifact: localArtifact(raw, conversationId, entry.createdAt),
    createdAt: entry.createdAt,
    source: isCloudWorkspacePath(raw)
      ? { kind: "cloud" }
      : { kind: "computer", deviceId: desktopDeviceOfTurn(entry.turnId) },
  };
};

/** Files in `entries`, newest first, first sighting of each file winning. */
export const conversationFilesFromEntries = (
  entries: readonly JournalEntry[],
  conversationId: string,
): ConversationFile[] => {
  const ordered = [...entries].sort((a, b) => b.seq - a.seq);
  const seen = new Set<string>();
  const out: ConversationFile[] = [];
  for (const entry of ordered) {
    for (const found of entryFiles(entry)) {
      const file = toConversationFile(found, entry, conversationId);
      if (!file || seen.has(file.key)) continue;
      seen.add(file.key);
      out.push(file);
    }
  }
  return out;
};

/** The dedupe key of an artifact the chat already holds, matching the journal's. */
export const artifactFileKey = (artifact: ChatArtifact): string => {
  const filePath = artifactPrimaryFilePath(artifact.payload);
  if (!filePath) return `id:${artifact.id}`;
  const driveBacked =
    "driveBacked" in artifact.payload && artifact.payload.driveBacked === true;
  if (driveBacked) return `drive:${filePath.replace(/^\/+/, "")}`;
  const drivePath = cloudWorldDrivePath(filePath);
  return drivePath ? `drive:${drivePath}` : `path:${filePath}`;
};

/** Where a file the chat holds lives, judged from its path alone. */
export const artifactFileSource = (
  artifact: ChatArtifact,
): ConversationFileSource => {
  const key = artifactFileKey(artifact);
  if (key.startsWith("drive:") || key.startsWith("id:")) return { kind: "cloud" };
  const filePath = key.slice("path:".length);
  return isCloudWorkspacePath(filePath)
    ? { kind: "cloud" }
    : { kind: "computer", deviceId: null };
};

export const entryFromRow = (row: unknown): JournalEntry | null => {
  const value = asRecord(row);
  if (!value || typeof value.seq !== "number") return null;
  return {
    seq: value.seq,
    turnId: typeof value.turn_id === "string" ? value.turn_id : "",
    kind: typeof value.kind === "string" ? value.kind : "",
    role: typeof value.role === "string" ? value.role : null,
    createdAt: typeof value.created_at === "number" ? value.created_at : 0,
    body: parseJson(value.payload_json),
  };
};

export const entryFromRecord = (record: unknown): JournalEntry | null => {
  const value = asRecord(record);
  if (!value || typeof value.seq !== "number") return null;
  const kind = typeof value.kind === "string" ? value.kind : "";
  return {
    seq: value.seq,
    turnId: typeof value.turnId === "string" ? value.turnId : "",
    kind,
    role: typeof value.role === "string" ? value.role : null,
    createdAt: typeof value.createdAtMs === "number" ? value.createdAtMs : 0,
    body: kind === "card" ? asRecord(value.card) : parseJson(value.payload),
  };
};
