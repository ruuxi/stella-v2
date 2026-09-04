/**
 * The typed client a resident general-agent turn talks to.
 *
 * A resident turn has no executor process, so the calls the container path
 * makes over the turn broker are made here directly. Every one of them is
 * already load-bearing somewhere in `index.ts` or `orchestrator-session.ts`;
 * this module is where a resident turn reaches them without importing either.
 *
 * Only one of them is still a Convex call. The thread transcript and the turn
 * event stream belong to the `BuildSession` now — the transcript lives in its
 * SQLite and the events leave through the outbox — so both arrive here as
 * injected callbacks rather than HTTP. What remains synchronous is web search,
 * which only the control plane can answer, and it authenticates with this
 * turn's control-plane capability rather than the worker's shared secret.
 */

import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";
import { normalizeSafePublicUrl } from "@stella/runtime/kernel/tools/url-guard.js";
import { fetchReadableText } from "@stella/runtime/kernel/tools/web-fetch-core.js";
import {
  containsSecretLikeToken,
  sanitizeToolVisibleText,
} from "@stella/runtime/kernel/tools/safety.js";
import type { SealedTurnTranscript } from "./agent-turn-journal.js";
import { nativeHistoryCursorFromRows } from "./native-state-checkpoint.js";

const CALLBACK_TIMEOUT_MS = 30_000;

export type CanonicalTranscriptReceipt = Readonly<{
  kind: "canonical_transcript";
  historyCursor: string;
  rowCount: number;
}>;

export type AgentControlPlaneIdentity = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
  sessionId: string;
}>;

export type WebToolRequest = Readonly<{
  query?: string;
  url?: string;
  category?: string;
  prompt?: string;
}>;

export type WebToolDetails =
  | Readonly<{ mode: "fetch"; url: string }>
  | Readonly<{ mode: "search"; query: string; text: string }>;

export interface GeneralAgentControlPlane {
  loadAuthoritativeHistory(options: {
    excludeCurrentTurn: boolean;
    signal?: AbortSignal;
  }): Promise<AgentHistoryRow[]>;
  appendAndVerifyTranscript(
    sealed: SealedTurnTranscript,
    options?: { signal?: AbortSignal },
  ): Promise<CanonicalTranscriptReceipt>;
  emit(args: {
    seq: number | "auto";
    kind: string;
    payload: unknown;
    terminal?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  web(
    request: WebToolRequest,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<WebToolDetails>>;
}

export class AgentControlPlaneError extends Error {
  constructor(
    readonly path: string,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `Convex callback ${path} did not return a response.`
        : `Convex callback ${path} failed with ${status}.`,
    );
    this.name = "AgentControlPlaneError";
  }
}

export class TranscriptNotCanonicalError extends Error {
  constructor() {
    super("Resident agent transcript was not canonical.");
    this.name = "TranscriptNotCanonicalError";
  }
}

const boundedSignal = (signal?: AbortSignal): AbortSignal =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(CALLBACK_TIMEOUT_MS)])
    : AbortSignal.timeout(CALLBACK_TIMEOUT_MS);

/**
 * The transcript and event transports the owning `BuildSession` supplies.
 * They are injected rather than implemented here because both are now that
 * object's own state: the rows live in its SQLite, and the events leave
 * through its outbox with a DO-assigned ordinal.
 */
