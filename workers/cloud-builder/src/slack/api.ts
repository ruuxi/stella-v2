/**
 * A minimal Slack Web API client: JSON (or form) POSTs with a bot token, one
 * retry on HTTP 429 using Slack's `Retry-After`, and `ok: false` surfaced as
 * a `SlackApiError` carrying Slack's error code.
 */

const SLACK_API = "https://slack.com/api";
const MAX_RETRY_WAIT_MS = 5_000;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export type SlackResponse = { ok: boolean; error?: string; [key: string]: unknown };

/** Methods that read their arguments only from a form body or query, not JSON. */
const FORM_METHODS = new Set([
  "oauth.v2.access",
  "files.getUploadURLExternal",
  "users.info",
  "conversations.info",
  "conversations.replies",
  "conversations.history",
]);

export const slackCall = async <T extends SlackResponse = SlackResponse>(
  token: string | null,
  method: string,
  args: Record<string, unknown> = {},
  attempt = 0,
): Promise<T> => {
  const form = FORM_METHODS.has(method);
  const headers: Record<string, string> = {
    "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = form
    ? new URLSearchParams(
        Object.entries(args).flatMap(([key, value]) =>
          value === undefined || value === null ? [] : [[key, String(value)]],
        ),
      ).toString()
    : JSON.stringify(args);
  const response = await fetch(`${SLACK_API}/${method}`, { method: "POST", headers, body });
  if (response.status === 429 && attempt === 0) {
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    await response.body?.cancel().catch(() => undefined);
    await scheduler.wait(Math.min(MAX_RETRY_WAIT_MS, Math.max(500, retryAfter * 1000)));
    return await slackCall<T>(token, method, args, attempt + 1);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SlackApiError(method, `http_${response.status}`, response.status);
  }
  const parsed = (await response.json()) as T;
  if (!parsed.ok) throw new SlackApiError(method, parsed.error ?? "unknown_error");
  return parsed;
};

/** Same call, but a Slack-side refusal is logged and swallowed. */
export const slackTry = async <T extends SlackResponse = SlackResponse>(
  token: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T | null> => {
  try {
    return await slackCall<T>(token, method, args);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "slack_call_failed",
        method,
        code: error instanceof SlackApiError ? error.code : error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
};

const SLACK_TEXT_LIMIT = 11_500;

/** Split long Markdown on paragraph, then line, boundaries. */
export const splitForSlack = (text: string, limit = SLACK_TEXT_LIMIT): string[] => {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
};

/** Download a private Slack file with the bot token, capped at `maxBytes`. */
export const downloadSlackFile = async (
  token: string,
  url: string,
  maxBytes: number,
): Promise<Uint8Array | null> => {
  if (!/^https:\/\/([a-z0-9-]+\.)*slack(-edge)?\.com\//u.test(url)) return null;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: "follow" });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Upload bytes into a channel or thread (files.getUploadURLExternal flow). */
export const uploadSlackFile = async (
  token: string,
  args: {
    channelId: string;
    threadTs?: string;
    filename: string;
    title?: string;
    bytes: Uint8Array;
    contentType?: string;
  },
): Promise<boolean> => {
  const ticket = await slackCall<SlackResponse & { upload_url: string; file_id: string }>(
    token,
    "files.getUploadURLExternal",
    { filename: args.filename, length: args.bytes.byteLength },
  );
  const uploaded = await fetch(ticket.upload_url, {
    method: "POST",
    headers: { "content-type": args.contentType || "application/octet-stream" },
    body: args.bytes,
  });
  await uploaded.body?.cancel().catch(() => undefined);
  if (!uploaded.ok) throw new SlackApiError("upload_url", `http_${uploaded.status}`, uploaded.status);
  await slackCall(token, "files.completeUploadExternal", {
    files: [{ id: ticket.file_id, title: args.title ?? args.filename }],
    channel_id: args.channelId,
    ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
  });
  return true;
};
