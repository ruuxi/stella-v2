/**
 * Starts a scheduled prompt as a turn: through the gate's `submit()` for a
 * named desktop (which runs it in the cloud when that desktop can't take
 * it), or straight on the conversation's orchestrator otherwise, the same
 * service-authenticated start the gate's cloud branch makes.
 */

import { PLACEMENT_PROTOCOL } from "@stella/contracts/turn-plane/placement";
import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
  TURN_TITLE_MAX_CHARS,
  type CloudTurnStartRequest,
} from "@stella/contracts/turn-plane/turn-start";
import { HEADER_CONVERSATION_ID, ORCHESTRATOR_INTERNAL_ORIGIN } from "../build-session/shared/keys.js";
import { HEADER_OWNER } from "../conversation-types.js";
import { HEADER_TURN_AUTH_KIND } from "../turn-start-request.js";
import type { GateHostDependencies } from "./gate-host.js";
import type { ScheduledTurnStart } from "./registry.js";

/**
 * A scheduled start that did not happen. `conversationGone` means the pinned
 * conversation was deleted or belongs elsewhere, so a fresh one should be
 * tried; `retryable` means trying the same start later can help.
 */
export class ScheduledTurnError extends Error {
  readonly retryable: boolean;
  readonly conversationGone: boolean;
  constructor(message: string, options: { retryable: boolean; conversationGone?: boolean }) {
    super(message);
    this.name = "ScheduledTurnError";
    this.retryable = options.retryable;
    this.conversationGone = options.conversationGone ?? false;
  }
}

const startOnDesktop = async (
  deps: GateHostDependencies,
  input: ScheduledTurnStart & { targetDeviceId: string },
): Promise<void> => {
  const result = await deps.submit({
    request: {
      protocol: PLACEMENT_PROTOCOL,
      // Stable per fire, so a retried fire replays instead of running twice.
      idempotencyKey: input.clientMsgId,
      kind: "chat",
      ingress: "schedule",
      subject: "cloud",
      targetMode: "device",
      targetDeviceId: input.targetDeviceId,
      conversationId: input.conversationId,
      requiredCapabilities: ["chat"],
      payload: {
        schemaVersion: 1,
        prompt: input.prompt,
        conversationId: input.conversationId,
        clientMsgId: input.clientMsgId,
      },
    },
    expectedGeneration: input.ownerGeneration,
  });
  if (!result.ok) {
    throw new ScheduledTurnError(result.error.message, { retryable: result.error.retryable });
  }
  const dispatch = result.response.dispatch;
  if (dispatch.state === "blocked" || dispatch.state === "failed") {
    throw new ScheduledTurnError(dispatch.errorMessage ?? "The scheduled run could not be placed.", {
      retryable: true,
    });
  }
};

const startInCloud = async (
  deps: GateHostDependencies,
  input: ScheduledTurnStart,
): Promise<void> => {
  const request: CloudTurnStartRequest = {
    protocol: TURN_PLANE_PROTOCOL,
    clientMsgId: input.clientMsgId,
    prompt: input.prompt,
    lane: "schedule",
    // The prompt is the model's own wake instruction, not the owner's
    // words; the chat surface renders it as the scheduled run it is.
    source: "schedule",
    ...(input.title.trim() ? { title: input.title.trim().slice(0, TURN_TITLE_MAX_CHARS) } : {}),
  };
  const response = await deps.env.ORCHESTRATOR_SESSIONS.getByName(input.conversationId).fetch(
    `${ORCHESTRATOR_INTERNAL_ORIGIN}/turn`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER_OWNER]: deps.ownerId(),
        [HEADER_TURN_AUTH_KIND]: "service",
        [HEADER_CONVERSATION_ID]: input.conversationId,
        [TURN_OWNER_GENERATION_HEADER]: input.ownerGeneration,
      },
      body: JSON.stringify(request),
    },
  );
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown; retryable?: unknown };
  } | null;
  const code = typeof body?.error?.code === "string" ? body.error.code : "";
  throw new ScheduledTurnError(
    typeof body?.error?.message === "string"
      ? body.error.message
      : `The scheduled run was refused (${response.status}).`,
    {
      retryable: body?.error?.retryable === true || response.status >= 500,
      conversationGone:
        code === "owner_mismatch" ||
        code === "forbidden" ||
        response.status === 404 ||
        response.status === 410,
    },
  );
};

export const startScheduledTurn = async (
  deps: GateHostDependencies,
  input: ScheduledTurnStart,
): Promise<void> => {
  const targetDeviceId = input.targetDeviceId?.trim();
  if (targetDeviceId) {
    await startOnDesktop(deps, { ...input, targetDeviceId });
    return;
  }
  await startInCloud(deps, input);
};
