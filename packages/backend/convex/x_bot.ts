"use node";

import OpenAI from "openai";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
  buildXBotPrompt,
  normalizeXReply,
  parseXPostContext,
} from "./lib/x_bot";
import { createXOAuth1Header, type XOAuthCredentials } from "./lib/x_bot_oauth";

const X_API_BASE_URL = "https://api.x.com";
const STELLA_X_INSTRUCTIONS = `You are Stella AI, the official X account for Stella.
Stella is a desktop AI assistant that can use the computer on the user's behalf: work across apps, browse, manage files, run terminal commands, and carry out multi-step computer tasks with the user's approval and visibility.

Write a single natural X reply explaining how Stella can help with the task in the referenced post. The caller intentionally summoned you, so begin confidently with what you can do. Be specific to the post, honest about any user confirmation or account access required, and end with a compact invitation to get Stella at stella.sh. Do not include a protocol in the address. Do not use markdown, hashtags, quotation marks around the reply, or more than 270 characters. Never claim Stella can bypass security, licensing, platform restrictions, or safety controls.`;

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
  body?: JsonObject,
): Promise<unknown> => {
  const authorization = await createXOAuth1Header(method, url, credentials);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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
      status: response.status,
      response: typeof payload === "string" ? payload.slice(0, 500) : payload,
    });
    throw new Error(`X API request failed with status ${response.status}`);
  }
  return payload;
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

const createReply = async (
  replyToPostId: string,
  text: string,
  credentials: XOAuthCredentials,
) => {
  const payload = await xRequest(
    "POST",
    `${X_API_BASE_URL}/2/tweets`,
    credentials,
    {
      text,
      reply: { in_reply_to_tweet_id: replyToPostId },
    },
  );
  const data = isJsonObject(payload) ? payload.data : null;
  const created = isJsonObject(data) ? data.id : null;
  if (typeof created !== "string" || created.length === 0) {
    throw new Error("X did not return the created reply ID");
  }
  return created;
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
  handler: async (_ctx, mention) => {
    const credentials = getXCredentials();
    const parent = await fetchParentPost(mention.parentId, credentials);
    const client = new OpenAI({
      apiKey: requireEnv("OPENAI_API_KEY"),
      maxRetries: 2,
    });
    const response = await client.responses.create({
      model: process.env.X_BOT_MODEL?.trim() || "gpt-5.4-mini",
      instructions: STELLA_X_INSTRUCTIONS,
      input: buildXBotPrompt(mention, parent),
      max_output_tokens: 180,
      store: false,
    });
    const replyText = normalizeXReply(response.output_text);
    if (!replyText) {
      throw new Error("Stella AI returned an empty X reply");
    }
    const replyId = await createReply(mention.id, replyText, credentials);
    console.info("x_bot_reply_created", {
      mentionId: mention.id,
      parentId: mention.parentId,
      replyId,
      replyCharacters: Array.from(replyText).length,
    });
    return null;
  },
});
