import type { Value } from "convex/values";
import type { ConnectorMediaRef } from "./connector_media_types";

export const CONNECTOR_TURN_PAYLOAD_REF = "connector_turn_payload" as const;

export type ConnectorTurnEventPayloadInput = {
  conversationId: string;
  provider: string;
  deliveryMeta: Record<string, unknown>;
  userMessageId?: string;
};

export type ConnectorTurnPrivatePayloadInput = {
  conversationId: string;
  text: string;
  agentType?: string;
  mediaRefs?: ConnectorMediaRef[];
};

export type ConnectorTurnEventPayload = {
  conversationId: string;
  provider: string;
  deliveryMeta: Value;
  payloadRef: typeof CONNECTOR_TURN_PAYLOAD_REF;
  userMessageId?: string;
};

export type ConnectorTurnPrivatePayload = {
  conversationId: string;
  text: string;
  agentType?: string;
  mediaRefs?: ConnectorMediaRef[];
};

const cloneJsonValue = (value: unknown): Value =>
  JSON.parse(JSON.stringify(value ?? {})) as Value;

export const buildConnectorTurnEventPayload = (
  input: ConnectorTurnEventPayloadInput,
): ConnectorTurnEventPayload => ({
  conversationId: input.conversationId,
  provider: input.provider,
  deliveryMeta: cloneJsonValue(input.deliveryMeta),
  payloadRef: CONNECTOR_TURN_PAYLOAD_REF,
  ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
});

export const buildConnectorTurnPrivatePayload = (
  input: ConnectorTurnPrivatePayloadInput,
): ConnectorTurnPrivatePayload => ({
  conversationId: input.conversationId,
  text: input.text,
  ...(input.agentType ? { agentType: input.agentType } : {}),
  ...(input.mediaRefs ? { mediaRefs: input.mediaRefs } : {}),
});
