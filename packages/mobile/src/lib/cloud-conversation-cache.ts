import type { ChatMessage } from "../types";
import {
  clearChatMessages,
  saveChatMessages,
  saveChatSyncState,
} from "./offline-chat-storage";

const CACHE_VERSION = 1;

export type CloudConversationCacheMetadata = {
  version: typeof CACHE_VERSION;
  accountScope: string;
  ownerGeneration: string;
  socketOrigin: string;
  conversationId: string;
  epoch: number;
  headSeq: number;
  floorSeq: number;
};

export type CloudConversationCachePort = {
  clearMetadata(): Promise<void>;
  clearMessages(): Promise<void>;
  saveMessages(messages: ChatMessage[]): Promise<void>;
  saveMetadata(metadata: CloudConversationCacheMetadata): Promise<void>;
};

export const encodeCloudConversationCacheMetadata = (
  metadata: CloudConversationCacheMetadata,
): string => JSON.stringify(metadata);

export const decodeCloudConversationCacheMetadata = (
  value: string | null | undefined,
): CloudConversationCacheMetadata | null => {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (
      raw.version !== CACHE_VERSION ||
      typeof raw.accountScope !== "string" ||
      typeof raw.ownerGeneration !== "string" ||
      typeof raw.socketOrigin !== "string" ||
      typeof raw.conversationId !== "string" ||
      typeof raw.epoch !== "number" ||
      !Number.isSafeInteger(raw.epoch) ||
      typeof raw.headSeq !== "number" ||
      !Number.isSafeInteger(raw.headSeq) ||
      typeof raw.floorSeq !== "number" ||
      !Number.isSafeInteger(raw.floorSeq)
    ) {
      return null;
    }
    return raw as CloudConversationCacheMetadata;
  } catch {
    return null;
  }
};

/**
 * Replaces the local projection only after a complete canonical snapshot is
 * available. Metadata is cleared first and committed last, so a crash can
 * discard the cache but can never make a partial cache look authoritative.
 */
export const rebuildCloudConversationCache = async (args: {
  metadata: CloudConversationCacheMetadata;
  messages: ChatMessage[];
  port: CloudConversationCachePort;
  isCurrent?: () => boolean;
}): Promise<void> => {
  const current = args.isCurrent ?? (() => true);
  if (!current()) return;
  await args.port.clearMetadata();
  if (!current()) return;
  await args.port.clearMessages();
  if (!current()) return;
  await args.port.saveMessages(args.messages);
  if (!current()) return;
  await args.port.saveMetadata(args.metadata);
};

export const rebuildMobileCloudConversationCache = async (args: {
  metadata: CloudConversationCacheMetadata;
  messages: ChatMessage[];
  isCurrent?: () => boolean;
}): Promise<void> =>
  rebuildCloudConversationCache({
    ...args,
    port: {
      clearMetadata: () =>
        saveChatSyncState("cloud", { conversationId: null, cursor: null }),
      clearMessages: () => clearChatMessages("cloud"),
      saveMessages: (messages) => saveChatMessages("cloud", messages),
      saveMetadata: (metadata) =>
        saveChatSyncState("cloud", {
          conversationId: metadata.conversationId,
          cursor: encodeCloudConversationCacheMetadata(metadata),
        }),
    },
  });
