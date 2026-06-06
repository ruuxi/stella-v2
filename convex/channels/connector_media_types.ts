import { v } from "convex/values";

export const CONNECTOR_MEDIA_KINDS = [
  "image",
  "video",
  "audio",
  "file",
] as const;

export type ConnectorMediaKind = (typeof CONNECTOR_MEDIA_KINDS)[number];

const connectorMediaKindValidator = v.union(
  v.literal("image"),
  v.literal("video"),
  v.literal("audio"),
  v.literal("file"),
);

export const connectorMediaRefValidator = v.object({
  id: v.string(),
  kind: connectorMediaKindValidator,
  url: v.string(),
  expiresAt: v.number(),
  r2Key: v.optional(v.string()),
  mimeType: v.optional(v.string()),
  name: v.optional(v.string()),
  size: v.optional(v.number()),
  transcript: v.optional(v.string()),
  extractedText: v.optional(v.string()),
});

export type ConnectorMediaRef = {
  id: string;
  kind: ConnectorMediaKind;
  url: string;
  expiresAt: number;
  r2Key?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  transcript?: string;
  extractedText?: string;
};

export const connectorMediaRefArrayValidator = v.array(connectorMediaRefValidator);

export const connectorDeliveryMediaInputValidator = v.object({
  kind: connectorMediaKindValidator,
  url: v.string(),
  mimeType: v.optional(v.string()),
  name: v.optional(v.string()),
  size: v.optional(v.number()),
});

export type ConnectorDeliveryMediaInput = {
  kind: ConnectorMediaKind;
  url: string;
  mimeType?: string;
  name?: string;
  size?: number;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

export const extractDeliveryMediaFromOutput = (
  output: unknown,
): ConnectorDeliveryMediaInput[] => {
  if (!output || typeof output !== "object") return [];
  const record = output as Record<string, unknown>;
  const media: ConnectorDeliveryMediaInput[] = [];

  const images = Array.isArray(record.images) ? record.images : [];
  for (const image of images) {
    const item = asRecord(image);
    const url = asString(item.url);
    if (url) {
      media.push({
        kind: "image",
        url,
        mimeType: asString(item.content_type) ?? asString(item.mimeType),
      });
    }
  }

  const video = asRecord(record.video);
  const videoUrl = asString(video.url);
  if (videoUrl) {
    media.push({
      kind: "video",
      url: videoUrl,
      mimeType: asString(video.content_type) ?? asString(video.mimeType),
    });
  }

  for (const key of ["audio_file", "audio"]) {
    const audio = asRecord(record[key]);
    const audioUrl = asString(audio.url);
    if (audioUrl) {
      media.push({
        kind: "audio",
        url: audioUrl,
        mimeType: asString(audio.content_type) ?? asString(audio.mimeType),
      });
      break;
    }
  }

  return media;
};
