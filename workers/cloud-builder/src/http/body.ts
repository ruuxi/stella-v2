import { BoundedBodyError, readBoundedRequestBytes, readBoundedRequestText } from "../bounded-body.js";

/** A request body, or why it was refused: 413 past the limit, 400 otherwise. */
export type BodyResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; error: string };

type Refused = Extract<BodyResult<never>, { ok: false }>;

const INVALID_JSON: Refused = { ok: false, status: 400, error: "Request body must be JSON." };

const refused = (error: unknown): Refused => {
  if (!(error instanceof BoundedBodyError)) throw error;
  switch (error.reason) {
    case "too_large":
      return { ok: false, status: 413, error: "Request body is too large." };
    case "invalid_content_length":
      return { ok: false, status: 400, error: "Content-Length is invalid." };
    case "invalid_utf8":
      return { ok: false, status: 400, error: "Request body must be UTF-8." };
    case "missing_body":
    case "invalid_json":
      return INVALID_JSON;
  }
};

/** The raw body, streamed and cut off at `maxBytes` whatever Content-Length says. */
export const readBodyBytes = async (request: Request, maxBytes: number): Promise<BodyResult<Uint8Array>> => {
  try {
    return { ok: true, value: await readBoundedRequestBytes(request, maxBytes) };
  } catch (error) {
    return refused(error);
  }
};

/** The body as UTF-8 text, bounded like `readBodyBytes`. */
export const readBodyText = async (request: Request, maxBytes: number): Promise<BodyResult<string>> => {
  try {
    return { ok: true, value: await readBoundedRequestText(request, maxBytes) };
  } catch (error) {
    return refused(error);
  }
};

/** The body parsed as JSON, bounded like `readBodyBytes`. An empty body is invalid. */
export const readJsonBody = async (request: Request, maxBytes: number): Promise<BodyResult<unknown>> => {
  const text = await readBodyText(request, maxBytes);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) as unknown };
  } catch {
    return INVALID_JSON;
  }
};

/** The body as a JSON object, bounded like `readBodyBytes`. With `allowEmpty`, no body is `{}`. */
export const readJsonObject = async (
  request: Request,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<BodyResult<Record<string, unknown>>> => {
  const text = await readBodyText(request, maxBytes);
  if (!text.ok) return text;
  if (!text.value && options.allowEmpty) return { ok: true, value: {} };
  let body: unknown;
  try {
    body = JSON.parse(text.value) as unknown;
  } catch {
    return INVALID_JSON;
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? { ok: true, value: body as Record<string, unknown> }
    : { ok: false, status: 400, error: "Request body must be a JSON object." };
};
