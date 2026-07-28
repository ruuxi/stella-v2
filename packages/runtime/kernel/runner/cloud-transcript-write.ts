/**
 * Desktop's write path into a cloud conversation's transcript.
 *
 * The conversation's Durable Object owns the transcript; desktop is one more
 * writer into it, exactly like the web and the phone. This module is that
 * writer: it posts locally-produced rows to `POST /conversations/:id/journal`
 * over the signed-in user's own Convex identity, so the DO can check the
 * owner before it appends anything.
 *
 * What this deliberately is NOT: a mirror. Nothing calls `append` yet. There
 * is no existing binding in the tree between a local runtime turn and a cloud
 * `conversationId`, and inventing one would make desktop's local SQLite a
 * second authority for cloud conversations — the exact thing the DO-resident
 * transcript exists to prevent. The surface ships; the trigger is a product
 * decision, and `RunnerState.cloudConversationId` is where it will land.
 *
 * Exactly-once across an offline stretch comes from the server, not from here:
 * `deviceId` + `localTurnId` + ordinal is the DO's idempotency key, so
 * replaying a queued append after hours offline is a no-op rather than a
 * duplicate.
 */

export type CloudTranscriptRecord =
  | {
      kind: "message";
      role: "user" | "assistant" | "toolResult";
      /** A serialized `AgentMessage`, the same shape the cloud loop stores. */
      payloadJson: string;
      /** Render flag: model context without a bubble. */
      hidden?: boolean;
    }
  | {
      kind: "turn";
      phase: "started" | "completed" | "failed" | "canceled" | "timeout";
      /** User-facing text for a non-completed phase. Never a raw error. */
      notice?: string;
    };

export type CloudTranscriptAppend = {
  conversationId: string;
  /** Stable per local turn. Replaying the same id can never duplicate rows. */
  localTurnId: string;
  records: CloudTranscriptRecord[];
};

export type CloudTranscriptWriterOptions = {
  deviceId: string;
  /** The runtime's Convex JWT, or null while signed out. */
  getAuthToken: () => string | null;
  /** Builder origin from Convex, or null when realtime is not configured. */
  getBaseUrl: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  onLog?: (
    level: "info" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
};

export type CloudTranscriptWriter = {
  /** Queues an append. Resolves when it has been accepted or given up on. */
  append: (request: CloudTranscriptAppend) => Promise<void>;
  /** Rows still waiting to reach the cloud. */
  pending: () => number;
  /** Drops the queue and stops retrying (worker shutdown). */
  stop: () => void;
};

/** Server caps, mirrored so an oversized append fails here with a reason. */
const APPEND_MAX_ROWS = 256;
const APPEND_MAX_BYTES = 4 * 1024 * 1024;
/** Queue depth. Beyond this the oldest entry is dropped with a log. */
const MAX_QUEUED_APPENDS = 64;
/** An append older than this is stale enough that landing it is not worth it. */
const MAX_APPEND_AGE_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 60_000;
/** A cloud turn is running; wait for the boundary rather than splicing rows. */
const TURN_BUSY_RETRY_MS = 3_000;

type QueueEntry = {
  request: CloudTranscriptAppend;
  queuedAtMs: number;
  attempts: number;
  resolve: () => void;
};

const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });

export const createCloudTranscriptWriter = (
  options: CloudTranscriptWriterOptions,
): CloudTranscriptWriter => {
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.onLog ?? (() => {});
  const queue: QueueEntry[] = [];
  const stopController = new AbortController();
  let draining = false;

  const drop = (entry: QueueEntry, reason: string): void => {
    log("error", "cloud_transcript_append_dropped", {
      conversationId: entry.request.conversationId,
      localTurnId: entry.request.localTurnId,
      attempts: entry.attempts,
      reason,
    });
    entry.resolve();
  };

  const backoffMs = (entry: QueueEntry): number =>
    Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(entry.attempts, 7));

  /**
   * One attempt. Returns how long to wait before retrying, or `null` when the
   * entry is finished — landed, or failed in a way retrying cannot fix.
   */
  const attempt = async (entry: QueueEntry): Promise<number | null> => {
    const token = options.getAuthToken();
    if (!token) return BASE_RETRY_MS * 8;
    const baseUrl = await options.getBaseUrl();
    if (!baseUrl) return BASE_RETRY_MS * 8;

    const url = `${baseUrl.replace(/\/+$/, "")}/conversations/${encodeURIComponent(
      entry.request.conversationId,
    )}/journal`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          deviceId: options.deviceId,
          localTurnId: entry.request.localTurnId,
          records: entry.request.records,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Offline, DNS, TLS, timeout. All of these are "try again later".
      return backoffMs(entry);
    }

    if (response.ok) {
      entry.resolve();
      return null;
    }
    if (response.status === 409) {
      // A cloud turn is mid-reply. The DO refuses rather than splicing rows
      // between a tool call and its result; waiting is the correct answer.
      return TURN_BUSY_RETRY_MS;
    }
    if (response.status === 429 || response.status === 503) {
      return backoffMs(entry);
    }
    if (response.status === 401 || response.status === 403) {
      // A refreshed token may fix 401; 403 means this device's owner does not
      // own the conversation, which retrying will never change.
      if (response.status === 403) {
        drop(entry, "forbidden");
        return null;
      }
      return backoffMs(entry);
    }
    // 400, 410, 413 and anything else: the request itself is the problem.
    drop(entry, `http_${response.status}`);
    return null;
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !stopController.signal.aborted) {
        const entry = queue[0]!;
        if (Date.now() - entry.queuedAtMs > MAX_APPEND_AGE_MS) {
          queue.shift();
          drop(entry, "stale");
          continue;
        }
        entry.attempts += 1;
        const retryInMs = await attempt(entry);
        if (retryInMs === null) {
          queue.shift();
          continue;
        }
        await sleep(retryInMs, stopController.signal);
      }
    } finally {
      draining = false;
    }
    // A record queued while the loop was finishing must not sit forever.
    if (queue.length && !stopController.signal.aborted) void drain();
  };

  return {
    append: (request) => {
      if (stopController.signal.aborted) return Promise.resolve();
      if (!request.records.length) return Promise.resolve();
      if (request.records.length > APPEND_MAX_ROWS) {
        log("error", "cloud_transcript_append_rejected", {
          conversationId: request.conversationId,
          rows: request.records.length,
          reason: "too_many_rows",
        });
        return Promise.resolve();
      }
      if (jsonBytes(request.records) > APPEND_MAX_BYTES) {
        log("error", "cloud_transcript_append_rejected", {
          conversationId: request.conversationId,
          reason: "too_large",
        });
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        if (queue.length >= MAX_QUEUED_APPENDS) {
          const evicted = queue.shift();
          if (evicted) drop(evicted, "queue_full");
        }
        queue.push({ request, queuedAtMs: Date.now(), attempts: 0, resolve });
        void drain();
      });
    },
    pending: () => queue.length,
    stop: () => {
      stopController.abort();
      while (queue.length) {
        const entry = queue.shift();
        if (entry) entry.resolve();
      }
    },
  };
};
