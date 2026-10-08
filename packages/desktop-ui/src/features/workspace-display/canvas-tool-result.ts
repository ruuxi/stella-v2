/**
 * The canvas an `html` tool result describes.
 *
 * Two surfaces need the same reading of those details: the live stream, which
 * opens a canvas the moment the orchestrator writes it, and the chat row,
 * which keeps the card that reopens it later. Both go through here so a canvas
 * is identified by exactly one rule.
 */

import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";

export type CanvasHtmlPayload = Extract<
  DisplayPayload,
  { kind: "canvas-html" }
>;

const trimmed = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const canvasHtmlPayloadFromToolDetails = (
  details: unknown,
  fallbackCreatedAt: number,
): CanvasHtmlPayload | null => {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const record = details as Record<string, unknown>;
  const filePath = trimmed(record.filePath);
  if (!filePath) return null;
  const title = trimmed(record.title);
  const slug = trimmed(record.slug);
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : fallbackCreatedAt;
  return {
    kind: "canvas-html",
    filePath,
    createdAt,
    ...(title ? { title } : {}),
    ...(slug ? { slug } : {}),
    ...(record.driveBacked === true ? { driveBacked: true } : {}),
  };
};
