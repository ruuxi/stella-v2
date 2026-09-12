import { useEffect, useState } from "react";
import { useT } from "@/shared/i18n";
import type { PreviewRequest, PreviewResult } from "./preview-parser";

/** Sentinel the worker crash path reports; the hook translates it. */
export const PREVIEW_UNAVAILABLE = "shell.display.preview.unavailable";

/** How long the shared worker stays warm with no outstanding requests. */
export const PREVIEW_WORKER_IDLE_MS = 30_000;

type PreviewResponse = { result?: PreviewResult; error?: string };
type PreviewWorkerResponse = PreviewResponse & { id: number };

// One worker is shared by every preview request: booting a module worker per
// tab switch costs more than the parse itself.
let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, (response: PreviewResponse) => void>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function clearIdleTimer() {
  if (idleTimer === null) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function terminateWorker() {
  const current = worker;
  worker = null;
  clearIdleTimer();
  current?.terminate();
}

function scheduleIdleTermination() {
  clearIdleTimer();
  if (pending.size > 0 || !worker) return;
  idleTimer = setTimeout(terminateWorker, PREVIEW_WORKER_IDLE_MS);
  // Never keep a Node/test process alive just for the idle sweep.
  (idleTimer as { unref?: () => void }).unref?.();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(
    new URL("./preview-parser.worker.ts", import.meta.url),
    { type: "module" },
  );
  created.onmessage = (event: MessageEvent<PreviewWorkerResponse>) => {
    const { id, ...response } = event.data ?? ({} as PreviewWorkerResponse);
    const resolve = pending.get(id);
    // Responses for cancelled requests are dropped here.
    if (resolve) {
      pending.delete(id);
      resolve(response);
    }
    scheduleIdleTermination();
  };
  created.onerror = () => {
    // A crashed worker cannot be reused; drop it so the next request reboots.
    if (worker === created) terminateWorker();
    else created.terminate();
    const waiting = [...pending.values()];
    pending.clear();
    for (const resolve of waiting) resolve({ error: PREVIEW_UNAVAILABLE });
  };
  worker = created;
  return created;
}

/** Posts one request and returns a cancel handle for stale/unmounted callers. */
function requestPreview(
  request: PreviewRequest,
  resolve: (response: PreviewResponse) => void,
): () => void {
  const id = nextRequestId++;
  const target = ensureWorker();
  clearIdleTimer();
  pending.set(id, resolve);
  // The read cache owns these bytes; do not detach its buffer.
  target.postMessage({ id, request });
  return () => {
    if (!pending.delete(id)) return;
    try {
      target.postMessage({ id, cancel: true });
    } catch {
      // A terminated worker needs no cancellation.
    }
    scheduleIdleTermination();
  };
}

export function usePreviewParser(request: PreviewRequest | null) {
  const t = useT();
  const [state, setState] = useState<{
    request: PreviewRequest;
    result?: PreviewResult;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!request) return;
    let active = true;
    let cancel: (() => void) | undefined;
    try {
      cancel = requestPreview(request, (response) => {
        if (!active) return;
        setState({
          request,
          ...response,
          ...(response.error === PREVIEW_UNAVAILABLE
            ? { error: t(PREVIEW_UNAVAILABLE) }
            : {}),
        });
      });
    } catch (error) {
      setState({
        request,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return () => {
      active = false;
      cancel?.();
    };
  }, [request, t]);
  return state?.request === request ? state : null;
}

export const __testing = {
  reset() {
    pending.clear();
    terminateWorker();
    nextRequestId = 1;
  },
  get worker() {
    return worker;
  },
  requestPreview,
};
