/**
 * fal's queue API and webhooks. A port of the Convex `media_fal_webhooks.ts`
 * plus the webhook routing token: fal calls back to
 * `/api/media/v1/webhooks/fal?o=<owner>&j=<job>&e=<exp>&sig=<hmac>`, and the
 * HMAC (`MEDIA_SIGNING_SECRET`) over owner, job and expiry is what lets the
 * route address the owner's object without an index. fal's own ED25519
 * signature proves the body came from fal.
 */

const QUEUE_BASE = "https://queue.fal.run";
const JWKS_URL = "https://rest.alpha.fal.ai/.well-known/jwks.json";
const MAX_SKEW_SECONDS = 300;
const TIMEOUT_MS = 30_000;
export const FAL_WEBHOOK_PATH = "/api/media/v1/webhooks/fal";
/** fal runs a request for up to an hour and retries its webhook for two. */
const WEBHOOK_TOKEN_TTL_MS = 4 * 60 * 60_000;

export class FalError extends Error {
  /** fal refused the request outright; nothing will run or bill. */
  readonly definitive: boolean;
  readonly code?: string;
  constructor(message: string, definitive: boolean, code?: string) {
    super(message);
    this.name = "FalError";
    this.definitive = definitive;
    if (code) this.code = code;
  }
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const hmacHex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

const tokenMessage = (ownerId: string, jobId: string, exp: number) => `fal:${ownerId}:${jobId}:${exp}`;

/** The URL fal calls when `jobId` settles. */
export const falWebhookUrl = async (args: {
  baseUrl: string;
  secret: string;
  ownerId: string;
  jobId: string;
  now: number;
}): Promise<string> => {
  const exp = args.now + WEBHOOK_TOKEN_TTL_MS;
  const url = new URL(FAL_WEBHOOK_PATH, args.baseUrl);
  url.searchParams.set("o", args.ownerId);
  url.searchParams.set("j", args.jobId);
  url.searchParams.set("e", String(exp));
  url.searchParams.set("sig", await hmacHex(args.secret, tokenMessage(args.ownerId, args.jobId, exp)));
  return url.toString();
};

/** The owner and job a webhook URL addresses, or null when its token is bad or stale. */
export const verifyFalWebhookToken = async (
  url: URL,
  secret: string,
  now: number,
): Promise<{ ownerId: string; jobId: string } | null> => {
  const ownerId = url.searchParams.get("o") ?? "";
  const jobId = url.searchParams.get("j") ?? "";
  const exp = Number(url.searchParams.get("e"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!ownerId || !jobId || !Number.isSafeInteger(exp) || exp < now || !sig) return null;
  return constantTimeEqual(await hmacHex(secret, tokenMessage(ownerId, jobId, exp)), sig) ? { ownerId, jobId } : null;
};

let webhookKeys: { expiresAt: number; keys: CryptoKey[] } | null = null;

const base64UrlBytes = (value: string): Uint8Array => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const loadWebhookKeys = async (now: number): Promise<CryptoKey[]> => {
  if (webhookKeys && webhookKeys.expiresAt > now) return webhookKeys.keys;
  const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`fal webhook JWKS returned ${response.status}.`);
  const body = (await response.json()) as { keys?: Array<{ x?: unknown }> };
  const keys = await Promise.all(
    (body.keys ?? [])
      .map((key) => (typeof key.x === "string" ? key.x : ""))
      .filter(Boolean)
      .map((x) => crypto.subtle.importKey("raw", base64UrlBytes(x), { name: "Ed25519" }, false, ["verify"])),
  );
  if (keys.length === 0) throw new Error("fal webhook JWKS has no usable keys.");
  webhookKeys = { expiresAt: now + 24 * 60 * 60_000, keys };
  return keys;
};

/** fal's ED25519 signature over request id, user id, timestamp and the body hash. */
export const verifyFalSignature = async (headers: Headers, rawBody: string, now: number): Promise<boolean> => {
  const requestId = headers.get("x-fal-webhook-request-id")?.trim();
  const userId = headers.get("x-fal-webhook-user-id")?.trim();
  const timestamp = headers.get("x-fal-webhook-timestamp")?.trim();
  const signature = headers.get("x-fal-webhook-signature")?.trim();
  if (!requestId || !userId || !timestamp || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > MAX_SKEW_SECONDS) return false;
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(rawBody)));
  const message = encoder.encode(`${requestId}\n${userId}\n${timestamp}\n${bodyHash}`);
  const signatureBytes = Uint8Array.from(signature.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  for (const key of await loadWebhookKeys(now)) {
    try {
      if (await crypto.subtle.verify("Ed25519", key, signatureBytes, message)) return true;
    } catch {
      // Try the next key.
    }
  }
  return false;
};

