import {
  TURN_BROKER_AUTH_SCHEME,
  TURN_BROKER_HEADERS,
  TURN_BROKER_TURN_STATE_CHECKPOINT_PATH,
  TURN_BROKER_RESPONSE_HEADERS,
  TURN_BROKER_TURN_TOKEN_HEADER,
  TURN_BROKER_VERSION,
  type TurnBrokerCheckpointTranscriptRow,
  type TurnBrokerHandoff,
  type TurnBrokerInput,
  type TurnBrokerNativeStateCheckpoint,
  type TurnBrokerTurnStateCheckpointReceipt,
  type TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import {
  CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER,
  type CloudModelProxyDiagnosticCode,
} from "@stella/contracts/cloud-model-diagnostic";
import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

const MAX_HANDOFF_BYTES = 16 * 1024;
const MAX_HANDOFF_FUTURE_MS = 30 * 60_000 + 10_000;
const MAX_LOCAL_PROXY_BODY_BYTES = 24 * 1024 * 1024;
const MAX_MODEL_RESOLUTION_RESPONSE_BYTES = 64 * 1024;
const MAX_CHECKPOINT_RECEIPT_BYTES = 16 * 1024;
const MAX_SUSPENSION_TRANSCRIPT_ROWS = 1_024;
const MAX_SUSPENSION_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHECKPOINT_REPLAY_TIMEOUT_MS = 30_000;

const HANDOFF_KEYS = [
  "attemptGeneration",
  "capability",
  "endpoint",
  "expiresAt",
  "initialSequence",
  "ownerGeneration",
  "ownerId",
  "sessionId",
  "turnId",
  "version",
] as const;

const boundedText = (value: unknown, max = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const exactKeys = (value: Record<string, unknown>): boolean => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === HANDOFF_KEYS.length &&
    HANDOFF_KEYS.every((key, index) => keys[index] === key)
  );
};

const validEndpoint = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const endpoint = new URL(value);
    const localHttp =
      endpoint.protocol === "http:" &&
      (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost");
    return (
      (endpoint.protocol === "https:" || localHttp) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      /^\/sessions\/[A-Za-z0-9._~%-]{1,512}\/turn-broker$/.test(
        endpoint.pathname,
      ) &&
      !/%(?:2e|2f|5c)/iu.test(endpoint.pathname)
    );
  } catch {
    return false;
  }
};

export const parseTurnBrokerHandoff = (
  value: unknown,
  now = Date.now(),
): TurnBrokerHandoff => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Turn broker handoff is not an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate) ||
    candidate.version !== TURN_BROKER_VERSION ||
    candidate.initialSequence !== 1 ||
    !boundedText(candidate.sessionId) ||
    !boundedText(candidate.ownerId) ||
    !boundedText(candidate.ownerGeneration) ||
    !boundedText(candidate.turnId) ||
    !Number.isSafeInteger(candidate.attemptGeneration) ||
    Number(candidate.attemptGeneration) <= 0 ||
    !validEndpoint(candidate.endpoint) ||
    typeof candidate.capability !== "string" ||
    !CAPABILITY_PATTERN.test(candidate.capability) ||
    !Number.isSafeInteger(candidate.expiresAt) ||
    Number(candidate.expiresAt) <= now ||
    Number(candidate.expiresAt) > now + MAX_HANDOFF_FUTURE_MS
  ) {
    throw new Error("Turn broker handoff is invalid or expired.");
  }
  return candidate as TurnBrokerHandoff;
};

/**
 * Read and unlink the capability before the tool host or a native CLI exists.
 * O_NOFOLLOW prevents an unexpected symlink from redirecting this one read.
 */
