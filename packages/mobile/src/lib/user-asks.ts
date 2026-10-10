import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  normalizeUserAskOptions,
  normalizeUserAskQuestions,
  USER_ASK_FIELD_TYPES,
  USER_ASK_KINDS,
  USER_ASK_MAX_FIELDS,
  USER_ASK_SCHEMA_VERSION,
  USER_ASK_SEAL_ALGORITHM,
  USER_ASK_STATES,
  clampUrgency,
  userAskIsOpen,
  type UserAsk,
  type UserAskAnswer,
  type UserAskDetail,
  type UserAskField,
  type UserAskFieldType,
  type UserAskKind,
  type UserAskRecipientKey,
  type UserAskState,
} from "@stella/contracts/user-ask";
import type { UserAskRecord } from "@stella/contracts/user-ask-deck";
import { authClient } from "./auth-client";
import { useBackendView } from "./backend";
import { listExecutionDevices } from "./execution-placement";
import { backendOrigin, getJson, HttpRequestError, postJson } from "./http";
import { getOrCreateMobileDeviceId } from "./phone-access";
import { useAppVisible } from "./use-app-visible";

const LIVE_BACKSTOP_POLL_MS = 120_000;
const FALLBACK_POLL_MS = 15_000;
const UNAVAILABLE_POLL_MS = 120_000;

type UserAskStoreState = {
  readonly asks: readonly UserAsk[];
  readonly loaded: boolean;
  readonly live: boolean;
  readonly available: boolean;
};

const EMPTY_ASKS: readonly UserAsk[] = [];

let state: UserAskStoreState = {
  asks: EMPTY_ASKS,
  loaded: false,
  live: false,
  available: true,
};

const listeners = new Set<() => void>();

const publish = (next: UserAskStoreState) => {
  state = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => state;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizeFieldType = (value: unknown): UserAskFieldType =>
  USER_ASK_FIELD_TYPES.includes(value as UserAskFieldType)
    ? (value as UserAskFieldType)
    : "text";

const normalizeField = (input: unknown): UserAskField | null => {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const id = text(source.id);
  if (!id) return null;
  const type = normalizeFieldType(source.type);
  const label = text(source.label) || id;
  const placeholder = text(source.placeholder);
  const hint = text(source.hint);
  const choices =
    type === "choice" ? normalizeUserAskOptions(source.choices) : [];
  return {
    id,
    label,
    type,
    sensitive: source.sensitive !== false,
    ...(placeholder ? { placeholder } : {}),
    ...(hint ? { hint } : {}),
    ...(source.optional === true ? { optional: true } : {}),
    ...(choices.length > 0 ? { choices } : {}),
  };
};

const normalizeDetail = (
  kind: UserAskKind,
  input: unknown,
): UserAskDetail | null => {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const detail = text(source.detail);
  if (kind === "question") {
    const questions = normalizeUserAskQuestions(source);
    return questions.length > 0 ? { kind: "question", questions } : null;
  }
  const purpose = text(source.purpose);
  const rawFields = Array.isArray(source.fields) ? source.fields : [];
  const fields: UserAskField[] = [];
  const seen = new Set<string>();
  for (const row of rawFields) {
    if (fields.length >= USER_ASK_MAX_FIELDS) break;
    const field = normalizeField(row);
    if (!field || seen.has(field.id)) continue;
    seen.add(field.id);
    fields.push(field);
  }
  if (!purpose || fields.length === 0) return null;
  return {
    kind: "secure_input",
    purpose,
    fields,
    ...(detail ? { detail } : {}),
  };
};

const normalizeRecipientKey = (
  input: unknown,
): UserAskRecipientKey | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const source = input as Record<string, unknown>;
  if (source.algorithm !== USER_ASK_SEAL_ALGORITHM) return undefined;
  const keyId = text(source.keyId);
  const publicKey = text(source.publicKey);
  if (!keyId || !publicKey) return undefined;
  return { algorithm: USER_ASK_SEAL_ALGORITHM, keyId, publicKey };
};

