import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatThreadId } from "./offline-chat-storage";
import { accountChatMetadataReadsBlocked } from "./chat-account-metadata-queue";
import {
  acknowledgeDesktopChatOutboxRecords,
  appendDesktopChatOutboxRecord,
  markDesktopChatOutboxRecordCanceled,
  parseDesktopChatOutbox,
  partitionDesktopChatOutboxForAuthority,
  type DesktopChatOutboxAuthority,
  type DesktopChatOutboxRecord,
} from "./desktop-chat-outbox-state";

const OUTBOX_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-cloud-chat-outbox-v1",
  computer: "stella-mobile-computer-chat-outbox-v1",
  carplay: "stella-mobile-carplay-chat-outbox-v1",
  "carplay-computer": "stella-mobile-carplay-computer-chat-outbox-v1",
};

const mutations = new Map<string, Promise<void>>();

const readStrict = async (
  thread: ChatThreadId,
): Promise<DesktopChatOutboxRecord[]> => {
  if (await accountChatMetadataReadsBlocked()) {
    throw new Error("Local chat account cleanup is active");
  }
  const raw = await AsyncStorage.getItem(OUTBOX_KEY[thread]);
  if (await accountChatMetadataReadsBlocked()) {
    throw new Error("Local chat account cleanup is active");
  }
  return raw ? parseDesktopChatOutbox(JSON.parse(raw) as unknown) : [];
};

const read = async (thread: ChatThreadId): Promise<DesktopChatOutboxRecord[]> =>
  readStrict(thread).catch(() => []);

const mutate = async <T>(
  thread: ChatThreadId,
  update: (current: DesktopChatOutboxRecord[]) => {
    records: DesktopChatOutboxRecord[];
    value: T;
  },
): Promise<T> => {
  const key = OUTBOX_KEY[thread];
  const predecessor = mutations.get(key) ?? Promise.resolve();
  let resolveValue!: (value: T) => void;
  let rejectValue!: (error: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  const operation = predecessor
    .catch(() => undefined)
    .then(async () => {
      if (await accountChatMetadataReadsBlocked()) {
        throw new Error("Local chat account cleanup is active");
      }
      const current = await readStrict(thread);
      const next = update(current);
      if (await accountChatMetadataReadsBlocked()) {
        throw new Error("Local chat account cleanup is active");
      }
      if (next.records.length === 0) {
        await AsyncStorage.removeItem(key);
      } else {
        await AsyncStorage.setItem(key, JSON.stringify(next.records));
      }
      resolveValue(next.value);
    })
    .catch(rejectValue);
  mutations.set(key, operation);
  void operation.finally(() => {
    if (mutations.get(key) === operation) mutations.delete(key);
  });
  return result;
};

export const loadDesktopChatOutbox = async (
  thread: ChatThreadId,
  authority?: DesktopChatOutboxAuthority,
): Promise<DesktopChatOutboxRecord[]> => {
  await (mutations.get(OUTBOX_KEY[thread]) ?? Promise.resolve()).catch(
    () => undefined,
  );
  if (!authority) return read(thread);
  return mutate(thread, (current) => {
    const scoped = partitionDesktopChatOutboxForAuthority(current, authority);
    return { records: scoped.retained, value: scoped.active };
  });
};

export const enqueueDesktopChatOutbox = (
  thread: ChatThreadId,
  input: Omit<DesktopChatOutboxRecord, "sequence">,
): Promise<DesktopChatOutboxRecord> =>
  mutate(thread, (current) => {
    const next = appendDesktopChatOutboxRecord(current, input);
    return { records: next.records, value: next.record };
  });

export const acknowledgeDesktopChatOutbox = (
  thread: ChatThreadId,
  acceptedIds: ReadonlySet<string>,
  authority?: DesktopChatOutboxAuthority,
): Promise<void> =>
  mutate(thread, (current) => ({
    records: acknowledgeDesktopChatOutboxRecords(
      current,
      acceptedIds,
      authority,
    ),
    value: undefined,
  }));

export const markDesktopChatOutboxCancellation = (
  thread: ChatThreadId,
  sendId: string,
  cancelRequestId: string,
  cancelRequestedAt = Date.now(),
  authority?: DesktopChatOutboxAuthority,
): Promise<void> =>
  mutate(thread, (current) => ({
    records: markDesktopChatOutboxRecordCanceled(
      current,
      sendId,
      cancelRequestId,
      cancelRequestedAt,
      authority,
    ),
    value: undefined,
  }));

export const desktopChatOutboxStorageKeys = (): string[] =>
  Object.values(OUTBOX_KEY);

export const waitForDesktopChatOutboxWrites = async (): Promise<void> => {
  await Promise.all([...mutations.values()]);
};

export type { DesktopChatOutboxAuthority };