export const takeTurnBrokerHandoff = async (
  input: TurnBrokerInput,
  now = Date.now(),
): Promise<TurnBrokerHandoff> => {
  const target = input?.credentialsPath?.trim();
  if (!target || !path.isAbsolute(target) || target.includes("\u0000")) {
    throw new Error("Turn broker credentials path is invalid.");
  }

  let bytes: Buffer | undefined;
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    const currentUid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_HANDOFF_BYTES ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (currentUid !== undefined && metadata.uid !== currentUid)
    ) {
      throw new Error(
        "Turn broker handoff file is not a private bounded regular file.",
      );
    }

    // Remove the pathname while this exact inode is still held open. Failure
    // is fatal: proceeding would leave the reusable capability discoverable.
    await unlink(target);
    bytes = await readBoundedFile(handle, MAX_HANDOFF_BYTES);
  } finally {
    await handle.close();
  }

  if (!bytes) throw new Error("Turn broker handoff file is unavailable.");
  try {
    return parseTurnBrokerHandoff(JSON.parse(bytes.toString("utf8")), now);
  } finally {
    bytes.fill(0);
  }
};

const readBoundedFile = async (
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer> => {
  const scratch = Buffer.alloc(maxBytes + 1);
  let total = 0;
  try {
    while (total < scratch.byteLength) {
      const { bytesRead } = await handle.read(
        scratch,
        total,
        scratch.byteLength - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total <= 0 || total > maxBytes) {
      throw new Error("Turn broker handoff file exceeded its bounded size.");
    }
    return Buffer.from(scratch.subarray(0, total));
  } finally {
    scratch.fill(0);
  }
};

const cleanBrokerRequestHeaders = (value?: RequestInit["headers"]): Headers => {
  const headers = new Headers(value);
  // Bun supplies transport-scoped headers on the incoming loopback request.
  // Reusing them for the public Builder fetch can preserve the localhost Host
  // (and a body framing chosen for the first hop), so the request may be
  // rejected before it reaches the broker Worker. Let fetch synthesize the
  // second hop's authority, framing, compression, and connection metadata.
  for (const name of [
    "accept-encoding",
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  headers.delete("authorization");
  headers.delete("proxy-authorization");
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  headers.delete("cookie");
  headers.delete(TURN_BROKER_TURN_TOKEN_HEADER);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("x-stella-broker-")) {
      headers.delete(name);
    }
  }
  return headers;
};

const targetPath = (value: string): string => {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Turn broker target must be an origin-relative path.");
  }
  return value;
};

export type TurnBrokerFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Turn broker request aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Turn broker request aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const validCheckpoint = (
  checkpoint: TurnBrokerNativeStateCheckpoint,
): boolean => {
  if (!checkpoint || typeof checkpoint !== "object") return false;
  const tree = (checkpoint as { tree?: unknown }).tree;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return false;
  const candidateTree = tree as Record<string, unknown>;
  return (
    checkpoint.engine === "anthropic" &&
    boundedText(checkpoint.sessionId) &&
    boundedText(checkpoint.cursor, 1_024) &&
    candidateTree.algorithm === "sha256" &&
    typeof candidateTree.digest === "string" &&
    /^[0-9a-f]{64}$/.test(candidateTree.digest) &&
    Number.isSafeInteger(candidateTree.entries) &&
    Number(candidateTree.entries) > 0 &&
    Number.isSafeInteger(candidateTree.bytes) &&
    Number(candidateTree.bytes) >= 0 &&
    /^[0-9a-f]{64}$/.test(checkpoint.mac)
  );
};

const readLocalProxyBody = async (request: Request): Promise<Uint8Array> => {
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^[0-9]+$/.test(declared) ||
      Number(declared) > MAX_LOCAL_PROXY_BODY_BYTES)
  ) {
    throw new Error("Local turn broker request body is too large.");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_LOCAL_PROXY_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Local turn broker request body is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const HISTORY_CURSOR_PATTERN = /^(?:v1:empty|v1:[0-9a-f]{64})$/;

const canonicalSuspensionTranscript = (
  value: readonly TurnBrokerCheckpointTranscriptRow[] | undefined,
): TurnBrokerCheckpointTranscriptRow[] | undefined => {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > MAX_SUSPENSION_TRANSCRIPT_ROWS) {
    throw new Error("Suspended turn transcript is invalid.");
  }
  let bytes = 0;
  return value.map((entry, ordinal) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !==
        "ordinal,payloadJson,role" ||
      entry.ordinal !== ordinal ||
      !["user", "assistant", "toolResult"].includes(entry.role) ||
      typeof entry.payloadJson !== "string"
    ) {
      throw new Error("Suspended turn transcript is invalid.");
    }
    bytes += new TextEncoder().encode(entry.payloadJson).byteLength;
    if (bytes > MAX_SUSPENSION_TRANSCRIPT_BYTES) {
      throw new Error("Suspended turn transcript is too large.");
    }
    try {
      const payload = JSON.parse(entry.payloadJson) as unknown;
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        (payload as Record<string, unknown>).role !== entry.role
      ) {
        throw new Error("Suspended turn transcript is invalid.");
      }
    } catch {
      throw new Error("Suspended turn transcript is invalid.");
    }
    return {
      ordinal,
      role: entry.role,
      payloadJson: entry.payloadJson,
    };
  });
};

