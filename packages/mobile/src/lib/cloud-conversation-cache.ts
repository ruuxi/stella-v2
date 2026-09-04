import type { ChatMessage } from "../types";
import {
  loadChatSyncState,
  loadRecentChatMessages,
  synchronizeChatMessages,
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

export type CloudConversationCacheReadPort = {
  /** The encoded metadata the last rebuild committed, if any. */
  loadMetadata(): Promise<string | null>;
  loadMessages(): Promise<ChatMessage[]>;
};

export type CloudConversationCachePort = {
  clearMetadata(): Promise<void>;
  synchronizeMessages(
    messages: ChatMessage[],
    isCurrent: () => boolean,
  ): Promise<void>;
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
  await args.port.synchronizeMessages(args.messages, current);
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
      synchronizeMessages: (messages, current) =>
        synchronizeChatMessages("cloud", messages, current),
      saveMetadata: (metadata) =>
        saveChatSyncState("cloud", {
          conversationId: metadata.conversationId,
          cursor: encodeCloudConversationCacheMetadata(metadata),
        }),
    },
  });

/** The fence a cached projection must match before it may be shown. */
export type CloudConversationCacheAuthority = Pick<
  CloudConversationCacheMetadata,
  "accountScope" | "ownerGeneration" | "conversationId" | "socketOrigin"
>;

export const cloudConversationCacheMatches = (
  metadata: CloudConversationCacheMetadata,
  authority: CloudConversationCacheAuthority,
): boolean =>
  metadata.accountScope === authority.accountScope &&
  metadata.ownerGeneration === authority.ownerGeneration &&
  metadata.conversationId === authority.conversationId &&
  metadata.socketOrigin === authority.socketOrigin;

/**
 * Reads the projection the last rebuild committed, for painting a returning
 * user's transcript before the journal socket reconnects. Metadata commits
 * last during a rebuild, so its presence proves the rows beside it are a
 * complete canonical snapshot; a fence mismatch (another account, an owner
 * reset, a different deployment) or an empty snapshot yields nothing rather
 * than a wrong or blank-then-filled transcript.
 */
export const readCloudConversationCache = async (args: {
  authority: CloudConversationCacheAuthority;
  port: CloudConversationCacheReadPort;
}): Promise<ChatMessage[] | null> => {
  const metadata = decodeCloudConversationCacheMetadata(
    await args.port.loadMetadata(),
  );
  if (!metadata || !cloudConversationCacheMatches(metadata, args.authority)) {
    return null;
  }
  const messages = await args.port.loadMessages();
  return messages.length > 0 ? messages : null;
};

export const readMobileCloudConversationCache = async (
  authority: CloudConversationCacheAuthority,
): Promise<ChatMessage[] | null> =>
  readCloudConversationCache({
    authority,
    port: {
      loadMetadata: async () => (await loadChatSyncState("cloud")).cursor,
      loadMessages: async () =>
        (await loadRecentChatMessages("cloud")).messages,
    },
  });
