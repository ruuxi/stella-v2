import {
  MAX_CLOUD_CONVERSATION_CACHE_RECORDS,
  type CloudConversationCacheAuthority,
  type CloudConversationCacheLifecycleAuthority,
  type CloudConversationCachePurgeResult,
  type CloudConversationCacheReplaceInput,
  type CloudConversationCacheReplaceResult,
  type CloudConversationCacheSnapshot,
  type CloudConversationCacheVersion,
} from "@stella/contracts/cloud-conversation-cache";
import {
  decodeSequencedJournalEntry,
  type JournalRecord,
} from "./conversation-protocol";

export type RenderableCloudConversationCacheSnapshot = Omit<
  CloudConversationCacheSnapshot,
  "records"
> & { records: JournalRecord[] };

export type CloudConversationCacheRendererApi = {
  retainAccount: (
    accountScope: string,
  ) => Promise<CloudConversationCachePurgeResult>;
  activateAuthority: (
    authority: CloudConversationCacheLifecycleAuthority,
  ) => Promise<CloudConversationCachePurgeResult>;
  read: (
    authority: CloudConversationCacheAuthority,
  ) => Promise<CloudConversationCacheSnapshot | null>;
  replace: (
    input: CloudConversationCacheReplaceInput,
  ) => Promise<CloudConversationCacheReplaceResult>;
  purgeConversation: (
    authority: CloudConversationCacheAuthority,
  ) => Promise<CloudConversationCachePurgeResult>;
};

let testApi: CloudConversationCacheRendererApi | undefined;
let operationTail: Promise<void> = Promise.resolve();

const api = (): CloudConversationCacheRendererApi | null => {
  if (testApi) return testApi;
  if (typeof window === "undefined") return null;
  return window.electronAPI?.cloudConversationCache ?? null;
};

const serialized = <T>(work: () => Promise<T>): Promise<T> => {
  const result = operationTail.then(work, work);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const isVersion = (value: unknown): value is CloudConversationCacheVersion => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const version = value as Partial<CloudConversationCacheVersion>;
  return (
    Number.isSafeInteger(version.epoch) &&
    (version.epoch as number) >= 0 &&
    Number.isSafeInteger(version.headSeq) &&
    (version.headSeq as number) >= -1 &&
    Number.isSafeInteger(version.floorSeq) &&
    (version.floorSeq as number) >= 0 &&
    Number.isSafeInteger(version.revision) &&
    (version.revision as number) >= 1
  );
};

const decodeSnapshot = (
  authority: CloudConversationCacheAuthority,
  value: CloudConversationCacheSnapshot | null,
): RenderableCloudConversationCacheSnapshot | null => {
  if (!value) return null;
  if (
    value.accountScope !== authority.accountScope ||
    value.ownerGeneration !== authority.ownerGeneration ||
    value.conversationId !== authority.conversationId ||
    !isVersion(value) ||
    typeof value.title !== "string" ||
    !Number.isSafeInteger(value.cachedAtMs) ||
    value.cachedAtMs < 0 ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_CLOUD_CONVERSATION_CACHE_RECORDS
  ) {
    return null;
  }
  const records: JournalRecord[] = [];
  for (const entry of value.records) {
    const record = decodeSequencedJournalEntry(entry);
    if (!record) return null;
    const previous = records.at(-1);
    if (previous && record.seq !== previous.seq + 1) return null;
    records.push(record);
  }
  if (records.length === 0) {
    if (value.headSeq !== -1) return null;
  } else if (
    records[0]!.seq < value.floorSeq ||
    records.at(-1)!.seq !== value.headSeq
  ) {
    return null;
  }
  return { ...value, records };
};

export const cloudConversationCacheClient = {
  available(): boolean {
    return api() !== null;
  },

  retainAccount(accountScope: string): Promise<boolean> {
    const bridge = api();
    if (!bridge) return Promise.resolve(false);
    return serialized(async () => {
      await bridge.retainAccount(accountScope);
      return true;
    }).catch(() => false);
  },

  activateAuthority(
    authority: CloudConversationCacheLifecycleAuthority,
  ): Promise<boolean> {
    const bridge = api();
    if (!bridge) return Promise.resolve(false);
    return serialized(async () => {
      await bridge.activateAuthority(authority);
      return true;
    }).catch(() => false);
  },

  read(
    authority: CloudConversationCacheAuthority,
  ): Promise<RenderableCloudConversationCacheSnapshot | null> {
    const bridge = api();
    if (!bridge) return Promise.resolve(null);
    return serialized(async () =>
      decodeSnapshot(authority, await bridge.read(authority)),
    ).catch(() => null);
  },

  replace(
    input: Omit<CloudConversationCacheReplaceInput, "records"> & {
      records: readonly JournalRecord[];
    },
  ): Promise<CloudConversationCacheReplaceResult> {
    const bridge = api();
    if (!bridge) return Promise.resolve({ status: "inactive", current: null });
    return serialized(() =>
      bridge.replace({ ...input, records: [...input.records] }),
    ).catch(() => ({ status: "inactive", current: null }));
  },

  purgeConversation(
    authority: CloudConversationCacheAuthority,
  ): Promise<boolean> {
    const bridge = api();
    if (!bridge) return Promise.resolve(false);
    return serialized(async () => {
      await bridge.purgeConversation(authority);
      return true;
    }).catch(() => false);
  },
};

export const setCloudConversationCacheApiForTests = (
  next: CloudConversationCacheRendererApi | undefined,
): void => {
  testApi = next;
  operationTail = Promise.resolve();
};
