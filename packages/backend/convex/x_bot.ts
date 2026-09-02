"use node";

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import OpenAI from "openai";
import satori from "satori";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  buildXBotPrompt,
  parseXBotPromoterUsernames,
  parseXBotReplyPlan,
  parseXPostContext,
  resolveXBotPageHandle,
  X_BOT_REPLY_PLAN_SCHEMA,
  type XBotReplyPlan,
} from "./lib/x_bot";
import {
  buildXBotCardTree,
  X_BOT_CARD_FONT_FAMILIES,
  X_BOT_CARD_HEIGHT,
  X_BOT_CARD_WIDTH,
} from "./lib/x_bot_card";
import { X_BOT_LOGO_DATA_URI } from "./lib/x_bot_logo";
import { createXOAuth1Header, type XOAuthCredentials } from "./lib/x_bot_oauth";

const X_API_BASE_URL = "https://api.x.com";
const STELLA_X_INSTRUCTIONS = `You are Stella AI, the official X account for Stella.
Stella is a desktop AI assistant that can use the computer on the user's behalf: work across apps, browse, manage files, run terminal commands, and carry out multi-step computer tasks with the user's approval and visibility.

Someone summoned you under a post. Produce three things as JSON:
1. "reply": the public X reply. The caller intentionally summoned you, so begin confidently with what you can do for the task in the referenced post. Be specific, honest about any user confirmation or account access required, and keep it under 260 characters. Never include a URL, a domain name, a hashtag, markdown, or quotation marks around the reply. An image attached to the reply carries the download address, so do not mention where to get Stella.
2. "headline": one first-person sentence, under 70 characters, specific to the post, that reads well at poster size. Example: "I can set up that modded server for your friends."
3. "exchanges": one or two chat turns showing what it looks like to hand this task to Stella on the desktop. "user" is what the poster would type to Stella. "stella" is Stella's answer: concrete steps it takes, and where it pauses for approval.

Never claim Stella can bypass security, licensing, platform restrictions, or safety controls.`;

const X_BOT_SANS_FONT_FILES = {
  regular: "@fontsource/manrope/files/manrope-latin-400-normal.woff",
  medium: "@fontsource/manrope/files/manrope-latin-500-normal.woff",
  semibold: "@fontsource/manrope/files/manrope-latin-600-normal.woff",
} as const;
const X_BOT_DISPLAY_FONT_FILE =
  "@fontsource/cormorant-garamond/files/cormorant-garamond-latin-300-normal.woff";
const X_BOT_MONO_FONT_FILE =
  "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff";
const X_BOT_RESVG_WASM_FILE = "@resvg/resvg-wasm/index_bg.wasm";
const X_MEDIA_APPEND_CHUNK_BYTES = 4 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireEnv = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
};

const getXCredentials = (): XOAuthCredentials => ({
  apiKey: requireEnv("X_BOT_API_KEY"),
  apiSecret: requireEnv("X_BOT_API_SECRET"),
  accessToken: requireEnv("X_BOT_ACCESS_TOKEN"),
  accessTokenSecret: requireEnv("X_BOT_ACCESS_TOKEN_SECRET"),
});

const xRequest = async (
  method: "GET" | "POST",
  url: string,
  credentials: XOAuthCredentials,
  body?: JsonObject | FormData,
): Promise<unknown> => {
  const authorization = await createXOAuth1Header(method, url, credentials);
  const isForm = body instanceof FormData;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    console.error("x_bot_x_request_failed", {
      method,
      url: url.split("?")[0],
      status: response.status,
      response: typeof payload === "string" ? payload.slice(0, 500) : payload,
    });
    throw new Error(`X API request failed with status ${response.status}`);
  }
  return payload;
};

const readDataId = (payload: unknown): string | null => {
  const data = isJsonObject(payload) ? payload.data : null;
  const id = isJsonObject(data) ? data.id : null;
  return typeof id === "string" && id.length > 0 ? id : null;
};

const fetchParentPost = async (
  postId: string,
  credentials: XOAuthCredentials,
) => {
  const url = new URL(
    `${X_API_BASE_URL}/2/tweets/${encodeURIComponent(postId)}`,
  );
  url.searchParams.set(
    "tweet.fields",
    "author_id,conversation_id,created_at,referenced_tweets",
  );
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "name,username,description");
  const payload = await xRequest("GET", url.toString(), credentials);
  const context = parseXPostContext(payload);
  if (!context) {
    throw new Error("X parent post response was incomplete");
  }
  return context;
};

