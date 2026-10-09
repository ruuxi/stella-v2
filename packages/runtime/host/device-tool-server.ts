/**
 * This computer's half of a cloud agent's tool call, relayed by the owner
 * gate over the presence socket (`@stella/contracts/turn-plane/device-tools`).
 *
 * The runtime runs the call with its own tool host; this module frames it:
 * `tool.accepted` at once, then one `tool.result` or `tool.error`. A call
 * sent again under the same request id (the gate resends what is pending
 * when this computer reconnects, and a replayed call reuses its id) is
 * answered from the run it already has, finished or not, so nothing runs
 * twice and a result sent while the socket was down is not lost. A resent
 * call this computer has no run of (its Stella restarted mid-call, or the
 * call never arrived) fails: it may have partly run, and only the agent can
 * judge running it again.
 */

import { Cause, Deferred, Effect, Exit } from "effect";
import {
  DEVICE_TOOL_LIMITS,
  isDeviceToolName,
  type DeviceToolCall,
  type DeviceToolDescription,
  type DeviceToolDeviceFrame,
  type DeviceToolResult,
} from "@stella/contracts/turn-plane/device-tools";
import { hostRuntime } from "./effect-runtime.js";

export type RunDeviceTool = (
  call: DeviceToolCall,
  signal: AbortSignal,
) => Promise<DeviceToolResult | DeviceToolDescription>;

/** How long a finished call's answer is kept for a resend of it. */
const ANSWER_TTL_MS = 10 * 60_000;
const MAX_KEPT_ANSWERS = 64;

type Answer = Extract<DeviceToolDeviceFrame, { type: "tool.result" | "tool.error" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * A result small enough for one presence frame: images go first, then the
 * text is cut, each saying so.
 */
const fitted = (result: DeviceToolResult): string => {
  let json = JSON.stringify(result);
  if (bytes(json) <= DEVICE_TOOL_LIMITS.resultBytes) return json;
  const withoutImages: DeviceToolResult = {
    ...result,
    images: [],
    text: `${result.text}${result.images?.length ? "\n\n[The image was too large to send from this computer to the cloud.]" : ""}`,
  };
  delete withoutImages.details;
  json = JSON.stringify(withoutImages);
  if (bytes(json) <= DEVICE_TOOL_LIMITS.resultBytes) return json;
  const room = Math.max(0, DEVICE_TOOL_LIMITS.resultBytes - 4_096);
  const text = Buffer.from(withoutImages.text, "utf8").subarray(0, room).toString("utf8");
  return JSON.stringify({
    text: `${text}\n\n[Output cut: it was over ${DEVICE_TOOL_LIMITS.resultBytes} bytes, more than a call can bring back to the cloud. Write large output to a file and read it in parts.]`,
    ...(withoutImages.isError ? { isError: true } : {}),
  });
};

export class DeviceToolServer {
  /** Running calls, by request id: each one's stop. */
  private readonly running = new Map<string, () => void>();
  private readonly answers = new Map<string, { frame: Answer; at: number }>();

  constructor(
    private readonly options: {
      run: RunDeviceTool | undefined;
      send: (frame: DeviceToolDeviceFrame) => boolean;
      log: (message: string, error?: unknown) => void;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.();
  }

  /** Every running call stops: the bridge is going away. */
  stopAll(): void {
    for (const stop of this.running.values()) stop();
  }

  /** Take one call without blocking the socket's frame loop. */
  handle(frame: { requestId: string; callJson: string; resume?: true }): void {
    const { requestId } = frame;
    if (typeof requestId !== "string" || !requestId || requestId.length > DEVICE_TOOL_LIMITS.requestId) return;
    this.prune();
    const answered = this.answers.get(requestId);
    if (answered) {
      this.options.send({ type: "tool.accepted", requestId });
      this.options.send(answered.frame);
      return;
    }
    // Still running: it answers when it ends.
    if (this.running.has(requestId)) {
      this.options.send({ type: "tool.accepted", requestId });
      return;
    }
    if (frame.resume) {
      this.options.send({
        type: "tool.error",
        requestId,
        code: "failed",
        message:
          "That computer's connection dropped while the call was on its way or running, and it has no record of the call now (its Stella may have restarted), so the call may have run partly or not at all. Check before running it again.",
      });
      return;
    }
    // A stop interrupts the run, which aborts the signal the call runs under.
    const stopped = Deferred.makeUnsafe<void>();
    this.running.set(requestId, () => {
      Deferred.doneUnsafe(stopped, Effect.void);
    });
    void this.answer(requestId, frame.callJson, stopped)
      .catch((error: unknown) => {
        this.options.log("A cloud agent's tool call could not be answered.", error);
        return {
          type: "tool.error",
          requestId,
          code: "failed",
          message: error instanceof Error ? error.message : String(error),
        } satisfies Answer;
      })
      .then((answer) => {
        this.running.delete(requestId);
        this.answers.set(requestId, { frame: answer, at: this.now() });
        this.options.send(answer);
      });
  }

  private async answer(requestId: string, callJson: string, stopped: Deferred.Deferred<void>): Promise<Answer> {
    const fail = (code: Extract<Answer, { type: "tool.error" }>["code"], message: string): Answer => ({
      type: "tool.error",
      requestId,
      code,
      message,
    });
    const run = this.options.run;
    if (!run) return fail("unsupported", "This computer's Stella can't run tools for the cloud.");
    let call: unknown;
    try {
      call = JSON.parse(callJson);
    } catch {
      call = null;
    }
    const valid =
      isRecord(call) &&
      (call.kind === "describe" ||
        (call.kind === "tool" &&
          isDeviceToolName(call.toolName) &&
          isRecord(call.params) &&
          typeof call.callId === "string" &&
          typeof call.conversationId === "string" &&
          (call.threadId === undefined || typeof call.threadId === "string")));
    if (!valid) return fail("bad_request", "Malformed tool call.");
    this.options.send({ type: "tool.accepted", requestId });
    const exit = await hostRuntime.runPromiseExit(
      Effect.raceFirst(
        Effect.tryPromise({ try: (signal) => run(call as DeviceToolCall, signal), catch: (error) => error }).pipe(
          Effect.map((outcome) => ({ outcome })),
        ),
        Deferred.await(stopped).pipe(Effect.as(undefined)),
      ),
    );
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    if (!exit.value) return fail("canceled", "The call was stopped.");
    const { outcome } = exit.value;
    const resultJson = (call as DeviceToolCall).kind === "describe" ? JSON.stringify(outcome) : fitted(outcome as DeviceToolResult);
    return { type: "tool.result", requestId, resultJson };
  }

  private prune(): void {
    const cutoff = this.now() - ANSWER_TTL_MS;
    for (const [requestId, kept] of this.answers) {
      if (kept.at < cutoff || this.answers.size > MAX_KEPT_ANSWERS) this.answers.delete(requestId);
    }
  }
}