const canonicalCheckpointRequest = (args: {
  historyCursor: string;
  nativeCheckpoint?: TurnBrokerNativeStateCheckpoint;
  suspensionTranscript?: readonly TurnBrokerCheckpointTranscriptRow[];
}): TurnBrokerTurnStateCheckpointRequest => {
  if (!HISTORY_CURSOR_PATTERN.test(args.historyCursor)) {
    throw new Error("Turn state history cursor is invalid.");
  }
  if (
    args.nativeCheckpoint &&
    (!validCheckpoint(args.nativeCheckpoint) ||
      args.nativeCheckpoint.cursor !== args.historyCursor)
  ) {
    throw new Error("Native state checkpoint is invalid.");
  }
  const suspensionTranscript = canonicalSuspensionTranscript(
    args.suspensionTranscript,
  );
  return {
    schemaVersion: 1,
    historyCursor: args.historyCursor,
    ...(args.nativeCheckpoint
      ? {
          nativeCheckpoint: {
            engine: "anthropic",
            sessionId: args.nativeCheckpoint.sessionId,
            cursor: args.nativeCheckpoint.cursor,
            tree: {
              algorithm: "sha256",
              digest: args.nativeCheckpoint.tree.digest,
              entries: args.nativeCheckpoint.tree.entries,
              bytes: args.nativeCheckpoint.tree.bytes,
            },
            mac: args.nativeCheckpoint.mac,
          },
        }
      : {}),
    ...(suspensionTranscript ? { suspensionTranscript } : {}),
  };
};

const checkpointRequestId = (
  identity: Pick<
    TurnBrokerHandoff,
    "ownerGeneration" | "turnId" | "attemptGeneration"
  >,
  body: string,
): string => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        identity.ownerGeneration,
        identity.turnId,
        identity.attemptGeneration,
        body,
      ]),
    )
    .digest("hex");
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const parseCheckpointReceipt = (
  value: unknown,
  request: TurnBrokerTurnStateCheckpointRequest,
): TurnBrokerTurnStateCheckpointReceipt => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native state checkpoint receipt is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  const expectedKeys = request.nativeCheckpoint
    ? "historyCursor,nativeSha256,operationId,receipt,replayed,schemaVersion,workspaceSha256"
    : "historyCursor,operationId,receipt,replayed,schemaVersion,workspaceSha256";
  if (
    keys.join(",") !== expectedKeys ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.operationId !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.operationId) ||
    candidate.historyCursor !== request.historyCursor ||
    typeof candidate.workspaceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.workspaceSha256) ||
    (request.nativeCheckpoint
      ? typeof candidate.nativeSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(candidate.nativeSha256)
      : candidate.nativeSha256 !== undefined) ||
    typeof candidate.receipt !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.receipt) ||
    typeof candidate.replayed !== "boolean"
  ) {
    throw new Error("Native state checkpoint receipt is invalid.");
  }
  return candidate as TurnBrokerTurnStateCheckpointReceipt;
};

class TerminalBrokerResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalBrokerResponseError";
  }
}

const readBoundedCheckpointReceipt = async (
  response: Response,
  request: TurnBrokerTurnStateCheckpointRequest,
): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TerminalBrokerResponseError(
      `Native state checkpoint was not committed (${response.status}).`,
    );
  }
  const declared = response.headers.get("content-length");
  if (
    declared &&
    (!/^[0-9]+$/.test(declared) ||
      Number(declared) > MAX_CHECKPOINT_RECEIPT_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new TerminalBrokerResponseError(
      "Native state checkpoint receipt exceeded its bounded size.",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        // A transport failure remains replay-safe: it propagates out of this
        // helper and the caller retries the exact sequence/fingerprint.
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_CHECKPOINT_RECEIPT_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new TerminalBrokerResponseError(
            "Native state checkpoint receipt exceeded its bounded size.",
          );
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new TerminalBrokerResponseError(
        "Native state checkpoint receipt is not valid JSON.",
        { cause: error },
      );
    }
    try {
      return parseCheckpointReceipt(value, request);
    } catch (error) {
      throw new TerminalBrokerResponseError(
        "Native state checkpoint receipt is invalid.",
        { cause: error },
      );
    }
  } finally {
    bytes.fill(0);
  }
};

/**
 * Serializes request admission so sequence N+1 cannot arrive before N. Any
 * ambiguous network failure permanently closes the client: availability may
 * be retried as a new attempt, whereas authority replay cannot be repaired.
 */
export class TurnCredentialBrokerClient {
  readonly identity: Omit<TurnBrokerHandoff, "capability">;
  #capability: string;
  #nextSequence: number;
  #fetch: TurnBrokerFetch;
  #tail: Promise<void> = Promise.resolve();
  #closedReason: Error | undefined;
  #activeRequests = new AbortController();

  constructor(handoff: TurnBrokerHandoff, fetchImpl: TurnBrokerFetch = fetch) {
    this.identity = {
      version: handoff.version,
      endpoint: handoff.endpoint,
      expiresAt: handoff.expiresAt,
      initialSequence: handoff.initialSequence,
      sessionId: handoff.sessionId,
      ownerId: handoff.ownerId,
      ownerGeneration: handoff.ownerGeneration,
      turnId: handoff.turnId,
      attemptGeneration: handoff.attemptGeneration,
    };
    this.#capability = handoff.capability;
    this.#nextSequence = handoff.initialSequence;
    this.#fetch = fetchImpl;
  }

  get closed(): boolean {
    return this.#closedReason !== undefined;
  }

