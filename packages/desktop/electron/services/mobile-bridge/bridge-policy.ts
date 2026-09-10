import {
  MOBILE_BRIDGE_EVENT_CHANNELS,
  MOBILE_BRIDGE_REQUEST_CHANNELS,
} from "./capabilities.js";

/**
 * Sender URL stamped on the synthetic IPC event the bridge hands to shared
 * main-process handlers, so a handler can tell a paired-phone request apart
 * from the desktop renderer without a second registration.
 */
export const MOBILE_BRIDGE_SENDER_URL = "stella-mobile-bridge://mobile";

export const isMobileBridgeIpcEvent = (event: unknown): boolean => {
  const candidate = event as
    | { senderFrame?: { url?: unknown }; sender?: { getURL?: () => unknown } }
    | null
    | undefined;
  if (candidate?.senderFrame?.url === MOBILE_BRIDGE_SENDER_URL) return true;
  try {
    return candidate?.sender?.getURL?.() === MOBILE_BRIDGE_SENDER_URL;
  } catch {
    return false;
  }
};

type MobileBridgeRequestChannel =
  (typeof MOBILE_BRIDGE_REQUEST_CHANNELS)[number];
type MobileBridgeEventChannel = (typeof MOBILE_BRIDGE_EVENT_CHANNELS)[number];

const MOBILE_BRIDGE_REQUEST_CHANNEL_SET = new Set<string>(
  MOBILE_BRIDGE_REQUEST_CHANNELS,
);

const MOBILE_BRIDGE_EVENT_CHANNEL_SET = new Set<string>(
  MOBILE_BRIDGE_EVENT_CHANNELS,
);

export const isMobileBridgeRequestChannel = (
  channel: string,
): channel is MobileBridgeRequestChannel =>
  MOBILE_BRIDGE_REQUEST_CHANNEL_SET.has(channel);

export const isMobileBridgeEventChannel = (
  channel: string,
): channel is MobileBridgeEventChannel =>
  MOBILE_BRIDGE_EVENT_CHANNEL_SET.has(channel);

/** Local-history ids and tab titles must never enter paired-device traffic. */
export const containsPrivateChatData = (value: unknown): boolean => {
  if (typeof value === "string") return value.startsWith("local_");
  if (
    !value ||
    typeof value !== "object" ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  )
    return false;
  if (Array.isArray(value)) return value.some(containsPrivateChatData);
  const record = value as Record<string, unknown>;
  return (
    (typeof record.conversationId === "string" &&
      record.conversationId.startsWith("local_")) ||
    Object.keys(record).some(
      (key) =>
        key === "stella.conversationTabs.v2:local" ||
        key === "stella:private-active-conversation",
    ) ||
    Object.values(record).some(
      (entry) => typeof entry === "object" && containsPrivateChatData(entry),
    )
  );
};
