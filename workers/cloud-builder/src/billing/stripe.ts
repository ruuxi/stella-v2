/**
 * The few Stripe REST calls billing makes, over fetch: no SDK in the Worker
 * bundle. Parameters are form-encoded the way Stripe expects nested objects
 * (`a[b][0][c]=...`). Webhooks are verified with the endpoint secret over
 * `t.payload`, as Stripe signs them.
 */

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2026-05-27.dahlia";
const STRIPE_TIMEOUT_MS = 30_000;
/** Stripe's default webhook tolerance. */
const WEBHOOK_TOLERANCE_S = 300;

export class StripeError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

const appendForm = (form: URLSearchParams, key: string, value: FormValue): void => {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendForm(form, `${key}[${index}]`, entry));
    return;
  }
  if (typeof value === "object") {
    for (const [child, entry] of Object.entries(value)) appendForm(form, `${key}[${child}]`, entry);
    return;
  }
  form.append(key, String(value));
};

export const stripeSecretKey = (env: Cloudflare.Env): string => {
  const key = (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY;
  if (typeof key !== "string" || !key.trim()) {
    throw new StripeError(503, "Stripe is not configured.");
  }
  return key.trim();
};

export const stripeRequest = async <T>(
  env: Cloudflare.Env,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, FormValue> = {},
  options: { idempotencyKey?: string } = {},
): Promise<T> => {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) appendForm(form, key, value);
  const query = method === "GET" && form.size > 0 ? `?${form}` : "";
  const response = await fetch(`${STRIPE_API}${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${stripeSecretKey(env)}`,
      "stripe-version": STRIPE_API_VERSION,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    ...(method === "POST" ? { body: form.toString() } : {}),
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: { message?: string; code?: string } })
    | null;
  if (!response.ok || !body) {
    throw new StripeError(
      response.status,
      body?.error?.message ?? `Stripe returned ${response.status}.`,
      body?.error?.code,
    );
  }
  return body;
};

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

/** The verified event, or null when the signature or timestamp is wrong. */
export const verifyStripeWebhook = async (
  payload: string,
  signatureHeader: string | null,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<StripeEvent | null> => {
  if (!signatureHeader) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) return null;
  if (Math.abs(nowS - timestamp) > WEBHOOK_TOLERANCE_S) return null;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)),
  );
  if (!signatures.some((signature) => timingSafeEqual(signature, expected))) return null;
  try {
    const event = JSON.parse(payload) as StripeEvent;
    return typeof event?.id === "string" && typeof event.type === "string" ? event : null;
  } catch {
    return null;
  }
};
