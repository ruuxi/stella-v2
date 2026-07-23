export class RequestBodyLimitError extends Error {
  readonly status: 400 | 413;

  constructor(status: 400 | 413, message: string) {
    super(message);
    this.name = "RequestBodyLimitError";
    this.status = status;
  }
}

export const readRequestTextBounded = async (
  request: Request,
  maxBytes: number,
): Promise<string> => {
  const declaredRaw = request.headers.get("content-length");
  if (declaredRaw !== null) {
    if (!/^\d+$/.test(declaredRaw.trim())) {
      throw new RequestBodyLimitError(400, "Invalid Content-Length header.");
    }
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw new RequestBodyLimitError(
        413,
        `Request body exceeds the ${maxBytes} byte limit.`,
      );
    }
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader
          .cancel("request body byte limit exceeded")
          .catch(() => undefined);
        throw new RequestBodyLimitError(
          413,
          `Request body exceeds the ${maxBytes} byte limit.`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof RequestBodyLimitError) throw error;
    throw new RequestBodyLimitError(
      400,
      "Request body upload was interrupted.",
    );
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyLimitError(400, "Request body must be valid UTF-8.");
  }
};
