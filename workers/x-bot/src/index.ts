import { isValidXUsername, parseXBotMentions } from "./mentions";
import {
  admitMention,
  cardKey,
  processRun,
  readPage,
  retryPendingRuns,
} from "./runs";

const PAGE_PREFIX = "/page/";
const PAGE_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
const CARD_PATTERN = /^\/card\/(\d{1,32})\.png$/;

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

// X signs CRC challenges and event bodies with the app's consumer secret.
const handleCrc = async (url: URL, env: Env): Promise<Response> => {
  const crcToken = url.searchParams.get("crc_token")?.trim();
  if (!crcToken) {
    return jsonResponse({ error: "Invalid CRC request" }, 400);
  }
  return jsonResponse({
    response_token: `sha256=${await hmacSha256(env.X_BOT_API_SECRET, crcToken)}`,
  });
};

const handleEvents = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const rawBody = await request.text();
  const signature = request.headers.get("x-twitter-webhooks-signature");
  const expected = `sha256=${await hmacSha256(env.X_BOT_API_SECRET, rawBody)}`;
  if (!signature || !constantTimeEqual(signature, expected)) {
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
    env.X_BOT_USERNAME.trim() || "stelladotsh",
    env.X_BOT_USER_ID.trim() || undefined,
  );
  let scheduled = 0;
  for (const mention of mentions) {
    const admission = await admitMention(env, mention, Date.now());
    if (admission !== "scheduled") {
      if (admission !== "duplicate") {
        console.warn("x_bot_mention_skipped", {
          mentionId: mention.id,
          authorId: mention.authorId,
          reason: admission,
        });
      }
      continue;
    }
    ctx.waitUntil(processRun(env, mention.id));
    scheduled += 1;
  }
  return jsonResponse({ ok: true, scheduled });
};

// Public JSON behind stella.sh/x/<handle>. Handles are already public on X
// and the rows hold only what the bot itself posted.
const handlePage = async (url: URL, env: Env): Promise<Response> => {
  let handle: string;
  try {
    handle = decodeURIComponent(url.pathname.slice(PAGE_PREFIX.length))
      .trim()
      .replace(/^@/, "");
  } catch {
    return jsonResponse({ error: "Invalid handle" }, 400);
  }
  if (!isValidXUsername(handle)) {
    return jsonResponse({ error: "Invalid handle" }, 400);
  }
  const page = await readPage(env, handle, url.origin);
  return jsonResponse(page, 200, { "Cache-Control": PAGE_CACHE_CONTROL });
};

const handleCard = async (mentionId: string, env: Env): Promise<Response> => {
  const object = await env.MEDIA.get(cardKey(mentionId));
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/webhook") {
      if (request.method === "GET") return handleCrc(url, env);
      if (request.method === "POST") return handleEvents(request, env, ctx);
      return new Response("Method not allowed", { status: 405 });
    }
    if (request.method !== "GET") {
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith(PAGE_PREFIX)) {
      return handlePage(url, env);
    }
    const card = CARD_PATTERN.exec(url.pathname);
    if (card?.[1]) {
      return handleCard(card[1], env);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(retryPendingRuns(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
