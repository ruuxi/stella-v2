/**
 * `POST /owners/me/devices/:deviceId/tool-calls` (and `/cancel`): one of the
 * owner's computers runs a file or shell call on another, for an agent whose
 * brain stays on the first (`@stella/agent/host/desktop-execution`). The
 * owner gate relays it exactly as it relays a cloud conversation's calls
 * (`@stella/contracts/turn-plane/device-tools`), with the same checks on
 * every call: the target must be online, ready, and enabled by the owner for
 * work from other devices. The user JWT proves the account; request ids live
 * apart from the cloud's, so neither joins or stops the other's calls.
 */
import {
  DEVICE_TOOL_LIMITS,
  isDeviceToolName,
  type DeviceToolCall,
  type DeviceToolOutcome,
} from "@stella/contracts/turn-plane/device-tools";
import type { Env } from "../build-session/shared/env.js";
import { log } from "../build-session/shared/keys.js";
import type { ConversationCaller } from "../build-session/shared/types.js";

const REQUEST_ID = /^[A-Za-z0-9._:-]+$/u;
/** What a computer's own requests are known by at the gate. */
const OWN_PREFIX = "own:";

const refusal = (status: number, code: Extract<DeviceToolOutcome, { ok: false }>["code"], message: string): Response =>
  Response.json({ ok: false, code, message } satisfies DeviceToolOutcome, {
    status,
    headers: { "cache-control": "no-store" },
  });

const parseCall = (value: unknown): DeviceToolCall | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const call = value as Record<string, unknown>;
  if (call.kind === "describe") return { kind: "describe" };
  if (
    call.kind !== "tool" ||
    !isDeviceToolName(call.toolName) ||
    !call.params ||
    typeof call.params !== "object" ||
    Array.isArray(call.params) ||
    typeof call.callId !== "string" ||
    !call.callId ||
    typeof call.conversationId !== "string" ||
    !call.conversationId ||
    (call.threadId !== undefined && typeof call.threadId !== "string")
  ) {
    return undefined;
  }
  return {
    kind: "tool",
    toolName: call.toolName,
    params: call.params as Record<string, unknown>,
    callId: call.callId,
    conversationId: call.conversationId,
    ...(typeof call.threadId === "string" ? { threadId: call.threadId } : {}),
  };
};

export const handleDeviceToolRoute = async (
  request: Request,
  env: Env,
  deviceId: string,
  caller: ConversationCaller,
  op: "call" | "cancel",
): Promise<Response> => {
  if (caller.isAnonymous) return refusal(401, "bad_request", "Sign in to reach your computers.");
  let body: { requestId?: unknown; call?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return refusal(400, "bad_request", "Malformed JSON request.");
  }
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!requestId || requestId.length > DEVICE_TOOL_LIMITS.requestId - OWN_PREFIX.length || !REQUEST_ID.test(requestId)) {
    return refusal(400, "bad_request", "A request id is required.");
  }
  const gate = env.OWNER_GATES.getByName(caller.ownerId);
  const scoped = `${OWN_PREFIX}${requestId}`;
  if (op === "cancel") {
    await gate.cancelDeviceTool({ requestId: scoped });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }
  const call = parseCall(body.call);
  if (!call) return refusal(400, "bad_request", "Malformed tool call.");
  if (JSON.stringify(call).length > DEVICE_TOOL_LIMITS.callBytes) return refusal(413, "too_large", "The call is too large.");
  const started = Date.now();
  // The RPC stub types a result's free-form details as unknown; it is the outcome as sent.
  const outcome = (await gate.deviceTool({ deviceId, requestId: scoped, call })) as DeviceToolOutcome;
  log("info", "device_tool_from_device", {
    deviceId,
    kind: call.kind,
    ok: outcome.ok,
    ...(outcome.ok ? {} : { code: outcome.code }),
    ms: Date.now() - started,
  });
  return Response.json(outcome, { headers: { "cache-control": "no-store" } });
};
