import { GATEWAY_REQUEST_ID_HEADER } from "@stella/contracts/gateway/api";

/** Private RPC surface; identity is derived from the signed capability there. */
export type ManagedRequestControl = {
  cancelManagedRequest(args: { capability: string; requestId: string }): Promise<{ canceled: boolean }>;
};

/** DO fetch hops do not reliably carry AbortSignal to the provider executor. */
export const fetchWithManagedCancellation = async (args: {
  request: Request;
  capability: string;
  control: ManagedRequestControl;
  fetch(request: Request): Promise<Response>;
  waitUntil(work: Promise<unknown>): void;
}): Promise<Response> => {
  const { request } = args;
  request.signal.throwIfAborted();
  const requestId = request.headers.get(GATEWAY_REQUEST_ID_HEADER)?.trim();
  if (!requestId) throw new Error("Managed model request identity is missing.");
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => undefined);
  let cancelWork: Promise<unknown> | undefined;
  let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyFinished = false;
  const cancel = (): void => {
    if (request.signal.aborted) rejectAbort?.(request.signal.reason);
    if (request.signal.aborted && !bodyFinished) {
      bodyFinished = true;
      responseController?.error(request.signal.reason);
      void responseReader?.cancel(request.signal.reason).catch(() => undefined);
    }
    cancelWork ??= (async () => {
      // Cancel is idempotent. Retrying a lost cancel response never retries
      // model execution or changes the request identity.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await args.control.cancelManagedRequest({ capability: args.capability, requestId });
          return;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    })();
    args.waitUntil(cancelWork);
  };
  const cleanup = (): void => request.signal.removeEventListener("abort", cancel);
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const responseWork = Promise.resolve().then(() => {
    request.signal.throwIfAborted();
    return args.fetch(request);
  });
  void responseWork.catch(() => undefined);
  try {
    const response = await Promise.race([responseWork, aborted]);
    if (request.signal.aborted) {
      void response.body?.cancel(request.signal.reason).catch(() => undefined);
      request.signal.throwIfAborted();
    }
    if (!response.body) {
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    responseReader = reader;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { responseController = controller; },
      async pull(controller) {
        try {
          request.signal.throwIfAborted();
          const chunk = await reader.read();
          if (bodyFinished) return;
          if (chunk.done) { bodyFinished = true; cleanup(); controller.close(); }
          else controller.enqueue(chunk.value);
        } catch (error) {
          if (bodyFinished) return;
          bodyFinished = true;
          cleanup();
          void reader.cancel(error).catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        bodyFinished = true;
        cancel();
        cleanup();
        await reader.cancel(reason);
      },
    }, { highWaterMark: 0 }), response);
  } catch (error) {
    cleanup();
    void responseWork.then(response => response.body?.cancel(error)).catch(() => undefined);
    throw error;
  }
};
