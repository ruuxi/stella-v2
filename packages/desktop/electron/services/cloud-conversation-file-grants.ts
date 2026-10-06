/**
 * Files Stella produced or displayed in one of the owner's conversations,
 * read from that conversation's cloud journal.
 *
 * A paired phone may open a file on this computer when Stella put it in front
 * of the user in the conversation the phone names: a file link in one of
 * Stella's replies, the report an agent finished with, a `files` card, or a
 * file a display tool (`html`, `image_gen`) produced. The journal is the
 * source of truth, not this window's local cache, so a phone conversation the
 * desktop window is not showing grants the same as the one it is.
 *
 * The journal is read with this computer's own account token through
 * `history.read`, which the conversation's Durable Object answers only for
 * its owner, so another account's conversation id grants nothing. The user's
 * own messages never grant anything: naming a path is not the same as Stella
 * having produced it.
 */

import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";

/** Records `history.read` returns per call (the server's batch cap). */
const READ_BATCH = 200;
/** Journal records scanned per conversation, newest first. */
const MAX_RECORDS = 4_000;
const CACHE_TTL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Tools whose result `filePath` is a file Stella showed the user. */
const DISPLAY_TOOLS = new Set(["html", "image_gen"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const messageTexts = (payload: Record<string, unknown>): string[] => {
  const content = payload.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (block?.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts;
};

const parsePayload = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
};

/** Paths one journal record grants, by what kind of record it is. */
export const journalRecordFilePaths = (raw: unknown): string[] => {
  const record = asRecord(raw);
  if (!record) return [];
  const paths: string[] = [];
  const addLinks = (text: unknown) => {
    if (typeof text === "string") paths.push(...extractLocalFileLinkPaths(text));
  };
  if (record.kind === "message") {
    const payload = parsePayload(record.payload);
    if (!payload) return [];
    const role = record.role ?? payload.role;
    if (role === "assistant") {
      for (const text of messageTexts(payload)) addLinks(text);
    } else if (role === "user" && payload.source === "agent-thread") {
      // An agent's completion wake carries the report it finished with.
      for (const text of messageTexts(payload)) addLinks(text);
    } else if (
      role === "toolResult" &&
      typeof payload.toolName === "string" &&
      DISPLAY_TOOLS.has(payload.toolName) &&
      payload.isError !== true
    ) {
      const details = asRecord(payload.details);
      if (typeof details?.filePath === "string") paths.push(details.filePath);
    }
    return paths;
  }
  if (record.kind === "card") {
    const card = asRecord(record.card);
    if (card?.type === "files" && Array.isArray(card.files)) {
      for (const file of card.files) {
        const filePath = asRecord(file)?.path;
        if (typeof filePath === "string") paths.push(filePath);
      }
    } else if (card?.type === "agent-lifecycle") {
      const event = asRecord(card.event);
      if (event?.type === "agent-completed") {
        addLinks(asRecord(event.payload)?.result);
      }
    }
  }
  return paths;
};

type Deps = {
  getBackendUrl: () => string | null;
  getAuthToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
};

export type CloudConversationFileGrants = {
  /** Every path Stella produced or displayed in `conversationId`. */
  listPaths: (conversationId: string) => Promise<string[]>;
};

export const createCloudConversationFileGrants = (
  deps: Deps,
): CloudConversationFileGrants => {
  const cache = new Map<string, { at: number; paths: Promise<string[]> }>();

  const historyCall = async (
    baseUrl: string,
    token: string,
    conversationId: string,
    body: unknown,
  ): Promise<unknown> => {
    const response = await (deps.fetchImpl ?? fetch)(
      `${baseUrl}/conversations/${encodeURIComponent(conversationId)}/history/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Conversation history is unavailable (${response.status}).`);
    }
    return await response.json();
  };

  const load = async (conversationId: string): Promise<string[]> => {
    const baseUrl = deps.getBackendUrl()?.trim().replace(/\/+$/, "");
    const token = await deps.getAuthToken().catch(() => null);
    if (!baseUrl || !token) return [];
    const headRows = await historyCall(baseUrl, token, conversationId, {
      op: "sql",
      query: "SELECT MAX(seq) AS head FROM journal",
    });
    const head = Number(
      Array.isArray(headRows) ? asRecord(headRows[0])?.head : Number.NaN,
    );
    if (!Number.isSafeInteger(head) || head < 0) return [];
    const paths = new Set<string>();
    const floor = Math.max(0, head - MAX_RECORDS + 1);
    for (let to = head; to >= floor; to -= READ_BATCH) {
      const from = Math.max(floor, to - READ_BATCH + 1);
      const range = asRecord(
        await historyCall(baseUrl, token, conversationId, {
          op: "read",
          fromSeq: from,
          toSeq: to,
        }),
      );
      const records = Array.isArray(range?.records) ? range.records : [];
      for (const record of records) {
        for (const filePath of journalRecordFilePaths(record)) {
          paths.add(filePath);
        }
      }
    }
    return [...paths];
  };

  return {
    listPaths: (conversationId) => {
      const id = conversationId.trim();
      if (!id) return Promise.resolve([]);
      const now = Date.now();
      const cached = cache.get(id);
      if (cached && now - cached.at < CACHE_TTL_MS) return cached.paths;
      const paths = load(id).catch((error: unknown) => {
        cache.delete(id);
        console.warn(
          "[device-requests] Could not read the conversation's files from the cloud journal:",
          error instanceof Error ? error.message : String(error),
        );
        return [] as string[];
      });
      cache.set(id, { at: now, paths });
      for (const [key, entry] of cache) {
        if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
      }
      return paths;
    },
  };
};
