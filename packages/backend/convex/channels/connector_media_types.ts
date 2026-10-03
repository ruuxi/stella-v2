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
