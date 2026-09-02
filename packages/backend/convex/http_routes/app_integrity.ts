import {
  APP_INTEGRITY_CHALLENGE_PATH,
  APP_INTEGRITY_NONCE_TTL_MS,
  isAppIntegrityPurpose,
  type AppIntegrityPurpose,
} from "@stella/contracts/app-integrity";
import {
  makeFunctionReference,
  type FunctionReference,
  type HttpRouter,
} from "convex/server";
import { httpAction } from "../_generated/server";
import {
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import { getClientAddressKey } from "../lib/http_utils";
import {
  consumeWebhookRateLimit,
  rateLimitResponse,
} from "../http_shared/webhook_controls";

const CHALLENGE_RATE_LIMIT = 30;
const CHALLENGE_RATE_WINDOW_MS = 60_000;

const issueNonceRef = makeFunctionReference<
  "mutation",
  {
    nonce: string;
    purpose: AppIntegrityPurpose;
    createdAt: number;
    expiresAt: number;
  },
  null
>(
  "app_integrity:issueAppIntegrityNonceInternal",
) as unknown as FunctionReference<
  "mutation",
  "internal",
  {
    nonce: string;
    purpose: AppIntegrityPurpose;
    createdAt: number;
    expiresAt: number;
  },
  null
>;

const randomNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const readPurpose = async (
  request: Request,
): Promise<AppIntegrityPurpose | null> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const purpose = Object.getOwnPropertyDescriptor(body, "purpose")?.value;
  return isAppIntegrityPurpose(purpose) ? purpose : null;
};

export const registerAppIntegrityRoutes = (http: HttpRouter): void => {
  registerCorsOptions(http, [APP_INTEGRITY_CHALLENGE_PATH]);
  http.route({
    path: APP_INTEGRITY_CHALLENGE_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "app_integrity_challenge_ip",
          key: getClientAddressKey(request) ?? "unknown",
          limit: CHALLENGE_RATE_LIMIT,
          windowMs: CHALLENGE_RATE_WINDOW_MS,
          blockMs: CHALLENGE_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
        }

        const purpose = await readPurpose(request);
        if (!purpose) {
          return jsonResponse({ error: "invalid_purpose" }, 400, origin);
        }
        const nonce = randomNonce();
        const createdAt = Date.now();
        const expiresAt = createdAt + APP_INTEGRITY_NONCE_TTL_MS;
        await ctx.runMutation(issueNonceRef, {
          nonce,
          purpose,
          createdAt,
          expiresAt,
        });
        const response = jsonResponse({ nonce, expiresAt }, 200, origin);
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store, max-age=0");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }),
    ),
  });
};
