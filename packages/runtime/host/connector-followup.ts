import { createHash } from "node:crypto";
import { AGENT_STREAM_EVENT_TYPES } from "@stella/contracts/agent-runtime";
import type { LocalChatUpdatedPayload } from "@stella/contracts/local-chat";
import type { RuntimeAgentEventPayload } from "@stella/contracts/protocol";

export type ConnectorFollowupAction =
  | { type: "ignore" }
  | { type: "clear-target" }
  | { type: "send"; text: string };

export type ConnectorFollowupDelivery = {
  deliveryId: string;
  text: string;
};

const followupDeliveryId = (parts: readonly unknown[]): string =>
  `connector-followup:${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")}`;

/**
 * Cloud-owned turns do not emit canonical assistant rows through local-chat.
 * A spawned-agent completion instead produces one stable terminal run event;
 * project that event directly into the connector follow-up delivery lane.
 */
export const resolveConnectorTerminalFollowup = (
  event: RuntimeAgentEventPayload,
  requestId: string,
): ConnectorFollowupDelivery | null => {
  if (
    event.type !== AGENT_STREAM_EVENT_TYPES.RUN_FINISHED ||
    event.requestId !== requestId ||
    event.responseTarget?.type !== "agent_terminal_notice"
  ) {
    return null;
  }
  const text = event.finalText?.trim() ?? "";
  if (!text) return null;
  return {
    deliveryId: followupDeliveryId([
      "terminal",
      requestId,
      event.runId,
      event.responseTarget.agentId,
      event.responseTarget.terminalState,
      text,
    ]),
    text,
  };
};

export const connectorLocalFollowupDeliveryId = (
  requestId: string,
  eventId: string,
  text: string,
): string => followupDeliveryId(["local", requestId, eventId, text]);

const getEventPayload = (
  event: NonNullable<LocalChatUpdatedPayload["event"]>,
): Record<string, unknown> => {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
};

const getSource = (payload: Record<string, unknown>): string =>
  typeof payload.source === "string" ? payload.source : "";

const getTrimmedString = (
  payload: Record<string, unknown>,
  key: string,
): string => {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
};

export const resolveConnectorFollowupAction = (
  payload: LocalChatUpdatedPayload | null,
): ConnectorFollowupAction => {
  const event = payload?.event;
  if (!event) {
    return { type: "ignore" };
  }

  const eventPayload = getEventPayload(event);
  const source = getSource(eventPayload);

  if (event.type === "user_message") {
    return source === "connector"
      ? { type: "ignore" }
      : { type: "clear-target" };
  }

  if (event.type === "assistant_message") {
    if (source === "connector") {
      return { type: "ignore" };
    }
    const text = getTrimmedString(eventPayload, "text");
    return text ? { type: "send", text } : { type: "ignore" };
  }

  return { type: "ignore" };
};