export const normalizeUserAsk = (input: unknown): UserAsk | null => {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const askId = text(source.askId);
  const kind = USER_ASK_KINDS.includes(source.kind as UserAskKind)
    ? (source.kind as UserAskKind)
    : null;
  if (!askId || !kind) return null;
  const detail = normalizeDetail(kind, source.detail);
  if (!detail) return null;
  const askState = USER_ASK_STATES.includes(source.state as UserAskState)
    ? (source.state as UserAskState)
    : "pending";
  const createdAt = finiteNumber(source.createdAt) ?? Date.now();
  const deadlineAt = finiteNumber(source.deadlineAt);
  const nextEscalationAt = finiteNumber(source.nextEscalationAt);
  const agentLabel = text(source.agentLabel);
  const recipientKey = normalizeRecipientKey(source.recipientKey);
  return {
    schemaVersion: USER_ASK_SCHEMA_VERSION,
    askId,
    kind,
    conversationId: text(source.conversationId),
    threadId: text(source.threadId),
    toolCallId: text(source.toolCallId),
    originDeviceId: text(source.originDeviceId),
    revision: finiteNumber(source.revision) ?? 0,
    state: askState,
    urgency: clampUrgency(source.urgency),
    escalationLevel: clampUrgency(source.escalationLevel ?? source.urgency),
    blocking: source.blocking === true,
    expiresAt: finiteNumber(source.expiresAt) ?? createdAt,
    createdAt,
    updatedAt: finiteNumber(source.updatedAt) ?? createdAt,
    detail,
    ...(agentLabel ? { agentLabel } : {}),
    ...(deadlineAt === null ? {} : { deadlineAt }),
    ...(nextEscalationAt === null ? {} : { nextEscalationAt }),
    ...(recipientKey ? { recipientKey } : {}),
  };
};

const parseAskRows = (rows: readonly unknown[]): readonly UserAsk[] => {
  const asks: UserAsk[] = [];
  for (const row of rows) {
    const ask = normalizeUserAsk(row);
    if (ask && userAskIsOpen(ask.state)) asks.push(ask);
  }
  asks.sort((left, right) => left.createdAt - right.createdAt);
  return asks;
};

const parseAskList = (payload: unknown): readonly UserAsk[] => {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).open ??
        (payload as Record<string, unknown>).asks ??
        (payload as Record<string, unknown>).userAsks)
      : null;
  if (!Array.isArray(rows)) return EMPTY_ASKS;
  return parseAskRows(rows);
};

const sameAskList = (
  left: readonly UserAsk[],
  right: readonly UserAsk[],
): boolean => {
  if (left.length !== right.length) return false;
  return left.every((ask, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      other.askId === ask.askId &&
      other.revision === ask.revision &&
      other.state === ask.state &&
      other.escalationLevel === ask.escalationLevel &&
      other.updatedAt === ask.updatedAt
    );
  });
};

const settle = (
  asks: readonly UserAsk[],
  patch: Partial<UserAskStoreState>,
) => {
  publish({
    ...state,
    ...patch,
    asks: sameAskList(state.asks, asks) ? state.asks : asks,
    loaded: true,
  });
};

export const applyLiveUserAsks = (rows: readonly UserAsk[]) => {
  settle(parseAskRows(rows), { live: true, available: true });
};

export const markUserAskLaneDown = () => {
  if (!state.live) return;
  publish({ ...state, live: false });
};

const isMissingRoute = (error: unknown): boolean =>
  error instanceof HttpRequestError &&
  (error.status === 404 || error.status === 501 || error.status === 405);

let inFlight: Promise<void> | null = null;

const loadOnce = async (): Promise<void> => {
  try {
    const payload = await getJson("/api/user-asks", {
      origin: backendOrigin(),
    });
    settle(parseAskList(payload), { available: true });
  } catch (error) {
    if (isMissingRoute(error)) {
      settle(state.live ? state.asks : EMPTY_ASKS, { available: false });
      return;
    }
    publish({ ...state, loaded: true });
  }
};

export const refreshUserAsks = (): Promise<void> => {
  inFlight ??= loadOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
};

const removeAskLocally = (askId: string) => {
  const asks = state.asks.filter((ask) => ask.askId !== askId);
  if (asks.length !== state.asks.length) publish({ ...state, asks });
};

export const answerUserAsk = async (answer: UserAskAnswer): Promise<void> => {
  const answeredOnDeviceId = await getOrCreateMobileDeviceId().catch(
    () => null,
  );
  await postJson(
    `/api/user-asks/${encodeURIComponent(answer.askId)}/answer`,
    answeredOnDeviceId ? { ...answer, answeredOnDeviceId } : answer,
    { origin: backendOrigin() },
  );
  removeAskLocally(answer.askId);
};

export const cancelUserAsk = async (askId: string): Promise<void> => {
  await postJson(
    `/api/user-asks/${encodeURIComponent(askId)}/cancel`,
    {},
    { origin: backendOrigin() },
  );
  removeAskLocally(askId);
};

const EMPTY_RECORDS: readonly UserAskRecord[] = [];
const MAX_RECORDS_PER_CONVERSATION = 50;
let recordsByConversation: ReadonlyMap<string, readonly UserAskRecord[]> =
  new Map();
const recordListeners = new Set<() => void>();

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

const getRecordsSnapshot = () => recordsByConversation;

export const useConversationUserAskRecords = (
  conversationId: string | null | undefined,
): readonly UserAskRecord[] => {
  const records = useSyncExternalStore(
    subscribeRecords,
    getRecordsSnapshot,
    getRecordsSnapshot,
  );
  return conversationId
    ? (records.get(conversationId) ?? EMPTY_RECORDS)
    : EMPTY_RECORDS;
};