// X v2 media upload is always chunked: INIT, APPEND, FINALIZE. Images finish
// synchronously, so no STATUS polling is needed for `tweet_image`.
const uploadImage = async (
  png: Uint8Array<ArrayBuffer>,
  credentials: XOAuthCredentials,
): Promise<string> => {
  const initialized = await xRequest(
    "POST",
    `${X_API_BASE_URL}/2/media/upload/initialize`,
    credentials,
    {
      media_type: "image/png",
      media_category: "tweet_image",
      total_bytes: png.byteLength,
    },
  );
  const mediaId = readDataId(initialized);
  if (!mediaId) {
    throw new Error("X did not return a media ID");
  }
  for (
    let offset = 0, segment = 0;
    offset < png.byteLength;
    offset += X_MEDIA_APPEND_CHUNK_BYTES, segment += 1
  ) {
    const form = new FormData();
    form.set("segment_index", String(segment));
    form.set(
      "media",
      new Blob([png.subarray(offset, offset + X_MEDIA_APPEND_CHUNK_BYTES)], {
        type: "image/png",
      }),
      "card.png",
    );
    await xRequest(
      "POST",
      `${X_API_BASE_URL}/2/media/upload/${encodeURIComponent(mediaId)}/append`,
      credentials,
      form,
    );
  }
  const finalized = await xRequest(
    "POST",
    `${X_API_BASE_URL}/2/media/upload/${encodeURIComponent(mediaId)}/finalize`,
    credentials,
  );
  return readDataId(finalized) ?? mediaId;
};

const createReply = async (
  replyToPostId: string,
  text: string,
  mediaId: string | null,
  credentials: XOAuthCredentials,
) => {
  const payload = await xRequest(
    "POST",
    `${X_API_BASE_URL}/2/tweets`,
    credentials,
    {
      text,
      reply: { in_reply_to_tweet_id: replyToPostId },
      ...(mediaId ? { media: { media_ids: [mediaId] } } : {}),
    },
  );
  const created = readDataId(payload);
  if (!created) {
    throw new Error("X did not return the created reply ID");
  }
  return created;
};

const generateReplyPlan = async (
  prompt: string,
): Promise<XBotReplyPlan> => {
  const client = new OpenAI({
    apiKey: requireEnv("OPENAI_API_KEY"),
    maxRetries: 2,
  });
  const response = await client.responses.create({
    model: process.env.X_BOT_MODEL?.trim() || "gpt-5.4-mini",
    instructions: STELLA_X_INSTRUCTIONS,
    input: prompt,
    max_output_tokens: 600,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "stella_x_reply",
        strict: true,
        schema: X_BOT_REPLY_PLAN_SCHEMA,
      },
    },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.output_text) as unknown;
  } catch {
    throw new Error("Stella AI returned malformed reply JSON");
  }
  const plan = parseXBotReplyPlan(parsed);
  if (!plan || !plan.reply) {
    throw new Error("Stella AI returned an incomplete reply plan");
  }
  return plan;
};

// Fonts and the resvg WASM ship as external packages (see convex.json) so
// they can be read from node_modules at runtime instead of being bundled.
const resolvePackageFile = (specifier: string): string => {
  const base =
    typeof import.meta.url === "string" && import.meta.url.length > 0
      ? import.meta.url
      : `${process.cwd()}/`;
  return createRequire(base).resolve(specifier);
};
const readPackageFile = (specifier: string) =>
  readFile(resolvePackageFile(specifier));

type CardFont = {
  name: string;
  data: ArrayBuffer;
  weight: 300 | 400 | 500 | 600;
  style: "normal";
};