const headers = (apiKey: string) => ({
  authorization: `Key ${apiKey}`,
  "content-type": "application/json",
  accept: "application/json",
});

/** Request-scoped routes drop the endpoint's sub-path: `owner/app/requests/<id>`. */
const requestBase = (endpointId: string, requestId: string): string =>
  `${QUEUE_BASE}/${endpointId.split("/").slice(0, 2).join("/")}/requests/${encodeURIComponent(requestId)}`;

const errorMessage = (data: unknown, fallback: string): string => {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const detail = record.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      const first = detail[0] as { msg?: unknown } | undefined;
      if (typeof first?.msg === "string") return first.msg;
    }
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return fallback;
};

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
};

/**
 * Queue a request. Throws `FalError` with `definitive` when fal refused it;
 * any other throw means fal may have accepted it.
 */
export const submitFal = async (args: {
  apiKey: string;
  endpointId: string;
  input: Record<string, unknown>;
  webhookUrl: string;
}): Promise<{ requestId: string; status: string }> => {
  const url = new URL(`${QUEUE_BASE}/${args.endpointId}`);
  url.searchParams.set("fal_webhook", args.webhookUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: headers(args.apiKey),
    body: JSON.stringify(args.input),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const code =
      (data && typeof data === "object" && typeof (data as { error_type?: unknown }).error_type === "string"
        ? ((data as { error_type: string }).error_type)
        : undefined) ?? response.headers.get("x-fal-error-type") ?? undefined;
    throw new FalError(
      errorMessage(data, `fal submission failed with status ${response.status}`),
      response.status < 500,
      code,
    );
  }
  const record = (data ?? {}) as { request_id?: unknown; status?: unknown };
  if (typeof record.request_id !== "string" || !record.request_id) {
    throw new FalError("fal accepted the request without a request_id.", false);
  }
  return {
    requestId: record.request_id,
    status: typeof record.status === "string" ? record.status.toUpperCase() : "IN_QUEUE",
  };
};

export type FalOutcome =
  | { state: "pending"; running: boolean }
  | { state: "succeeded"; payload: unknown }
  | { state: "failed"; message: string; code?: string };

/** Where a request stands, with its payload once it completed. */
export const pollFal = async (apiKey: string, endpointId: string, requestId: string): Promise<FalOutcome> => {
  const base = requestBase(endpointId, requestId);
  const status = await fetch(`${base}/status`, { headers: headers(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const statusBody = (await readJson(status)) as { status?: unknown } | null;
  if (!status.ok) throw new Error(`fal status returned ${status.status}.`);
  const state = typeof statusBody?.status === "string" ? statusBody.status.toUpperCase() : "";
  if (state !== "COMPLETED") return { state: "pending", running: state === "IN_PROGRESS" };
  const result = await fetch(base, { headers: headers(apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const payload = await readJson(result);
  if (result.ok) return { state: "succeeded", payload };
  if (result.status >= 500) throw new Error(`fal result returned ${result.status}.`);
  return { state: "failed", message: errorMessage(payload, `fal request failed (${result.status}).`) };
};

/** Best effort: a finished or unknown request answers 404/409, which is fine. */
export const cancelFal = async (apiKey: string, endpointId: string, requestId: string): Promise<void> => {
  const response = await fetch(`${requestBase(endpointId, requestId)}/cancel`, {
    method: "PUT",
    headers: headers(apiKey),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error(`fal cancel returned ${response.status}.`);
  }
};
