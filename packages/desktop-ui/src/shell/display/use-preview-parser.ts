import { useEffect, useState } from "react";
import type { PreviewRequest, PreviewResult } from "./preview-parser";

export function usePreviewParser(request: PreviewRequest | null) {
  const [state, setState] = useState<{
    request: PreviewRequest;
    result?: PreviewResult;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!request) return;
    let worker: Worker | undefined;
    try {
      worker = new Worker(
        new URL("./preview-parser.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (
        event: MessageEvent<{ result?: PreviewResult; error?: string }>,
      ) => {
        setState({ request, ...event.data });
        worker?.terminate();
      };
      worker.onerror = () => {
        setState({ request, error: "Unable to prepare this preview." });
        worker?.terminate();
      };
      // The read cache owns these bytes; do not detach its buffer.
      worker.postMessage(request);
    } catch (error) {
      setState({
        request,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return () => worker?.terminate();
  }, [request]);
  return state?.request === request ? state : null;
}