  close(reason = new Error("Turn credential broker closed.")): void {
    if (!this.#closedReason) this.#closedReason = reason;
    if (!this.#activeRequests.signal.aborted) {
      this.#activeRequests.abort(this.#closedReason);
    }
    this.#capability = "";
  }

  async fetchTarget(
    target: string,
    init: RequestInit & { method: "POST" | "GET" | "DELETE" },
  ): Promise<Response> {
    return await this.#enqueueRequest<Response>(target, init, {
      requestId: crypto.randomUUID(),
      replaySafe: false,
    });
  }

  async #enqueueRequest<T>(
    target: string,
    init: RequestInit & { method: "POST" | "GET" | "DELETE" },
    options: {
      requestId: string;
      replaySafe: boolean;
      consumeResponse?: (response: Response) => Promise<T>;
    },
  ): Promise<T> {
    const run = this.#tail.then(async () => {
      if (this.#closedReason) throw this.#closedReason;
      if (Date.now() >= this.identity.expiresAt) {
        const expired = new Error("Turn credential broker capability expired.");
        this.close(expired);
        throw expired;
      }

      const method = init.method;
      const pathValue = targetPath(target);
      const sequence = this.#nextSequence;
      const requestSignal = this.#activeRequests.signal;
      const onCallerAbort = () =>
        this.close(
          init.signal?.reason ?? new Error("Turn broker request aborted."),
        );
      if (init.signal?.aborted) onCallerAbort();
      else
        init.signal?.addEventListener("abort", onCallerAbort, { once: true });
      try {
        if (this.#closedReason) throw this.#closedReason;
        const headers = cleanBrokerRequestHeaders(init.headers);
        headers.set(
          "authorization",
          `${TURN_BROKER_AUTH_SCHEME} ${this.#capability}`,
        );
        headers.set(TURN_BROKER_HEADERS.ownerId, this.identity.ownerId);
        headers.set(
          TURN_BROKER_HEADERS.ownerGeneration,
          this.identity.ownerGeneration,
        );
        headers.set(TURN_BROKER_HEADERS.turnId, this.identity.turnId);
        headers.set(
          TURN_BROKER_HEADERS.attemptGeneration,
          String(this.identity.attemptGeneration),
        );
        headers.set(TURN_BROKER_HEADERS.sequence, String(sequence));
        headers.set(TURN_BROKER_HEADERS.requestId, options.requestId);
        headers.set(TURN_BROKER_HEADERS.targetMethod, method);
        headers.set(TURN_BROKER_HEADERS.targetPath, pathValue);

        const retryDeadline = Date.now() + CHECKPOINT_REPLAY_TIMEOUT_MS;
        let delayMs = 25;
        let lastError: unknown;
        while (true) {
          try {
            const response = await this.#fetch(this.identity.endpoint, {
              ...init,
              method,
              headers,
              signal: requestSignal,
              // A Builder redirect must never receive the bearer capability on
              // another origin. The authenticated broker endpoint is exact.
              redirect: "manual",
            });
            if (response.status >= 300 && response.status < 400) {
              await response.body?.cancel().catch(() => undefined);
              throw new TerminalBrokerResponseError(
                "Turn credential broker refused an HTTP redirect.",
              );
            }
            if (
              options.replaySafe &&
              response.headers.has(TURN_BROKER_RESPONSE_HEADERS.replayPending)
            ) {
              await response.body?.cancel().catch(() => undefined);
              if (Date.now() >= retryDeadline) {
                throw new TerminalBrokerResponseError(
                  "Turn credential broker replay remained pending.",
                );
              }
              try {
                await sleep(delayMs, requestSignal);
              } catch (error) {
                lastError = error;
                break;
              }
              delayMs = Math.min(delayMs * 2, 1_000);
              continue;
            }
            const consumed = options.consumeResponse
              ? await options.consumeResponse(response)
              : (response as T);
            this.#nextSequence = sequence + 1;
            if (response.headers.has(TURN_BROKER_RESPONSE_HEADERS.denial)) {
              const denied = new Error(
                `Turn credential broker denied request (${response.status}).`,
              );
              this.close(denied);
            }
            return consumed;
          } catch (error) {
            lastError = error;
            if (
              options.replaySafe &&
              !(error instanceof TerminalBrokerResponseError) &&
              !requestSignal.aborted &&
              Date.now() < retryDeadline
            ) {
              try {
                await sleep(delayMs, requestSignal);
              } catch (sleepError) {
                lastError = sleepError;
                break;
              }
              delayMs = Math.min(delayMs * 2, 1_000);
              continue;
            }
            break;
          }
        }
        const ambiguous = new Error(
          "Turn credential broker response was ambiguous; refusing to reuse its sequence.",
          { cause: lastError },
        );
        this.close(ambiguous);
        throw ambiguous;
      } finally {
        init.signal?.removeEventListener("abort", onCallerAbort);
      }
    });
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  postJson(
    target: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetchTarget(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * The sole replay-safe broker operation. It stages the exact workspace and,
   * for Claude, its root-owned native state before the transcript cursor can
   * become canonical. The deterministic request id and byte-identical body let
   * Builder return the same durable receipt after a lost response.
   */
  async commitTurnStateCheckpoint(
    checkpoint: {
      historyCursor: string;
      nativeCheckpoint?: TurnBrokerNativeStateCheckpoint;
      suspensionTranscript?: readonly TurnBrokerCheckpointTranscriptRow[];
    },
    signal?: AbortSignal,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    const request = canonicalCheckpointRequest(checkpoint);
    const body = JSON.stringify(request);
    return await this.#enqueueRequest<TurnBrokerTurnStateCheckpointReceipt>(
      TURN_BROKER_TURN_STATE_CHECKPOINT_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        ...(signal ? { signal } : {}),
      },
      {
        requestId: checkpointRequestId(this.identity, body),
        replaySafe: true,
        consumeResponse: (response) =>
          readBoundedCheckpointReceipt(response, request),
      },
    );
  }

  /** @deprecated The atomic state operation requires an explicit cursor. */
  async commitNativeStateCheckpoint(
    checkpoint: TurnBrokerNativeStateCheckpoint,
    signal?: AbortSignal,
  ): Promise<TurnBrokerTurnStateCheckpointReceipt> {
    return await this.commitTurnStateCheckpoint(
      { historyCursor: checkpoint.cursor, nativeCheckpoint: checkpoint },
      signal,
    );
  }
}

