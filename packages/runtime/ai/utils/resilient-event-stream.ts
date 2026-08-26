import { forkCancelableTimeout, sleepWithAbort } from "../effect-runtime.js";
import { isTransientTransportError } from "./retry.js";

export type StreamReconnectPhase = "connect" | "resume";

export type StreamReconnectInfo = {
  attempt: number;
  delayMs: number;
  elapsedMs: number;
  phase: StreamReconnectPhase;
  reason?: string;
};

export type ResilientEventStreamOptions<T> = {
  connect: (
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => AsyncIterable<T> | Promise<AsyncIterable<T>>;
  resume?: (args: {
    runId: string;
    cursor: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => AsyncIterable<T> | Promise<AsyncIterable<T>>;
  getInitialResumeState?: () => { runId: string; cursor: number } | undefined;
  getRunId: (event: T) => string | undefined;
  getSequence: (event: T) => number | undefined;
  isTerminal: (event: T) => boolean;
  /** Abort one physical stream when its active recovery window expires. */
  abortSource?: (source: AsyncIterable<T>, reason: Error) => void;
  signal?: AbortSignal;
  deadlineMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  now?: () => number;
  isRetryable?: (error: unknown) => boolean;
  onReconnect?: (info: StreamReconnectInfo) => void;
};

const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_JITTER_RATIO = 0.2;

class UnexpectedStreamEofError extends Error {
  constructor() {
    super(
      "The response stream ended before a terminal event (unexpected EOF).",
    );
    this.name = "UnexpectedStreamEofError";
  }
}

class StreamCursorGapError extends Error {
  constructor(expected: number, received: number) {
    super(
      `The response stream skipped durable cursor ${expected} and continued at ${received}.`,
    );
    this.name = "StreamCursorGapError";
  }
}

export class StreamReconnectError extends Error {
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly partialResponse: boolean;
  readonly resumable: boolean;

  constructor(args: {
    cause: unknown;
    attempts: number;
    elapsedMs: number;
    partialResponse: boolean;
    resumable: boolean;
  }) {
    const reason = errorMessage(args.cause);
    const elapsed = `${(args.elapsedMs / 1_000).toFixed(1)}s`;
    const attempts = `${args.attempts} safe reconnect attempt${
      args.attempts === 1 ? "" : "s"
    }`;
    const safety =
      args.partialResponse && !args.resumable
        ? " Partial response state was preserved and the request was not replayed because no durable resume cursor was available."
        : "";
    super(
      `Connection recovery failed after ${attempts} over ${elapsed}.${safety} Last transport error: ${reason}`,
    );
    this.name = "StreamReconnectError";
    this.cause = args.cause;
    this.attempts = args.attempts;
    this.elapsedMs = args.elapsedMs;
    this.partialResponse = args.partialResponse;
    this.resumable = args.resumable;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);

const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(
    typeof reason === "string" && reason.trim()
      ? reason
      : "Request was aborted",
  );
  error.name = "AbortError";
  return error;
};

/**
 * Reconnect-delay sleep on the ai/ fiber substrate. Delay values stay data;
 * only the timer and abort-listener lifetime are Effect-owned.
 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  sleepWithAbort(ms, signal, (aborted) => abortError(aborted));

const retryDelay = (args: {
  retryIndex: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  random: () => number;
}): number => {
  const exponential = Math.min(
    args.baseDelayMs * 2 ** args.retryIndex,
    args.maxDelayMs,
  );
  const jitter = 1 + (args.random() * 2 - 1) * args.jitterRatio;
  return Math.max(0, Math.round(exponential * jitter));
};

const validCursor = (value: number | undefined): value is number =>
  Number.isSafeInteger(value) && value !== undefined && value >= 0;

/**
 * Reconnect an event stream without replaying acknowledged application work.
 *
 * A caller may seed a durable run id and cursor before the response body is
 * read (the Stella relay proposes its id on the POST). Once any event has
 * been delivered, this helper will only use `resume`; without a valid durable
 * cursor it fails closed. Duplicate replay events are filtered by cursor and
 * gaps trigger another cursor resume before any out-of-order event is yielded.
 */
export async function* resilientEventStream<T>(
  options: ResilientEventStreamOptions<T>,
): AsyncGenerator<T, void, void> {
  const deadlineMs = Math.max(0, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(
    baseDelayMs,
    options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  );
  const jitterRatio = Math.max(
    0,
    Math.min(1, options.jitterRatio ?? DEFAULT_JITTER_RATIO),
  );
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const isRetryable = options.isRetryable ?? isTransientTransportError;

  let reconnectStartedAt: number | undefined;
  let reconnectAttempts = 0;
  let retryIndex = 0;
  let receivedEvent = false;
  let runId: string | undefined;
  let cursor: number | undefined;
  let lastError: unknown;
  let nextConnection: StreamReconnectPhase = "connect";

  const captureInitialResumeState = () => {
    if (runId !== undefined || cursor !== undefined) return;
    const state = options.getInitialResumeState?.();
    if (!state || !state.runId || !validCursor(state.cursor)) return;
    runId = state.runId;
    cursor = state.cursor;
  };

  const clearRecoveryWindow = () => {
    reconnectStartedAt = undefined;
    reconnectAttempts = 0;
    retryIndex = 0;
    lastError = undefined;
  };

  const beginRecoveryWindow = () => {
    if (reconnectStartedAt !== undefined) return;
    reconnectStartedAt = now();
  };

  const elapsedRecoveryMs = () =>
    reconnectStartedAt === undefined
      ? 0
      : Math.max(0, now() - reconnectStartedAt);

  const canResume = () =>
    Boolean(options.resume) && Boolean(runId) && validCursor(cursor);

  const reconnectError = (cause: unknown): StreamReconnectError =>
    new StreamReconnectError({
      cause,
      attempts: reconnectAttempts,
      elapsedMs: elapsedRecoveryMs(),
      partialResponse: receivedEvent,
      resumable: canResume(),
    });

  for (;;) {
    if (options.signal?.aborted) throw abortError(options.signal);

    let cancelSourceDeadline: (() => void) | undefined;
    let sourceDeadlineExpired = false;
    try {
      const remainingRecoveryMs =
        reconnectStartedAt === undefined
          ? undefined
          : Math.max(0, deadlineMs - elapsedRecoveryMs());
      if (remainingRecoveryMs !== undefined && remainingRecoveryMs <= 0) {
        throw reconnectError(lastError);
      }
      // The adapter applies this to response-header acquisition (for example,
      // an SDK request timeout). Once an iterable exists, the Effect-owned
      // source deadline below covers a stalled response body instead.
      const attemptTimeoutMs =
        remainingRecoveryMs === undefined
          ? undefined
          : Math.max(1, Math.ceil(remainingRecoveryMs));
      const source =
        nextConnection === "resume"
          ? await options.resume!({
              runId: runId!,
              cursor: cursor!,
              ...(options.signal ? { signal: options.signal } : {}),
              ...(attemptTimeoutMs !== undefined
                ? { timeoutMs: attemptTimeoutMs }
                : {}),
            })
          : await options.connect(options.signal, attemptTimeoutMs);
      if (nextConnection === "connect") captureInitialResumeState();

      if (reconnectStartedAt !== undefined && options.abortSource) {
        const remainingMs = Math.max(0, deadlineMs - elapsedRecoveryMs());
        if (remainingMs <= 0) throw reconnectError(lastError);
        cancelSourceDeadline = forkCancelableTimeout(remainingMs, () => {
          sourceDeadlineExpired = true;
          try {
            options.abortSource?.(
              source,
              new Error("Reconnect deadline exhausted"),
            );
          } catch {
            // A source that settled concurrently may reject a redundant abort.
          }
        });
      }

      for await (const event of source) {
        if (options.signal?.aborted) throw abortError(options.signal);
        if (sourceDeadlineExpired) throw reconnectError(lastError);

        const eventRunId = options.getRunId(event);
        if (eventRunId && runId && eventRunId !== runId) {
          throw new Error(
            `The response stream changed durable run id from ${runId} to ${eventRunId}.`,
          );
        }

        const sequence = options.getSequence(event);
        if (sequence !== undefined && !validCursor(sequence)) {
          throw new Error("The response stream returned an invalid cursor.");
        }
        if (sequence !== undefined && cursor !== undefined) {
          if (sequence <= cursor) continue;
          if (sequence !== cursor + 1) {
            throw new StreamCursorGapError(cursor + 1, sequence);
          }
        }

        const recovered = reconnectStartedAt !== undefined;
        receivedEvent = true;
        runId = eventRunId ?? runId;
        if (sequence !== undefined) cursor = sequence;
        const terminal = options.isTerminal(event);
        if (recovered) {
          cancelSourceDeadline?.();
          cancelSourceDeadline = undefined;
          clearRecoveryWindow();
        }
        yield event;
        if (terminal) return;
      }
      throw new UnexpectedStreamEofError();
    } catch (error) {
      cancelSourceDeadline?.();
      if (options.signal?.aborted) throw abortError(options.signal);
      if (sourceDeadlineExpired || elapsedRecoveryMs() >= deadlineMs) {
        throw reconnectError(lastError ?? error);
      }
      if (
        !(error instanceof UnexpectedStreamEofError) &&
        !(error instanceof StreamCursorGapError) &&
        !isRetryable(error)
      ) {
        throw error;
      }

      if (nextConnection === "connect") captureInitialResumeState();
      lastError = error;
      beginRecoveryWindow();
    }

    const resumable = canResume();
    if (receivedEvent && !resumable) {
      // Replaying the POST after any delivered delta could duplicate model or
      // tool work. There is no later source from which a missing cursor can
      // appear, so fail immediately and preserve the partial response.
      throw reconnectError(lastError);
    }
    nextConnection = resumable ? "resume" : "connect";

    const remainingMs = Math.max(0, deadlineMs - elapsedRecoveryMs());
    if (remainingMs <= 0) throw reconnectError(lastError);

    const delayMs = Math.min(
      retryDelay({
        retryIndex,
        baseDelayMs,
        maxDelayMs,
        jitterRatio,
        random,
      }),
      remainingMs,
    );
    try {
      options.onReconnect?.({
        attempt: reconnectAttempts + 1,
        delayMs,
        elapsedMs: elapsedRecoveryMs(),
        phase: nextConnection,
        reason: errorMessage(lastError),
      });
    } catch {
      // Status reporting cannot break recovery.
    }

    try {
      await sleep(delayMs, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal);
      throw reconnectError(lastError ?? error);
    }
    reconnectAttempts += 1;
    retryIndex += 1;
  }
}
