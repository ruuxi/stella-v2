import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  isFileChangeRecordArray,
  isProducedFileRecordArray,
  MAX_PRODUCED_FILES_PER_COMMAND,
  type FileChangeRecord,
} from "@stella/contracts/file-changes";
import {
  isDisplayTabPayload,
  type DisplayTabPayload,
} from "@stella/contracts/desktop/display-payload";
import { buildPayloadFromBarePath } from "@/features/chat/lib/derive-turn-resource";
import { isNoiseProducedPath } from "@/features/workspace-display/path-to-viewer";

export type ConversationFileEntry = {
  path: string;
  timestamp: number;
  payload: DisplayTabPayload;
};

const resolvedPathForChange = (record: FileChangeRecord): string | null => {
  if (record.kind.type === "delete") return null;
  const path =
    record.kind.type === "update" && record.kind.move_path
      ? record.kind.move_path
      : record.path;
  if (!path || !path.startsWith("/")) return null;
  return path;
};

export function deriveConversationFiles(
  events: ReadonlyArray<EventRecord>,
  options?: { cap?: number },
): ConversationFileEntry[] {
  const seen = new Map<string, ConversationFileEntry>();

  for (const event of events) {
    const payload = event.payload as
      | {
          toolName?: unknown;
          error?: unknown;
          filePath?: unknown;
          slug?: unknown;
          title?: unknown;
          createdAt?: unknown;
          fileChanges?: unknown;
          producedFiles?: unknown;
        }
      | undefined;
    if (!payload || typeof payload !== "object") continue;

    if (
      payload.toolName === "html" &&
      !payload.error &&
      typeof payload.filePath === "string" &&
      payload.filePath.startsWith("/")
    ) {
      seen.set(payload.filePath, {
        path: payload.filePath,
        timestamp: event.timestamp,
        payload: {
          kind: "canvas-html",
          filePath: payload.filePath,
          ...(typeof payload.title === "string" ? { title: payload.title } : {}),
          ...(typeof payload.slug === "string" ? { slug: payload.slug } : {}),
          createdAt:
            typeof payload.createdAt === "number" &&
            Number.isFinite(payload.createdAt)
              ? payload.createdAt
              : event.timestamp,
        },
      });
      continue;
    }

    const fileChanges = isFileChangeRecordArray(payload.fileChanges)
      ? payload.fileChanges
      : [];

    const producedDenoised = (
      isProducedFileRecordArray(payload.producedFiles)
        ? payload.producedFiles
        : []
    ).filter((record) => {
      const path = resolvedPathForChange(record);
      return path === null || !isNoiseProducedPath(path);
    });
    const produced =
      event.type === "tool_result" &&
      producedDenoised.length > MAX_PRODUCED_FILES_PER_COMMAND
        ? []
        : producedDenoised;

    for (const record of [...fileChanges, ...produced]) {

      if (record.kind.type === "delete") {
        seen.delete(record.path);
        continue;
      }
      if (record.kind.type === "update" && record.kind.move_path) {
        seen.delete(record.path);
      }
      const path = resolvedPathForChange(record);
      if (!path) continue;
      const filePayload = buildPayloadFromBarePath(path, event.timestamp, {
        produced: true,
      });
      if (!filePayload || !isDisplayTabPayload(filePayload)) continue;

      seen.set(path, {
        path,
        timestamp: event.timestamp,
        payload: filePayload,
      });
    }
  }

  const all = Array.from(seen.values()).sort(
    (a, b) => b.timestamp - a.timestamp,
  );
  if (options?.cap !== undefined) {
    return all.slice(0, options.cap);
  }
  return all;
}