export type TurnCredentialProxy = {
  origin: string;
  /** Site-shaped base for in-process Stella model adapters. */
  siteBaseUrl: string;
  relayBaseUrl: string;
  /** Random, turn-local bearer accepted only by the loopback proxy. */
  dummyToken: string;
  /** Bounded progress only; never includes request, response, or authority. */
  modelResolutionStage: () =>
    | "idle"
    | "entered"
    | "broker_started"
    | "broker_responded";
  close: () => void;
};

const equalLocalToken = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const validLocalProxyAuthority = (
  headers: Headers,
  localToken: string,
): boolean => {
  const candidates = [
    headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
    headers.get("x-api-key") ?? "",
    headers.get(TURN_BROKER_TURN_TOKEN_HEADER) ?? "",
  ].filter(Boolean);
  return (
    candidates.length > 0 &&
    candidates.every((candidate) => equalLocalToken(candidate, localToken))
  );
};

const localProxyDiagnosticResponse = (
  status: number,
  diagnostic: CloudModelProxyDiagnosticCode,
  error: string,
): Response =>
  Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "no-store",
        [CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER]: diagnostic,
      },
    },
  );

const decodedResponseHeaders = (response: Response): Headers => {
  const headers = new Headers(response.headers);
  // Only this loopback proxy may attest a local failure stage. A public broker
  // response cannot forge the private diagnostic consumed by relay-model.
  headers.delete(CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER);
  // Fetch decodes a compressed public response body but preserves its
  // Content-Encoding header. The buffered bytes are therefore the decoded
  // representation; forwarding that header makes the loopback client attempt
  // a second decompression and fail before it can observe the response.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
};

const bufferedModelResolutionResponse = async (
  response: Response,
): Promise<Response> => {
  const headers = decodedResponseHeaders(response);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > MAX_MODEL_RESOLUTION_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Model resolution response exceeded its bound.");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const streamingRelayResponse = (response: Response): Response =>
  new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: decodedResponseHeaders(response),
  });

const finiteRelayErrorResponse = (response: Response): Response => {
  const headers = decodedResponseHeaders(response);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  // A managed provider relay may publish its error status before its upstream
  // body reaches EOF. Provider SDKs read non-OK bodies before throwing, so
  // forwarding that live stream can prevent the run-level retry envelope from
  // ever observing the failure. Cancel without awaiting (cancellation itself
  // is remote work) and expose only a finite, secret-free provider-shaped body.
  void response.body?.cancel().catch(() => undefined);
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: response.status === 429 ? "rate_limit_error" : "api_error",
        message: `Managed model relay returned HTTP ${response.status}.`,
      },
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
};

/**
 * Native CLIs require a provider-shaped base URL and token. They receive this
 * loopback URL plus a fixed non-authority sentinel; only the parent broker
 * client knows the expiring Builder capability.
 */
