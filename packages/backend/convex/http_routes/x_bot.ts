import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import {
  consumeWebhookDedup,
  consumeWebhookRateLimit,
} from "../http_shared/webhook_controls";
import { parseXBotMentions } from "../lib/x_bot";

const X_BOT_WEBHOOK_PATH = "/api/x/bot/webhook";
const X_BOT_RATE_WINDOW_MS = 60 * 60 * 1000;
const X_BOT_RATE_LIMIT = 30;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const hmacSha256 = async (secret: string, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return bytesToBase64(new Uint8Array(signature));
};

const constantTimeEqual = (left: string, right: string): boolean => {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

const verifyWebhookSignature = async (
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> => {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = `sha256=${await hmacSha256(secret, rawBody)}`;
  return constantTimeEqual(signatureHeader, expected);
};

export const registerXBotRoutes = (http: HttpRouter): void => {
  http.route({
    path: X_BOT_WEBHOOK_PATH,
    method: "GET",
    handler: httpAction(async (_ctx, request) => {
      const secret = process.env.X_BOT_API_SECRET?.trim();
      const crcToken = new URL(request.url).searchParams
        .get("crc_token")
        ?.trim();
      if (!secret || !crcToken) {
        return jsonResponse({ error: "Invalid CRC request" }, 400);
      }
      return jsonResponse({
        response_token: `sha256=${await hmacSha256(secret, crcToken)}`,
      });
    }),
  });

  http.route({
    path: X_BOT_WEBHOOK_PATH,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const secret = process.env.X_BOT_API_SECRET?.trim();
      if (!secret) {
        console.error("x_bot_webhook_unconfigured", {
          missing: "X_BOT_API_SECRET",
        });
        return jsonResponse({ error: "Webhook is not configured" }, 503);
      }

      const rawBody = await request.text();
      const validSignature = await verifyWebhookSignature(
        rawBody,
        request.headers.get("x-twitter-webhooks-signature"),
        secret,
      );
      if (!validSignature) {
        return jsonResponse({ error: "Invalid signature" }, 401);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody) as unknown;
      } catch {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }

      const mentions = parseXBotMentions(
        payload,
        process.env.X_BOT_USERNAME?.trim() || "stelladotsh",
        process.env.X_BOT_USER_ID?.trim(),
      );
      let scheduled = 0;
      for (const mention of mentions) {
        const isNew = await consumeWebhookDedup(ctx, "x_bot_event", mention.id);
        if (!isNew) {
          continue;
        }
        const rateLimit = await consumeWebhookRateLimit(ctx, {
          scope: "x_bot_caller",
          key: mention.authorId,
          limit: X_BOT_RATE_LIMIT,
          windowMs: X_BOT_RATE_WINDOW_MS,
          blockMs: X_BOT_RATE_WINDOW_MS,
        });
        if (!rateLimit.allowed) {
          console.warn("x_bot_caller_rate_limited", {
            authorId: mention.authorId,
            retryAfterMs: rateLimit.retryAfterMs,
          });
          continue;
        }
        await ctx.scheduler.runAfter(0, internal.x_bot.processMention, mention);
        scheduled += 1;
      }

      return jsonResponse({ ok: true, scheduled });
    }),
  });
};
