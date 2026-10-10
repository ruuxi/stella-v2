/**
 * The owner gate's half of a cloud agent's tool call on one of the owner's
 * computers (`packages/contracts/turn-plane/device-tools.ts`).
 *
 * The conversation object's RPC stays open while the computer runs the call;
 * the computer's one result frame settles it. Nothing is stored: pending
 * calls live in memory, which is sound because the open RPC keeps this
 * Durable Object resident, and if the object goes away the RPC fails with it.
 *
 * A computer whose socket drops is given a short grace to come back (it
 * reconnects to present a fresh token, or after a blip). Its new socket is
 * sent each pending call again, to resume only: the computer answers from
 * the run it has, and fails a call it no longer knows (its Stella restarted)
 * rather than starting it, so nothing runs twice and nothing finished is
 * lost.
 */

import {
  DEVICE_TOOL_ACCEPT_TIMEOUT_MS,
  DEVICE_TOOL_LIMITS,
  DEVICE_TOOL_RECONNECT_GRACE_MS,
  DEVICE_TOOL_RUN_TIMEOUT_MS,
  type DeviceToolCall,
  type DeviceToolDescription,
  type DeviceToolDeviceFrame,
  type DeviceToolErrorCode,
  type DeviceToolOutcome,
  type DeviceToolResult,
  type DeviceToolServerFrame,
} from "@stella/contracts/turn-plane/device-tools";
import { forkAbortTimer } from "@stella/runtime/kernel/tools/effect-runtime.js";

type Pending = {
  requestId: string;
  deviceId: string;
  describe: boolean;
  callJson: string;
  /** The socket it was sent on; null while the computer is reconnecting. */
  socket: WebSocket | null;
  accepted: boolean;
  /** When the call must have finished, once accepted. */
  deadline: number;
  cancelTimer: (() => void) | null;
  /** Every caller waiting on it: a replayed call joins the first. */
  waiters: Array<(outcome: DeviceToolOutcome) => void>;
};

export type DeviceToolRelayHost = {
  /** The device's one proven presence socket, when it is online. */
  liveSocket: (deviceId: string) => WebSocket | null;
  send: (socket: WebSocket, frame: DeviceToolServerFrame) => void;
  log: (level: "info" | "error", event: string, fields: Record<string, unknown>) => void;
};

const OFFLINE_MESSAGE = "That computer went offline before the call finished.";

