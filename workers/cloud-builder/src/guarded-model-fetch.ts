/**
 * Start gateway routing while the final privacy check runs, but release no
 * request body bytes until that check succeeds. Each physical model request
 * gets a new check; neither permission nor its result is cached here.
 */
export const guardedModelFetch = async (args: {
  request: Request;
  authorize: () => Promise<void>;
  fetch: (request: Request) => Promise<Response>;
  mode?: "gate-body" | "authorize-before-fetch";
}): Promise<Response> => {
  const { request, authorize } = args;
  request.signal.throwIfAborted();
  if (args.mode === "authorize-before-fetch" || !request.body) {
    await authorize();
    request.signal.throwIfAborted();
    return await args.fetch(request);
  }

  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const reader = request.body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyFinished = false;
  const cancelSource = (reason?: unknown): void => {
    void reader.cancel(reason).catch(() => undefined);
  };
  const failBody = (reason: unknown): void => {
    if (bodyFinished) return;
    bodyFinished = true;
    controller?.error(reason);
    cancelSource(reason);
  };
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<void>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const onAbort = (): void => {
    failBody(signal.reason);
    rejectAbort?.(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  // Attach rejection handling before transport starts. A refused policy must
  // surface its original error even when the aborted fetch also rejects.
  const authorization = Promise.resolve().then(authorize);
  void authorization.catch(() => undefined);
  const body = new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
      },
      async pull(value) {
        try {
          await authorization;
          signal.throwIfAborted();
          if (bodyFinished) return;
          const chunk = await reader.read();
          if (bodyFinished) return;
          if (chunk.done) {
            bodyFinished = true;
            value.close();
          } else {
            value.enqueue(chunk.value);
          }
        } catch (error) {
          failBody(error);
        }
      },
      cancel(reason) {
        bodyFinished = true;
        cancelSource(reason);
      },
    },
    { highWaterMark: 0 },
  );

  const responseWork = Promise.resolve().then(() =>
    args.fetch(new Request(request, { body, signal })),
  );
  void responseWork.catch(() => undefined);
  try {
    await Promise.race([authorization, aborted]);
    signal.throwIfAborted();
    const response = await responseWork;
    // A gateway refusal can finish without consuming its request. Close that
    // source without aborting the response, whose status/body belong to the
    // caller. Successful gateway handlers consume the complete JSON body.
    if (!bodyFinished) {
      bodyFinished = true;
      controller?.close();
      cancelSource();
    }
    return response;
  } catch (error) {
    abort.abort(error);
    failBody(error);
    void responseWork
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
