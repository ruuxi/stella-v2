import { parsePreview, type PreviewRequest } from "./preview-parser";
self.onmessage = (event: MessageEvent<PreviewRequest>) => {
  try {
    self.postMessage({ result: parsePreview(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