export type AgentControlPlaneTransport = Readonly<{
  /** This thread's rows, oldest first, excluding the current turn on request. */
  readHistory(options: { excludeCurrentTurn: boolean }): AgentHistoryRow[];
  /** Commit transcript rows and project them. Idempotent on (turn, ordinal). */
  appendMessages(
    messages: ReadonlyArray<{
      ordinal: number;
      role: string;
      payloadJson: string;
    }>,
  ): Promise<void>;
  /** One turn event; `"auto"` takes the next DO-assigned ordinal. */
  emitEvent(args: {
    seq: number | "auto";
    kind: string;
    payload: unknown;
    terminal: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
}>;

export const createAgentControlPlane = (deps: {
  /** Convex site origin for the one route that is still a Convex call. */
  convexSiteUrl: string;
  /** This turn's control-plane capability. Never leaves the Durable Object. */
  capability: string | (() => Promise<string>);
  identity: AgentControlPlaneIdentity;
  storage: DurableObjectStorage;
  transport: AgentControlPlaneTransport;
  fetch?: typeof fetch;
}): GeneralAgentControlPlane => {
  const base = deps.convexSiteUrl.replace(/\/+$/u, "");
  const send = deps.fetch ?? fetch;
  const capability = async (): Promise<string> =>
    typeof deps.capability === "string"
      ? deps.capability
      : await deps.capability();

  const convexCall = async (
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await capability()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...body,
          ownerId: deps.identity.ownerId,
          ownerGeneration: deps.identity.ownerGeneration,
        }),
        signal: boundedSignal(signal),
      });
    } catch {
      throw new AgentControlPlaneError(path);
    }
    if (!response.ok) {
      throw new AgentControlPlaneError(path, response.status);
    }
    return await response
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
  };

  const loadAuthoritativeHistory = async (options: {
    excludeCurrentTurn: boolean;
    signal?: AbortSignal;
  }): Promise<AgentHistoryRow[]> => {
    options.signal?.throwIfAborted();
    if (!deps.identity.threadId) return [];
    return deps.transport.readHistory({
      excludeCurrentTurn: options.excludeCurrentTurn,
    });
  };

  /**
   * Commit, then verify. The rows are the authority, so "canonical" means
   * "what this thread's table says after the append" — the same check the
   * Convex round trip used to make, minus the round trip. A retry that
   * changed the batch would commit a different transcript than the one the
   * cursor was computed from, which is the failure this ordering prevents.
   */
  const appendAndVerifyTranscript = async (
    sealed: SealedTurnTranscript,
    options?: { signal?: AbortSignal },
  ): Promise<CanonicalTranscriptReceipt> => {
    options?.signal?.throwIfAborted();
    await deps.transport.appendMessages(
      sealed.rows.map((row) => ({
        ordinal: row.ordinal,
        role: row.role,
        payloadJson: row.payloadJson,
      })),
    );
    const canonicalRows = await loadAuthoritativeHistory({
      excludeCurrentTurn: false,
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const canonicalCursor = await nativeHistoryCursorFromRows(canonicalRows);
    if (canonicalCursor !== sealed.historyCursor) {
      throw new TranscriptNotCanonicalError();
    }
    return {
      kind: "canonical_transcript",
      historyCursor: canonicalCursor,
      rowCount: sealed.rows.length,
    };
  };

  return {
    loadAuthoritativeHistory,
    appendAndVerifyTranscript,
    emit: async (args) => {
      await deps.transport.emitEvent({
        seq: args.seq,
        kind: args.kind,
        payload: args.payload,
        terminal: args.terminal ?? false,
        ...(args.signal ? { signal: args.signal } : {}),
      });
    },
    // The desktop `web` tool's fetch pipeline, with per-redirect-hop SSRF
    // re-validation. workerd has no resolver hook, so the guard runs
    // literal-only; Cloudflare's egress policy backstops rebinding names.
    web: async (request, signal) => {
      const query = request.query?.trim() ?? "";
      const url = request.url?.trim() ?? "";
      if (!query && !url) throw new Error("Either query or url is required.");
      if (query && url) throw new Error("Pass either query or url, not both.");
      if (url) {
        const prompt = request.prompt?.trim() || undefined;
        const text = await fetchReadableText(
          { url, ...(prompt ? { prompt } : {}) },
          {
            guardUrl: (candidate) => normalizeSafePublicUrl(candidate),
            checkSecretLikeToken: containsSecretLikeToken,
            sanitize: sanitizeToolVisibleText,
            userAgent: "Stella/1.0 (Cloud)",
            ...(signal ? { signal } : {}),
          },
        );
        return {
          content: [{ type: "text", text }],
          details: { mode: "fetch", url },
        };
      }
      const payload = await convexCall(
        "/api/cloud/web-search",
        {
          query,
          ...(request.category?.trim()
            ? { category: request.category.trim() }
            : {}),
        },
        signal,
      );
      const text = typeof payload.text === "string" ? payload.text : "";
      return {
        content: [{ type: "text", text: text || "No results found." }],
        details: { mode: "search", query, text },
      };
    },
  };
};
