/**
 * The typed client a resident general-agent turn talks to.
 *
 * A resident turn has no executor process, so the calls the container path
 * makes over the turn broker are made here directly. Every one of them is
 * already load-bearing somewhere in `index.ts` or `orchestrator-session.ts`;
 * this module is where a resident turn reaches them without importing either.
 *
 * None of them is a control-plane call. The thread transcript and the turn event
 * stream belong to the `BuildSession` — the transcript lives in its SQLite
 * and the owner reads the events it needs — and web search is the owner
 * object's `search.web`, so all three arrive here as injected callbacks.
 */

import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import type { WebSearchResult } from "@stella/contracts/backend/search";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";
import { normalizeSafePublicUrl } from "@stella/runtime/kernel/tools/url-guard.js";
import { fetchReadableText } from "@stella/runtime/kernel/tools/web-fetch-core.js";
import {
  containsSecretLikeToken,
  sanitizeToolVisibleText,
} from "@stella/runtime/kernel/tools/safety.js";
import type { SealedTurnTranscript } from "./agent-turn-journal.js";
import { nativeHistoryCursorFromRows } from "./native-state-checkpoint.js";

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

export class TranscriptNotCanonicalError extends Error {
  constructor() {
    super("Resident agent transcript was not canonical.");
    this.name = "TranscriptNotCanonicalError";
  }
}

/**
 * The transcript and event transports the owning `BuildSession` supplies.
 * They are injected rather than implemented here because both are now that
 * object's own state: the rows live in its SQLite, and the events leave
 * as owner events with a DO-assigned ordinal.
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
  /** The owner's `search.web`, charged to the owner. */
  webSearch(request: { query: string; category?: string }): Promise<WebSearchResult>;
}>;

export const createAgentControlPlane = (deps: {
  identity: AgentControlPlaneIdentity;
  storage: DurableObjectStorage;
  transport: AgentControlPlaneTransport;
}): GeneralAgentControlPlane => {
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
   * old control-plane round trip used to make, minus the round trip. A retry that
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
      signal?.throwIfAborted();
      const category = request.category?.trim();
      const { text } = await deps.transport.webSearch({
        query,
        ...(category ? { category } : {}),
      });
      return {
        content: [{ type: "text", text: text || "No results found." }],
        details: { mode: "search", query, text },
      };
    },
  };
};
