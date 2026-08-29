/**
 * The typed worker-to-Convex client a resident general-agent turn talks to.
 *
 * A resident turn has no executor process, so the calls the container path
 * makes over the turn broker are made here directly. Every one of them is
 * already load-bearing somewhere in `index.ts` or `orchestrator-session.ts`;
 * this module is where a resident turn reaches them without importing either.
 *
 * Two different credentials, deliberately. History and events authenticate as
 * this worker (`BUILDER_SERVICE_SECRET`) and carry a hash of the turn token so
 * Convex can resolve the exact attempt transactionally. The transcript append
 * presents the raw turn token, because that route's authority is the attempt's,
 * not the worker's.
 */

import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";
import { AGENT_HISTORY_MAX_ROWS } from "@stella/executor-cloud/agent-history";
import { normalizeSafePublicUrl } from "@stella/runtime/kernel/tools/url-guard.js";
import { fetchReadableText } from "@stella/runtime/kernel/tools/web-fetch-core.js";
import {
  containsSecretLikeToken,
  sanitizeToolVisibleText,
} from "@stella/runtime/kernel/tools/safety.js";
import type { TurnBrokerInteriorBuildRequest } from "@stella/contracts/turn-credential-broker";
import type { SealedTurnTranscript } from "./agent-turn-journal.js";
import { sha256Hex } from "./hash.js";
import {
  interiorBuildRequestKey,
  interiorBuildRequestRecord,
} from "./interior-build-request.js";
import { nativeHistoryCursorFromRows } from "./native-state-checkpoint.js";

const HISTORY_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
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
  recordInteriorBuildRequest(
    request: TurnBrokerInteriorBuildRequest,
    now: number,
  ): Promise<void>;
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

const isHistoryRow = (row: unknown): row is AgentHistoryRow =>
  Boolean(row) &&
  typeof row === "object" &&
  !Array.isArray(row) &&
  typeof (row as AgentHistoryRow).seq === "number" &&
  typeof (row as AgentHistoryRow).role === "string" &&
  typeof (row as AgentHistoryRow).payloadJson === "string" &&
  typeof (row as AgentHistoryRow).turnId === "string";

export const createAgentControlPlane = (deps: {
  convexCallbackBase: string;
  serviceSecret: string;
  turnToken: string;
  identity: AgentControlPlaneIdentity;
  storage: DurableObjectStorage;
  fetch?: typeof fetch;
}): GeneralAgentControlPlane => {
  const base = deps.convexCallbackBase.replace(/\/+$/u, "");
  const send = deps.fetch ?? fetch;

  const serviceCall = async (
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deps.serviceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...body,
          ownerId: deps.identity.ownerId,
          ownerGeneration: deps.identity.ownerGeneration,
          tokenHash: await sha256Hex(deps.turnToken),
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
    if (!deps.identity.threadId) return [];
    const url = new URL(`${base}/api/cloud/context`);
    url.searchParams.set("conversationId", deps.identity.threadId);
    url.searchParams.set("ownerId", deps.identity.ownerId);
    url.searchParams.set("ownerGeneration", deps.identity.ownerGeneration);
    if (options.excludeCurrentTurn) {
      url.searchParams.set("excludeTurnId", deps.identity.turnId);
    }
    const response = await send(url, {
      headers: { authorization: `Bearer ${deps.serviceSecret}` },
      signal: boundedSignal(options.signal),
    });
    if (!response.ok) {
      throw new AgentControlPlaneError(
        "/api/cloud/context",
        response.status,
      );
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > HISTORY_RESPONSE_MAX_BYTES) {
      throw new AgentControlPlaneError("/api/cloud/context");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new AgentControlPlaneError("/api/cloud/context");
    }
    const messages =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { messages?: unknown }).messages
        : undefined;
    if (
      !Array.isArray(messages) ||
      messages.length > AGENT_HISTORY_MAX_ROWS ||
      !messages.every(isHistoryRow)
    ) {
      throw new AgentControlPlaneError("/api/cloud/context");
    }
    return messages;
  };

  /**
   * The exact bytes are posted, retried once unchanged, and then verified
   * against what Convex says is canonical. A retry that changed the batch
   * could commit a different transcript than the one the cursor was computed
   * from, which is the failure this ordering exists to prevent.
   */
  const appendAndVerifyTranscript = async (
    sealed: SealedTurnTranscript,
    options?: { signal?: AbortSignal },
  ): Promise<CanonicalTranscriptReceipt> => {
    const body = JSON.stringify({
      conversationId: deps.identity.threadId,
      turnId: deps.identity.turnId,
      messages: sealed.rows.map((row) => ({
        ordinal: row.ordinal,
        role: row.role,
        payloadJson: row.payloadJson,
      })),
    });
    const post = async (): Promise<Response> =>
      await send(`${base}/api/cloud/messages`, {
        method: "POST",
        headers: {
          "x-stella-turn-token": deps.turnToken,
          "content-type": "application/json",
        },
        body,
        signal: boundedSignal(options?.signal),
      });
    let response = await post();
    if (!response.ok) response = await post();
    if (!response.ok) {
      throw new AgentControlPlaneError(
        "/api/cloud/messages",
        response.status,
      );
    }
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
      await serviceCall(
        "/api/cloud/events",
        {
          turnId: deps.identity.turnId,
          attemptGeneration: deps.identity.attemptGeneration,
          sessionId: deps.identity.sessionId,
          seq: args.seq,
          kind: args.kind,
          payload: args.payload,
          terminal: args.terminal ?? false,
        },
        args.signal,
      );
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
      const payload = await serviceCall(
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
    recordInteriorBuildRequest: async (request, now) => {
      await deps.storage.put(
        interiorBuildRequestKey(
          deps.identity.turnId,
          deps.identity.attemptGeneration,
        ),
        interiorBuildRequestRecord({
          request,
          turnId: deps.identity.turnId,
          attemptGeneration: deps.identity.attemptGeneration,
          now,
        }),
      );
    },
  };
};
