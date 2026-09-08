import type { ChatMessage } from "../types";
import {
  decodeSequencedJournalEntry,
  type JournalRecord,
} from "./cloud-conversation-protocol";
import {
  loadChatSyncState,
  loadCloudJournalCache,
  loadRecentChatMessages,
  saveCloudJournalCache,
  synchronizeChatMessages,
  saveChatSyncState,
} from "./offline-chat-storage";

/**
 * How much of the raw journal tail is kept on disk. It only has to cover what
 * the projection cache paints (the newest transcript window) so the seeded
 * store reproduces that paint exactly; older rows stay reachable through
 * scrollback. Bounded by count and by bytes so a run of large tool payloads
 * cannot turn the launch read into a multi-megabyte parse.
 */
export const JOURNAL_CACHE_MAX_RECORDS = 1_000;
export const JOURNAL_CACHE_MAX_BYTES = 4 * 1024 * 1024;

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
  /** The encoded raw journal tail the last rebuild committed, if any. */
  loadRecords?(): Promise<string | null>;
};

export type CloudConversationCachePort = {
  clearMetadata(): Promise<void>;
  synchronizeMessages(
    messages: ChatMessage[],
    isCurrent: () => boolean,
  ): Promise<void>;
  /** Replaces the raw journal tail; null drops it. */
  synchronizeRecords?(encoded: string | null): Promise<void>;
  saveMetadata(metadata: CloudConversationCacheMetadata): Promise<void>;
};

/** What a cold launch seeds the in-memory journal store with. */
export type CloudJournalSeed = {
  epoch: number;
  headSeq: number;
  floorSeq: number;
  /** Ascending, contiguous, ending exactly at `headSeq`. */
  records: JournalRecord[];
};

/**
 * The newest slice of the retained rows that fits the cache bounds. Returns
 * null when nothing fits or the tail does not reach the head the metadata
 * will claim, so a seed can never be published that the socket would have to
 * repair from its very first frame.
 */
export const encodeCloudJournalTail = (
  records: readonly JournalRecord[],
  headSeq: number,
  limits: { maxRecords?: number; maxBytes?: number } = {},
): string | null => {
  const maxRecords = limits.maxRecords ?? JOURNAL_CACHE_MAX_RECORDS;
  const maxBytes = limits.maxBytes ?? JOURNAL_CACHE_MAX_BYTES;
  if (!records.length || records[records.length - 1]!.seq !== headSeq) {
    return null;
  }
  const encoded: string[] = [];
  let bytes = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (encoded.length >= maxRecords) break;
    const record = records[index]!;
    const expected = headSeq - encoded.length;
    // A hole in the retained rows ends the tail; never persist across it.
    if (record.seq !== expected) break;
    const json = JSON.stringify(record);
    if (bytes + json.length > maxBytes) break;
    bytes += json.length;
    encoded.push(json);
  }
  if (!encoded.length) return null;
  encoded.reverse();
  return `[${encoded.join(",")}]`;
};

export const decodeCloudJournalTail = (
  encoded: string | null | undefined,
): JournalRecord[] | null => {
  if (!encoded) return null;
  try {
    const raw = JSON.parse(encoded) as unknown;
    if (!Array.isArray(raw) || !raw.length) return null;
    const records: JournalRecord[] = [];
    for (const entry of raw) {
      const record = decodeSequencedJournalEntry(entry);
      if (!record) return null;
      const previous = records[records.length - 1];
      if (previous && record.seq !== previous.seq + 1) return null;
      records.push(record);
    }
    return records;
  } catch {
    return null;
  }
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
  /** Retained journal rows the projection was built from. */
  records?: readonly JournalRecord[];
  port: CloudConversationCachePort;
  isCurrent?: () => boolean;
}): Promise<void> => {
  const current = args.isCurrent ?? (() => true);
  if (!current()) return;
  await args.port.clearMetadata();
  if (!current()) return;
  await args.port.synchronizeMessages(args.messages, current);
  if (!current()) return;
  if (args.port.synchronizeRecords) {
    await args.port.synchronizeRecords(
      args.records
        ? encodeCloudJournalTail(args.records, args.metadata.headSeq)
        : null,
    );
    if (!current()) return;
  }
  await args.port.saveMetadata(args.metadata);
};

export const rebuildMobileCloudConversationCache = async (args: {
  metadata: CloudConversationCacheMetadata;
  messages: ChatMessage[];
  records?: readonly JournalRecord[];
  isCurrent?: () => boolean;
}): Promise<void> =>
  rebuildCloudConversationCache({
    ...args,
    port: {
      clearMetadata: () =>
        saveChatSyncState("cloud", { conversationId: null, cursor: null }),
      synchronizeMessages: (messages, current) =>
        synchronizeChatMessages("cloud", messages, current),
      synchronizeRecords: (encoded) => saveCloudJournalCache("cloud", encoded),
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

const mobileCacheReadPort: CloudConversationCacheReadPort = {
  loadMetadata: async () => (await loadChatSyncState("cloud")).cursor,
  loadMessages: async () => (await loadRecentChatMessages("cloud")).messages,
  loadRecords: () => loadCloudJournalCache("cloud"),
};

export const readMobileCloudConversationCache = async (
  authority: CloudConversationCacheAuthority,
): Promise<ChatMessage[] | null> =>
  readCloudConversationCache({ authority, port: mobileCacheReadPort });

/**
 * The raw journal tail the last rebuild committed, for seeding the in-memory
 * store before its socket opens. Metadata commits last, so a matching fence
 * proves the rows beside it were written by the same rebuild; the tail must
 * still end exactly at the metadata's head, or the seed is refused and the
 * socket opens cold. A refused seed costs one newest-window download, never
 * a wrong transcript.
 */
export const readCloudJournalCache = async (args: {
  authority: CloudConversationCacheAuthority;
  port: CloudConversationCacheReadPort;
}): Promise<CloudJournalSeed | null> => {
  if (!args.port.loadRecords) return null;
  const metadata = decodeCloudConversationCacheMetadata(
    await args.port.loadMetadata(),
  );
  if (!metadata || !cloudConversationCacheMatches(metadata, args.authority)) {
    return null;
  }
  const records = decodeCloudJournalTail(await args.port.loadRecords());
  if (!records || records[records.length - 1]!.seq !== metadata.headSeq) {
    return null;
  }
  return {
    epoch: metadata.epoch,
    headSeq: metadata.headSeq,
    floorSeq: metadata.floorSeq,
    records,
  };
};

export const readMobileCloudJournalCache = async (
  authority: CloudConversationCacheAuthority,
): Promise<CloudJournalSeed | null> =>
  readCloudJournalCache({ authority, port: mobileCacheReadPort });