let focusedAskId: string | null = null;
const focusListeners = new Set<() => void>();

const publishFocused = (next: string | null) => {
  if (focusedAskId === next) return;
  focusedAskId = next;
  for (const listener of focusListeners) listener();
};

const subscribeFocused = (listener: () => void) => {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
};

const getFocusedSnapshot = () => focusedAskId;

export const focusUserAsk = (askId: string) => {
  publishFocused(askId);
  void refreshUserAsks();
};

export const clearFocusedUserAsk = () => publishFocused(null);

export const useFocusedUserAskId = (): string | null =>
  useSyncExternalStore(subscribeFocused, getFocusedSnapshot, getFocusedSnapshot);

export const useUserAskState = (): UserAskStoreState =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const useOpenUserAsks = (): readonly UserAsk[] => useUserAskState().asks;

export const getOpenUserAsks = (): readonly UserAsk[] => state.asks;

const useConnectedAccountAccess = (): boolean => {
  const session = authClient.useSession();
  return Boolean(session.data) && session.data?.user?.isAnonymous !== true;
};

const LIVE_VIEW_ARGS = {} as const;

export const useUserAskSync = (enabled: boolean) => {
  const connected = useConnectedAccountAccess();
  const active = enabled && connected;
  const visible = useAppVisible();
  const view = useBackendView("userAsks.open", active ? LIVE_VIEW_ARGS : "skip");
  const liveDown = view.error !== undefined;
  const { available, live } = useUserAskState();
  const liveValue = view.value;

  useEffect(() => {
    if (!active || !liveValue) return;
    applyLiveUserAsks(liveValue);
  }, [active, liveValue]);

  useEffect(() => {
    if (!active || !liveDown) return;
    markUserAskLaneDown();
  }, [active, liveDown]);

  useEffect(() => {
    if (!active || !visible) return;
    const liveHealthy = live && !liveDown;
    if (!liveHealthy) void refreshUserAsks();
    const period = liveHealthy
      ? LIVE_BACKSTOP_POLL_MS
      : available
        ? FALLBACK_POLL_MS
        : UNAVAILABLE_POLL_MS;
    const interval = setInterval(() => {
      void refreshUserAsks();
    }, period);
    return () => clearInterval(interval);
  }, [active, available, live, liveDown, visible]);
};

export type ConversationUserAsks = {
  readonly questions: readonly UserAsk[];
  readonly secureInput: UserAsk | null;
  readonly focused: UserAsk | null;
};

const NO_CONVERSATION_ASKS: ConversationUserAsks = {
  questions: EMPTY_ASKS,
  secureInput: null,
  focused: null,
};

export const useConversationUserAsks = (
  conversationId: string | null | undefined,
): ConversationUserAsks => {
  const asks = useOpenUserAsks();
  const focusedId = useFocusedUserAskId();
  return useMemo(() => {
    if (asks.length === 0) return NO_CONVERSATION_ASKS;
    if (!conversationId) return NO_CONVERSATION_ASKS;
    const mine = asks.filter((ask) => ask.conversationId === conversationId);
    if (mine.length === 0) return NO_CONVERSATION_ASKS;
    const focused = focusedId
      ? (mine.find((ask) => ask.askId === focusedId) ?? null)
      : null;
    const secureInputs = mine.filter((ask) => ask.kind === "secure_input");
    return {
      questions: mine.filter((ask) => ask.detail.kind === "question"),
      secureInput:
        focused?.kind === "secure_input" ? focused : (secureInputs[0] ?? null),
      focused,
    };
  }, [asks, conversationId, focusedId]);
};

const deviceLabels = new Map<string, string>();

export const useUserAskOriginLabel = (
  originDeviceId: string,
): string | null => {
  const [label, setLabel] = useState<string | null>(
    () => deviceLabels.get(originDeviceId) ?? null,
  );
  useEffect(() => {
    if (!originDeviceId) return;
    const known = deviceLabels.get(originDeviceId);
    if (known) {
      setLabel(known);
      return;
    }
    let cancelled = false;
    void listExecutionDevices()
      .then((devices) => {
        for (const device of devices) {
          if (device.label) deviceLabels.set(device.deviceId, device.label);
        }
        if (!cancelled) setLabel(deviceLabels.get(originDeviceId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [originDeviceId]);
  return label;
};

export const useResolveFocusedUserAsk = (askId: string | null) => {
  const focused = useFocusedUserAskId();
  const resolve = useCallback(() => {
    if (focused && focused === askId) clearFocusedUserAsk();
  }, [askId, focused]);
  useEffect(resolve, [resolve]);
};
