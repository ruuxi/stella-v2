import { parsePreview, type PreviewRequest } from "./preview-parser";

type PreviewWorkerMessage =
  | { id: number; request: PreviewRequest }
  | { id: number; cancel: true };

const cancelled = new Set<number>();

self.onmessage = (event: MessageEvent<PreviewWorkerMessage>) => {
  const message = event.data;
  if ("cancel" in message) {
    // Requests still queued behind a long parse are skipped entirely.
    cancelled.add(message.id);
    return;
  }
  const { id, request } = message;
  if (cancelled.delete(id)) return;
  try {
    self.postMessage({ id, result: parsePreview(request) });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
