import { parseXPostContext, type XPostContext } from "./mentions";
import { createXOAuth1Header, type XOAuthCredentials } from "./oauth";

const X_API_BASE_URL = "https://api.x.com";
const X_MEDIA_APPEND_CHUNK_BYTES = 4 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const xCredentials = (env: Env): XOAuthCredentials => ({
  apiKey: env.X_BOT_API_KEY,
  apiSecret: env.X_BOT_API_SECRET,
  accessToken: env.X_BOT_ACCESS_TOKEN,
  accessTokenSecret: env.X_BOT_ACCESS_TOKEN_SECRET,
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

export const fetchParentPost = async (
  postId: string,
  credentials: XOAuthCredentials,
): Promise<XPostContext> => {
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
export const uploadImage = async (
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

export const createReply = async (
  replyToPostId: string,
  text: string,
  mediaId: string | null,
  credentials: XOAuthCredentials,
): Promise<string> => {
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
