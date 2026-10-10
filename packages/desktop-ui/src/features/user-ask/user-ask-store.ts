import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { UserAsk, UserAskAnswer } from "@stella/contracts/user-ask";
import type { UserAskRecord } from "@stella/contracts/user-ask-deck";
import { userAskIsOpen } from "@stella/contracts/user-ask";
import { getElectronApi } from "@/platform/electron/electron";

const EMPTY_ASKS: readonly UserAsk[] = [];
const EMPTY_RECORDS: readonly UserAskRecord[] = [];
const MAX_RECORDS_PER_CONVERSATION = 50;

let recordsByConversation: ReadonlyMap<string, readonly UserAskRecord[]> = new Map();
const recordListeners = new Set<() => void>();

let openAsks: readonly UserAsk[] = EMPTY_ASKS;
let detachBridge: (() => void) | null = null;

const listeners = new Set<() => void>();
const answered = new Set<string>();

const userAskBridge = () => getElectronApi()?.userAsk;

const emit = () => {
  for (const listener of listeners) listener();
};

const byCreation = (rows: readonly UserAsk[]): readonly UserAsk[] =>
  [...rows].sort((left, right) => left.createdAt - right.createdAt);

const isUsableAsk = (value: unknown): value is UserAsk => {
  if (!value || typeof value !== "object") return false;
  const ask = value as Partial<UserAsk>;
  return (
    typeof ask.askId === "string" &&
    typeof ask.revision === "number" &&
    typeof ask.state === "string" &&
    Boolean(ask.detail)
  );
};

const upsertAsk = (incoming: unknown) => {
  if (!isUsableAsk(incoming)) return;
  const current = openAsks.find((ask) => ask.askId === incoming.askId);
  if (current && current.revision > incoming.revision) return;
  if (!userAskIsOpen(incoming.state) || answered.has(incoming.askId)) {
    dropAsk(incoming.askId);
    return;
  }
  openAsks = byCreation([
    ...openAsks.filter((ask) => ask.askId !== incoming.askId),
    incoming,
  ]);
  emit();
};

const hasAskId = (value: unknown): value is { askId: string } =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as { askId?: unknown }).askId === "string";

const firstAsk = (args: readonly unknown[]): unknown => args.find(isUsableAsk);

const firstAskId = (args: readonly unknown[]): unknown =>
  args.find(hasAskId)?.askId;

const dropAsk = (askId: unknown) => {
  if (typeof askId !== "string") return;
  if (!openAsks.some((ask) => ask.askId === askId)) return;
  openAsks = openAsks.filter((ask) => ask.askId !== askId);
  emit();
};

const replaceAsks = (rows: unknown) => {
  const usable = (Array.isArray(rows) ? rows : [])
    .filter(isUsableAsk)
    .filter((ask) => userAskIsOpen(ask.state) && !answered.has(ask.askId));
  openAsks = byCreation(usable);
  emit();
};

const attachBridge = () => {
  if (detachBridge) return;
  const bridge = userAskBridge();
  if (!bridge) return;
  const offs = [
    bridge.onOpened?.((...args: unknown[]) => upsertAsk(firstAsk(args))),
    bridge.onUpdated?.((...args: unknown[]) => upsertAsk(firstAsk(args))),
    bridge.onClosed?.((...args: unknown[]) => dropAsk(firstAskId(args))),
  ].filter((off): off is () => void => typeof off === "function");
  if (offs.length === 0) return;
  detachBridge = () => {
    for (const off of offs) off();
  };
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  attachBridge();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detachBridge) {
      detachBridge();
      detachBridge = null;
    }
  };
};

const snapshot = () => openAsks;

export const refreshUserAsks = async (): Promise<void> => {
  const bridge = userAskBridge();
  if (!bridge?.list) return;
  try {
    replaceAsks(await bridge.list());
  } catch {
    replaceAsks([]);
  }
};

export const answerUserAsk = async (answer: UserAskAnswer): Promise<boolean> => {
  if (answered.has(answer.askId)) return true;
  const bridge = userAskBridge();
  if (!bridge?.answer) return false;
  answered.add(answer.askId);
  try {
    const result = await bridge.answer(answer);
    if (result?.ok === false) {
      answered.delete(answer.askId);
      return false;
    }
    dropAsk(answer.askId);
    return true;
  } catch {
    answered.delete(answer.askId);
    return false;
  }
};

export const setUserAskFieldSensitive = async (
  askId: string,
  fieldId: string,
  sensitive: boolean,
): Promise<boolean> => {
  const bridge = userAskBridge();
  if (!bridge?.overrideSensitive) return false;
  try {
    const result = await bridge.overrideSensitive({
      askId,
      fieldId,
      sensitive,
    });
    return result?.ok !== false;
  } catch {
    return false;
  }
};

export const recordUserAskAnswer = (
  conversationId: string,
  record: UserAskRecord,
): void => {
  if (!conversationId) return;
  const current = recordsByConversation.get(conversationId) ?? EMPTY_RECORDS;
  const next = new Map(recordsByConversation);
  next.set(
    conversationId,
    [...current.filter((entry) => entry.id !== record.id), record]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(-MAX_RECORDS_PER_CONVERSATION),
  );
  recordsByConversation = next;
  for (const listener of recordListeners) listener();
};

const subscribeRecords = (listener: () => void) => {
  recordListeners.add(listener);
  return () => {
    recordListeners.delete(listener);
  };
};

const recordsSnapshot = () => recordsByConversation;

export const useConversationUserAskRecords = (
  conversationId: string | null | undefined,
): readonly UserAskRecord[] => {
  const records = useSyncExternalStore(
    subscribeRecords,
    recordsSnapshot,
    recordsSnapshot,
  );
  return conversationId
    ? (records.get(conversationId) ?? EMPTY_RECORDS)
    : EMPTY_RECORDS;
};

export const useUserAsks = (): readonly UserAsk[] =>
  useSyncExternalStore(subscribe, snapshot, snapshot);

export const useConversationUserAsks = (
  conversationId: string | null | undefined,
): readonly UserAsk[] => {
  const asks = useUserAsks();
  return useMemo(
    () =>
      conversationId
        ? asks.filter((ask) => ask.conversationId === conversationId)
        : EMPTY_ASKS,
    [asks, conversationId],
  );
};

export const useUserAskRemainingMs = (
  deadlineAt: number | undefined,
): number | null => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineAt === undefined) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadlineAt]);

  if (deadlineAt === undefined) return null;
  return Math.max(0, deadlineAt - now);
};
