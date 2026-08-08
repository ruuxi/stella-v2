import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatThreadId } from "./offline-chat-storage";
import {
  acknowledgeDesktopChatOutboxRecords,
  appendDesktopChatOutboxRecord,
  parseDesktopChatOutbox,
  type DesktopChatOutboxRecord,
} from "./desktop-chat-outbox-state";

const OUTBOX_KEY: Record<ChatThreadId, string> = {
  cloud: "stella-mobile-cloud-chat-outbox-v1",
  computer: "stella-mobile-computer-chat-outbox-v1",
  carplay: "stella-mobile-carplay-chat-outbox-v1",
  "carplay-computer": "stella-mobile-carplay-computer-chat-outbox-v1",
};

const mutations = new Map<string, Promise<void>>();

const read = async (thread: ChatThreadId): Promise<DesktopChatOutboxRecord[]> => {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY[thread]);
    return raw ? parseDesktopChatOutbox(JSON.parse(raw) as unknown) : [];
  } catch {
    return [];
  }
};

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
      const current = await read(thread);
      const next = update(current);
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
): Promise<DesktopChatOutboxRecord[]> => {
  await (mutations.get(OUTBOX_KEY[thread]) ?? Promise.resolve()).catch(
    () => undefined,
  );
  return read(thread);
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
): Promise<void> =>
  mutate(thread, (current) => ({
    records: acknowledgeDesktopChatOutboxRecords(current, acceptedIds),
    value: undefined,
  }));

export const desktopChatOutboxStorageKeys = (): string[] =>
  Object.values(OUTBOX_KEY);

export const waitForDesktopChatOutboxWrites = async (): Promise<void> => {
  await Promise.all([...mutations.values()]);
};