let cardFontsPromise: Promise<CardFont[]> | null = null;
const loadCardFonts = (): Promise<CardFont[]> => {
  cardFontsPromise ??= Promise.all([
    readPackageFile(X_BOT_DISPLAY_FONT_FILE).then((data) => ({
      name: X_BOT_CARD_FONT_FAMILIES.display,
      data: toArrayBuffer(data),
      weight: 300 as const,
      style: "normal" as const,
    })),
    readPackageFile(X_BOT_SANS_FONT_FILES.regular).then((data) => ({
      name: X_BOT_CARD_FONT_FAMILIES.sans,
      data: toArrayBuffer(data),
      weight: 400 as const,
      style: "normal" as const,
    })),
    readPackageFile(X_BOT_SANS_FONT_FILES.medium).then((data) => ({
      name: X_BOT_CARD_FONT_FAMILIES.sans,
      data: toArrayBuffer(data),
      weight: 500 as const,
      style: "normal" as const,
    })),
    readPackageFile(X_BOT_SANS_FONT_FILES.semibold).then((data) => ({
      name: X_BOT_CARD_FONT_FAMILIES.sans,
      data: toArrayBuffer(data),
      weight: 600 as const,
      style: "normal" as const,
    })),
    readPackageFile(X_BOT_MONO_FONT_FILE).then((data) => ({
      name: X_BOT_CARD_FONT_FAMILIES.mono,
      data: toArrayBuffer(data),
      weight: 500 as const,
      style: "normal" as const,
    })),
  ]);
  return cardFontsPromise;
};

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;

let resvgPromise: Promise<typeof import("@resvg/resvg-wasm")> | null = null;
const loadResvg = () => {
  resvgPromise ??= (async () => {
    const resvg = await import("@resvg/resvg-wasm");
    await resvg.initWasm(await readPackageFile(X_BOT_RESVG_WASM_FILE));
    return resvg;
  })();
  return resvgPromise;
};

export const renderXBotCard = async (input: {
  headline: string;
  handle: string;
  exchanges: XBotReplyPlan["exchanges"];
}): Promise<Uint8Array<ArrayBuffer>> => {
  const [fonts, resvg] = await Promise.all([loadCardFonts(), loadResvg()]);
  // Satori types its input as a React element; the template builds the same
  // plain {type, props} shape without pulling React into the bundle.
  const element = buildXBotCardTree({
    ...input,
    logoDataUri: X_BOT_LOGO_DATA_URI,
  }) as unknown as Parameters<typeof satori>[0];
  const svg = await satori(
    element,
    {
      width: X_BOT_CARD_WIDTH,
      height: X_BOT_CARD_HEIGHT,
      fonts,
    },
  );
  const rendered = new resvg.Resvg(svg, {
    fitTo: { mode: "width", value: X_BOT_CARD_WIDTH },
    background: "#ffffff",
  });
  // Copy into a fresh ArrayBuffer-backed view so it can feed Blob and FormData.
  return new Uint8Array(rendered.render().asPng());
};

export const processMention = internalAction({
  args: {
    id: v.string(),
    text: v.string(),
    authorId: v.string(),
    authorUsername: v.string(),
    authorName: v.string(),
    parentId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, mention) => {
    const credentials = getXCredentials();
    const parent = await fetchParentPost(mention.parentId, credentials);
    const { handle, isPromoterSummon } = resolveXBotPageHandle(
      mention,
      parent,
      parseXBotPromoterUsernames(process.env.X_BOT_PROMOTER_USERNAMES),
    );
    const plan = await generateReplyPlan(
      buildXBotPrompt(mention, parent, { addressee: handle }),
    );

    let mediaId: string | null = null;
    let imageStorageId: Awaited<ReturnType<typeof ctx.storage.store>> | undefined;
    try {
      const png = await renderXBotCard({
        headline: plan.headline,
        handle,
        exchanges: plan.exchanges,
      });
      const blob = new Blob([png], { type: "image/png" });
      [mediaId, imageStorageId] = await Promise.all([
        uploadImage(png, credentials),
        ctx.storage.store(blob),
      ]);
    } catch (error) {
      // The image carries the address, so a reply without it is worth less,
      // but a summon left unanswered is worse. Post the text and log loudly.
      console.error("x_bot_card_failed", {
        mentionId: mention.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const replyId = await createReply(
      mention.id,
      plan.reply,
      mediaId,
      credentials,
    );
    await ctx.runMutation(internal.data.x_bot.recordXBotRun, {
      handle,
      mentionId: mention.id,
      parentId: mention.parentId,
      replyId,
      summonerUsername: mention.authorUsername,
      posterUsername: parent.authorUsername,
      headline: plan.headline,
      reply: plan.reply,
      exchanges: plan.exchanges,
      imageStorageId,
    });
    console.info("x_bot_reply_created", {
      mentionId: mention.id,
      parentId: mention.parentId,
      replyId,
      handle,
      isPromoterSummon,
      withImage: mediaId !== null,
      replyCharacters: Array.from(plan.reply).length,
    });
    return null;
  },
});