const ERROR_CODES: ReadonlySet<string> = new Set<DeviceToolErrorCode>([
  "device_offline",
  "not_enabled",
  "not_ready",
  "unsupported",
  "device_busy",
  "timeout",
  "too_large",
  "bad_request",
  "canceled",
  "failed",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A result as the computer sent it, kept to the shape the agent reads. */
const toolResultOf = (value: unknown): DeviceToolResult | null => {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const images = Array.isArray(value.images)
    ? value.images.filter(
        (image): image is { data: string; mimeType: string } =>
          isRecord(image) && typeof image.data === "string" && typeof image.mimeType === "string",
      )
    : [];
  return {
    text: value.text,
    ...(value.isError === true ? { isError: true } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
  };
};

const descriptionOf = (value: unknown): DeviceToolDescription | null => {
  if (!isRecord(value)) return null;
  const text = (field: unknown) => (typeof field === "string" ? field.slice(0, 512) : "");
  const home = text(value.home);
  if (!home) return null;
  return { hostname: text(value.hostname), platform: text(value.platform), home };
};

export class DeviceToolRelay {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly host: DeviceToolRelayHost) {}

  /** Run one call on `deviceId` and resolve with its outcome. Never rejects. */
  async call(input: { deviceId: string; requestId: string; call: DeviceToolCall }): Promise<DeviceToolOutcome> {
    const { deviceId, requestId } = input;
    if (!requestId || requestId.length > DEVICE_TOOL_LIMITS.requestId) {
      return { ok: false, code: "bad_request", message: "Malformed request id." };
    }
    const existing = this.pending.get(requestId);
    if (existing) {
      if (existing.deviceId !== deviceId) {
        return { ok: false, code: "bad_request", message: "That request id is already in use." };
      }
      return await new Promise((resolve) => existing.waiters.push(resolve));
    }
    const socket = this.host.liveSocket(deviceId);
    if (!socket) return { ok: false, code: "device_offline", message: "That computer is offline." };
    let inFlight = 0;
    for (const entry of this.pending.values()) if (entry.deviceId === deviceId) inFlight += 1;
    if (inFlight >= DEVICE_TOOL_LIMITS.concurrentPerDevice) {
      return {
        ok: false,
        code: "device_busy",
        message: `That computer is already running ${inFlight} tool calls. Wait for one to finish.`,
      };
    }
    const callJson = JSON.stringify(input.call);
    if (new TextEncoder().encode(callJson).byteLength > DEVICE_TOOL_LIMITS.callBytes) {
      return {
        ok: false,
        code: "too_large",
        message: `That call's arguments are over ${DEVICE_TOOL_LIMITS.callBytes} bytes, more than one call can carry to a computer. Split it.`,
      };
    }
    return await new Promise<DeviceToolOutcome>((resolve) => {
      const entry: Pending = {
        requestId,
        deviceId,
        describe: input.call.kind === "describe",
        callJson,
        socket,
        accepted: false,
        deadline: 0,
        cancelTimer: null,
        waiters: [resolve],
      };
      this.pending.set(requestId, entry);
      this.arm(entry, DEVICE_TOOL_ACCEPT_TIMEOUT_MS, "unsupported", "That computer did not take the call. Its Stella may be too old to run tools for the cloud; update it and try again.");
      this.host.send(socket, { type: "tool.call", requestId, callJson });
    });
  }

  /** The caller stopped waiting: tell the computer to stop, and settle every waiter. */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (entry.socket) this.host.send(entry.socket, { type: "tool.cancel", requestId });
    this.settle(entry, { ok: false, code: "canceled", message: "The call was stopped." });
  }

  /** A frame from `deviceId`'s presence socket. */
  onFrame(deviceId: string, frame: DeviceToolDeviceFrame): void {
    const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
    const entry = this.pending.get(requestId);
    // A device can only answer what it was sent.
    if (!entry || entry.deviceId !== deviceId) return;
    switch (frame.type) {
      case "tool.accepted": {
        if (!entry.accepted) {
          entry.accepted = true;
          entry.deadline = Date.now() + DEVICE_TOOL_RUN_TIMEOUT_MS;
        }
        this.armRun(entry);
        return;
      }
      case "tool.result": {
        const json = typeof frame.resultJson === "string" ? frame.resultJson : "";
        if (new TextEncoder().encode(json).byteLength > DEVICE_TOOL_LIMITS.resultBytes) {
          this.settle(entry, { ok: false, code: "too_large", message: "That call's result was too large to bring back from the computer." });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          parsed = null;
        }
        if (entry.describe) {
          const description = descriptionOf(parsed);
          this.settle(
            entry,
            description
              ? { ok: true, description }
              : { ok: false, code: "failed", message: "That computer sent a damaged description." },
          );
          return;
        }
        const result = toolResultOf(parsed);
        this.settle(
          entry,
          result ? { ok: true, result } : { ok: false, code: "failed", message: "That computer sent a damaged result." },
        );
        return;
      }
      case "tool.error": {
        const message =
          typeof frame.message === "string" && frame.message.trim()
            ? frame.message.trim().slice(0, 1_000)
            : "That computer could not run the call.";
        const code = ERROR_CODES.has(frame.code) ? frame.code : "failed";
        this.settle(entry, { ok: false, code, message });
        return;
      }
    }
  }

  /** The device's socket closed: its calls wait a short while for it to come back. */
  onDeviceGone(deviceId: string, socket?: WebSocket): void {
    let waiting = 0;
    for (const entry of this.pending.values()) {
      if (entry.deviceId !== deviceId || !entry.socket) continue;
      if (socket && entry.socket !== socket) continue;
      entry.socket = null;
      this.arm(entry, DEVICE_TOOL_RECONNECT_GRACE_MS, "device_offline", OFFLINE_MESSAGE);
      waiting += 1;
    }
    if (waiting > 0) this.host.log("info", "device_tool_awaiting_reconnect", { deviceId, calls: waiting });
  }

  /** The device proved a new socket: its waiting calls are sent again there. */
  onDeviceConnected(deviceId: string, socket: WebSocket): void {
    let resent = 0;
    for (const entry of this.pending.values()) {
      if (entry.deviceId !== deviceId || entry.socket === socket) continue;
      resent += 1;
      entry.socket = socket;
      if (entry.accepted) this.armRun(entry);
      else this.arm(entry, DEVICE_TOOL_ACCEPT_TIMEOUT_MS, "device_offline", OFFLINE_MESSAGE);
      this.host.send(socket, { type: "tool.call", requestId: entry.requestId, callJson: entry.callJson, resume: true });
    }
    if (resent > 0) this.host.log("info", "device_tool_resumed", { deviceId, calls: resent });
  }

  private armRun(entry: Pending): void {
    this.arm(entry, Math.max(0, entry.deadline - Date.now()), "timeout", "The call ran longer than a call on a computer may.");
  }

  private arm(entry: Pending, ms: number, code: DeviceToolErrorCode, message: string): void {
    entry.cancelTimer?.();
    entry.cancelTimer = forkAbortTimer(ms, () => {
      if (entry.socket && code !== "device_offline") {
        this.host.send(entry.socket, { type: "tool.cancel", requestId: entry.requestId });
      }
      this.settle(entry, { ok: false, code, message });
    });
  }

  private settle(entry: Pending, outcome: DeviceToolOutcome): void {
    if (this.pending.get(entry.requestId) !== entry) return;
    entry.cancelTimer?.();
    entry.cancelTimer = null;
    this.pending.delete(entry.requestId);
    if (!outcome.ok) {
      this.host.log("error", "device_tool_failed", {
        deviceId: entry.deviceId,
        code: outcome.code,
        accepted: entry.accepted,
      });
    }
    for (const resolve of entry.waiters) resolve(outcome);
  }
}