export const startTurnCredentialProxy = (
  broker: TurnCredentialBrokerClient,
): TurnCredentialProxy => {
  const localToken = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64url");
  let localOrigin = "";
  let modelResolutionStage: ReturnType<
    TurnCredentialProxy["modelResolutionStage"]
  > = "idle";
  const server = Bun.serve({
    // Cloudflare production sandboxes route container listeners correctly when
    // they bind the container interface. The only advertised client origin is
    // still 127.0.0.1, no port is exposed, and every accepted request must also
    // present the random turn-local token.
    hostname: "0.0.0.0",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const isModelResolution = url.pathname === "/api/stella/cloud-model";
      if (isModelResolution) modelResolutionStage = "entered";
      const requestOrigin = request.headers.get("origin");
      if (
        !localOrigin ||
        url.origin !== localOrigin ||
        (requestOrigin !== null && requestOrigin !== localOrigin)
      ) {
        return localProxyDiagnosticResponse(
          403,
          "model_proxy_reject",
          "Forbidden",
        );
      }
      if (
        !(
          url.pathname === "/api/stella/cloud-model" ||
          url.pathname === "/api/stella/relay" ||
          url.pathname.startsWith("/api/stella/relay/")
        )
      ) {
        return localProxyDiagnosticResponse(
          404,
          "model_proxy_reject",
          "Not found",
        );
      }
      const method = request.method.toUpperCase();
      if (method !== "POST" && method !== "GET" && method !== "DELETE") {
        return localProxyDiagnosticResponse(
          405,
          "model_proxy_reject",
          "Method not allowed",
        );
      }
      if (!validLocalProxyAuthority(request.headers, localToken)) {
        return localProxyDiagnosticResponse(
          401,
          "model_proxy_reject",
          "Unauthorized",
        );
      }
      let body: Uint8Array | undefined;
      if (method !== "GET") {
        try {
          body = await readLocalProxyBody(request);
        } catch {
          return localProxyDiagnosticResponse(
            413,
            "model_proxy_reject",
            "Request body is too large",
          );
        }
      }
      // The loopback request is a transport detail, not turn authority. Some
      // container proxies abort its Request signal as soon as the response is
      // detached; feeding that signal into the broker would revoke the whole
      // one-shot capability before the outbound request even starts. Turn
      // cancellation still closes the proxy and broker through Effect scope.
      if (broker.closed) {
        return localProxyDiagnosticResponse(
          503,
          "model_broker_closed",
          "Turn broker unavailable",
        );
      }
      try {
        if (isModelResolution) modelResolutionStage = "broker_started";
        const response = await broker.fetchTarget(
          `${url.pathname}${url.search}`,
          {
            method,
            headers: request.headers,
            ...(body ? { body } : {}),
          },
        );
        if (isModelResolution) modelResolutionStage = "broker_responded";
        // Model resolution is small and fixed-shape, so buffer it under a hard
        // limit. Provider responses retain their live body stream. Both paths
        // must remove stale compression/framing headers after Bun decodes the
        // public response, or the loopback client attempts decompression twice.
        if (!response.ok) return finiteRelayErrorResponse(response);
        return isModelResolution
          ? await bufferedModelResolutionResponse(response)
          : streamingRelayResponse(response);
      } catch {
        return localProxyDiagnosticResponse(
          502,
          "model_broker_transport",
          "Turn broker request failed",
        );
      }
    },
  });
  // Keep the server referenced for the whole Effect scope. Bun may otherwise
  // stop accepting after a quiet hydration interval before the first model
  // request. The scoped release below always closes it, and the one-shot CLI
  // force-exits after publishing its final result.
  const origin = `http://127.0.0.1:${server.port}`;
  localOrigin = origin;
  return {
    origin,
    siteBaseUrl: origin,
    relayBaseUrl: `${origin}/api/stella/relay`,
    dummyToken: localToken,
    modelResolutionStage: () => modelResolutionStage,
    close: () => {
      server.stop(true);
      broker.close();
    },
  };
};
