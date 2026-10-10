export const USER_ASK_SCHEMA_VERSION = 1 as const;

export const USER_ASK_KINDS = ["question", "secure_input"] as const;

export type UserAskKind = (typeof USER_ASK_KINDS)[number];

export const USER_ASK_STATES = [
  "pending",
  "answered",
  "defaulted",
  "answered_late",
  "canceled",
  "expired",
] as const;

export type UserAskState = (typeof USER_ASK_STATES)[number];

export const USER_ASK_OPEN_STATES = ["pending", "defaulted"] as const;

export const USER_ASK_URGENCY_LEVELS = [1, 2, 3, 4] as const;

export type UserAskUrgencyLevel = (typeof USER_ASK_URGENCY_LEVELS)[number];

export const USER_ASK_URGENCY_NAMES = [
  "chat",
  "notify",
  "alert",
  "breakthrough",
] as const;

export type UserAskUrgencyName = (typeof USER_ASK_URGENCY_NAMES)[number];

export const USER_ASK_MIN_URGENCY: UserAskUrgencyLevel = 1;
export const USER_ASK_MAX_URGENCY: UserAskUrgencyLevel = 4;

export const urgencyNameFromLevel = (
  level: UserAskUrgencyLevel,
): UserAskUrgencyName => USER_ASK_URGENCY_NAMES[level - 1]!;

export const urgencyLevelFromName = (
  name: string,
): UserAskUrgencyLevel | null => {
  const index = USER_ASK_URGENCY_NAMES.indexOf(name as UserAskUrgencyName);
  return index < 0 ? null : ((index + 1) as UserAskUrgencyLevel);
};

export const clampUrgency = (value: unknown): UserAskUrgencyLevel => {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? (urgencyLevelFromName(value) ?? Number(value))
        : Number.NaN;
  if (!Number.isFinite(numeric)) return USER_ASK_MIN_URGENCY;
  const rounded = Math.round(numeric);
  if (rounded < USER_ASK_MIN_URGENCY) return USER_ASK_MIN_URGENCY;
  if (rounded > USER_ASK_MAX_URGENCY) return USER_ASK_MAX_URGENCY;
  return rounded as UserAskUrgencyLevel;
};

export const USER_ASK_MIN_OPTIONS = 2;
export const USER_ASK_MAX_OPTIONS = 4;
export const USER_ASK_MAX_QUESTIONS = 4;
export const USER_ASK_MAX_RESPONSE_TEXT = 2000;

export const USER_ASK_SKIPPED_NOTE = "The user chose not to answer this question.";

export const USER_ASK_DEFAULT_TIMEOUT_MS = 3 * 60_000;
export const USER_ASK_MIN_TIMEOUT_MS = 30_000;
export const USER_ASK_MAX_TIMEOUT_MS = 3 * 60_000;
export const USER_ASK_BLOCKING_TTL_MS = 24 * 60 * 60_000;

export const USER_ASK_ESCALATION_STEP_MS = 90_000;

export const clampUserAskTimeoutMs = (value: unknown): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return USER_ASK_DEFAULT_TIMEOUT_MS;
  return Math.min(
    USER_ASK_MAX_TIMEOUT_MS,
    Math.max(USER_ASK_MIN_TIMEOUT_MS, Math.round(numeric)),
  );
};

export const USER_ASK_MAX_FIELDS = 8;

export type UserAskOption = Readonly<{
  id: string;
  label: string;
  hint?: string;
}>;

export const USER_ASK_FIELD_TYPES = ["text", "secret", "code", "choice"] as const;

export type UserAskFieldType = (typeof USER_ASK_FIELD_TYPES)[number];

export type UserAskField = Readonly<{
  id: string;
  label: string;
  type: UserAskFieldType;
  sensitive: boolean;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  choices?: readonly UserAskOption[];
}>;

export type UserAskQuestion = Readonly<{
  id: string;
  question: string;
  detail?: string;
  options: readonly UserAskOption[];
  defaultChoiceId?: string;
}>;

export type UserAskQuestionDetail = Readonly<{
  kind: "question";
  questions: readonly UserAskQuestion[];
}>;

export type UserAskSecureInputDetail = Readonly<{
  kind: "secure_input";
  purpose: string;
  detail?: string;
  fields: readonly UserAskField[];
}>;

export type UserAskDetail = UserAskQuestionDetail | UserAskSecureInputDetail;

export const USER_ASK_SEAL_ALGORITHM =
  "x25519-hkdf-sha256-aes-256-gcm-v1" as const;

export type UserAskRecipientKey = Readonly<{
  algorithm: typeof USER_ASK_SEAL_ALGORITHM;
  keyId: string;
  publicKey: string;
}>;

export type UserAskSealedValue = Readonly<{
  algorithm: typeof USER_ASK_SEAL_ALGORITHM;
  keyId: string;
  clientPublicKey: string;
  iv: string;
  ciphertext: string;
}>;

export type UserAsk = Readonly<{
  schemaVersion: typeof USER_ASK_SCHEMA_VERSION;
  askId: string;
  kind: UserAskKind;
  conversationId: string;
  threadId: string;
  toolCallId: string;
  agentLabel?: string;
  originDeviceId: string;
  revision: number;
  state: UserAskState;
  urgency: UserAskUrgencyLevel;
  escalationLevel: UserAskUrgencyLevel;
  blocking: boolean;
  deadlineAt?: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  nextEscalationAt?: number;
  detail: UserAskDetail;
  recipientKey?: UserAskRecipientKey;
}>;

export type UserAskSummary = Readonly<
  Pick<
    UserAsk,
    | "schemaVersion"
    | "askId"
    | "kind"
    | "conversationId"
    | "threadId"
    | "state"
    | "urgency"
    | "escalationLevel"
    | "blocking"
    | "revision"
    | "createdAt"
    | "updatedAt"
  > & {
    title: string;
    deadlineAt?: number;
  }
>;

export type UserAskAnswerFieldValue =
  | Readonly<{ fieldId: string; kind: "plain"; value: string }>
  | Readonly<{ fieldId: string; kind: "sealed"; sealed: UserAskSealedValue }>;

export const USER_ASK_RESPONSE_KINDS = ["option", "text", "skipped"] as const;

export type UserAskResponseKind = (typeof USER_ASK_RESPONSE_KINDS)[number];

export type UserAskQuestionResponse =
  | Readonly<{ questionId: string; kind: "option"; choiceId: string }>
  | Readonly<{ questionId: string; kind: "text"; text: string }>
  | Readonly<{ questionId: string; kind: "skipped" }>;

export type UserAskAnswer =
  | Readonly<{
      askId: string;
      revision: number;
      kind: "questions";
      responses: readonly UserAskQuestionResponse[];
      answeredOnDeviceId?: string;
    }>
  | Readonly<{
      askId: string;
      revision: number;
      kind: "fields";
      fields: readonly UserAskAnswerFieldValue[];
      answeredOnDeviceId?: string;
    }>;

export type UserAskDecision = "answer" | "cancel";

export type UserAskResolution =
  | Readonly<{
      outcome: "answered";
      askId: string;
      responses?: readonly UserAskQuestionResponse[];
      values?: Readonly<Record<string, string>>;
      handles?: Readonly<Record<string, string>>;
      answeredAt: number;
      late?: boolean;
    }>
  | Readonly<{
      outcome: "defaulted";
      askId: string;
      responses: readonly UserAskQuestionResponse[];
      defaultedAt: number;
      note: string;
    }>
  | Readonly<{
      outcome: "canceled" | "expired";
      askId: string;
      at: number;
      note: string;
    }>;

export const userAskDefaultedNote = (choiceLabels: readonly string[]): string =>
  choiceLabels.length === 1
    ? `Went with "${choiceLabels[0]}" — you didn't answer in time. Tell me if you want something else and I'll adapt.`
    : `Went with the defaults (${choiceLabels
        .map((label) => `"${label}"`)
        .join(", ")}) — you didn't answer in time. Tell me if you want something else and I'll adapt.`;

export const userAskIsOpen = (state: UserAskState): boolean =>
  (USER_ASK_OPEN_STATES as readonly UserAskState[]).includes(state);

export const userAskAcceptsAnswer = (state: UserAskState): boolean =>
  state === "pending" || state === "defaulted";

export type UserAskQuietHours = Readonly<{
  enabled: boolean;
  startMinute: number;
  endMinute: number;
}>;

export type UserAskEscalationPolicy = Readonly<{
  schemaVersion: typeof USER_ASK_SCHEMA_VERSION;
  ceiling: UserAskUrgencyLevel;
  soundEnabled: boolean;
  quietHours: UserAskQuietHours;
  quietHoursCeiling: UserAskUrgencyLevel;
  maxPerHour: number;
  timeZone?: string;
}>;

export const USER_ASK_MAX_PER_HOUR_LIMIT = 20;

export const DEFAULT_USER_ASK_ESCALATION_POLICY: UserAskEscalationPolicy = {
  schemaVersion: USER_ASK_SCHEMA_VERSION,
  ceiling: 3,
  soundEnabled: true,
  quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 },
  quietHoursCeiling: 1,
  maxPerHour: 6,
};

const MINUTES_PER_DAY = 24 * 60;

export const normalizeMinuteOfDay = (value: unknown): number => {
  const numeric = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return 0;
  return ((numeric % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
};

export const normalizeUserAskEscalationPolicy = (
  input: unknown,
): UserAskEscalationPolicy => {
  const source = (
    input && typeof input === "object" ? input : {}
  ) as Partial<UserAskEscalationPolicy> & {
    quietHours?: Partial<UserAskQuietHours>;
  };
  const quietHours: Partial<UserAskQuietHours> = source.quietHours ?? {};
  const maxPerHour =
    typeof source.maxPerHour === "number" && Number.isFinite(source.maxPerHour)
      ? Math.min(
          USER_ASK_MAX_PER_HOUR_LIMIT,
          Math.max(1, Math.round(source.maxPerHour)),
        )
      : DEFAULT_USER_ASK_ESCALATION_POLICY.maxPerHour;
  return {
    schemaVersion: USER_ASK_SCHEMA_VERSION,
    ceiling:
      source.ceiling === undefined
        ? DEFAULT_USER_ASK_ESCALATION_POLICY.ceiling
        : clampUrgency(source.ceiling),
    soundEnabled:
      typeof source.soundEnabled === "boolean"
        ? source.soundEnabled
        : DEFAULT_USER_ASK_ESCALATION_POLICY.soundEnabled,
    quietHours: {
      enabled:
        typeof quietHours.enabled === "boolean"
          ? quietHours.enabled
          : DEFAULT_USER_ASK_ESCALATION_POLICY.quietHours.enabled,
      startMinute:
        quietHours.startMinute === undefined
          ? DEFAULT_USER_ASK_ESCALATION_POLICY.quietHours.startMinute
          : normalizeMinuteOfDay(quietHours.startMinute),
      endMinute:
        quietHours.endMinute === undefined
          ? DEFAULT_USER_ASK_ESCALATION_POLICY.quietHours.endMinute
          : normalizeMinuteOfDay(quietHours.endMinute),
    },
    quietHoursCeiling:
      source.quietHoursCeiling === undefined
        ? DEFAULT_USER_ASK_ESCALATION_POLICY.quietHoursCeiling
        : clampUrgency(source.quietHoursCeiling),
    maxPerHour,
    ...(typeof source.timeZone === "string" && source.timeZone.trim()
      ? { timeZone: source.timeZone.trim().slice(0, 64) }
      : {}),
  };
};

export const isWithinQuietHours = (
  quietHours: UserAskQuietHours,
  minuteOfDay: number,
): boolean => {
  if (!quietHours.enabled) return false;
  const minute = normalizeMinuteOfDay(minuteOfDay);
  const { startMinute, endMinute } = quietHours;
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
};

export const effectiveEscalationCeiling = (
  policy: UserAskEscalationPolicy,
  requested: UserAskUrgencyLevel,
  minuteOfDay: number,
): UserAskUrgencyLevel => {
  const quiet = isWithinQuietHours(policy.quietHours, minuteOfDay);
  const ceiling = quiet
    ? (Math.min(policy.ceiling, policy.quietHoursCeiling) as UserAskUrgencyLevel)
    : policy.ceiling;
  return Math.min(requested, ceiling) as UserAskUrgencyLevel;
};

export const nextEscalationLevel = (
  current: UserAskUrgencyLevel,
  ceiling: UserAskUrgencyLevel,
): UserAskUrgencyLevel | null =>
  current >= ceiling
    ? null
    : ((current + 1) as UserAskUrgencyLevel);

export const USER_ASK_PUSH_KIND = "user_ask" as const;
export const USER_ASK_PUSH_CATEGORY = "user_ask" as const;

export type UserAskPushPayload = Readonly<{
  kind: typeof USER_ASK_PUSH_KIND;
  askId: string;
  conversationId: string;
  level: UserAskUrgencyLevel;
}>;

export const USER_ASK_SECRET_HANDLE_PREFIX = "stella-secret:";

export const isUserAskSecretHandle = (value: unknown): value is string =>
  typeof value === "string" &&
  value.startsWith(USER_ASK_SECRET_HANDLE_PREFIX) &&
  value.length > USER_ASK_SECRET_HANDLE_PREFIX.length;

export const SECURE_VALUE_TARGET_KINDS = [
  "browser_field",
  "command",
  "keychain",
] as const;

export type SecureValueTargetKind = (typeof SECURE_VALUE_TARGET_KINDS)[number];

export type SecureValueTarget =
  | Readonly<{ kind: "browser_field"; selector: string; tabId?: string }>
  | Readonly<{
      kind: "command";
      command: string;
      placeholder?: string;
      cwd?: string;
    }>
  | Readonly<{ kind: "keychain"; service: string; account: string }>;

export type SecureValueUseReceipt = Readonly<{
  handle: string;
  target: SecureValueTargetKind;
  usedAt: number;
  detail: string;
  ok: boolean;
}>;

export const normalizeUserAskOptions = (
  input: unknown,
): readonly UserAskOption[] => {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const options: UserAskOption[] = [];
  for (const row of rows) {
    if (options.length >= USER_ASK_MAX_OPTIONS) break;
    const source =
      typeof row === "string"
        ? { id: row, label: row }
        : ((row ?? {}) as Partial<UserAskOption>);
    const label = String(source.label ?? source.id ?? "").trim();
    if (!label) continue;
    const baseId = String(source.id ?? label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
    let id = baseId || `option_${options.length + 1}`;
    while (seen.has(id)) id = `${id}_${options.length + 1}`;
    seen.add(id);
    const hint = source.hint ? String(source.hint).trim() : "";
    options.push({ id, label, ...(hint ? { hint } : {}) });
  }
  return options;
};

const LEGACY_SOMETHING_ELSE_OPTION_ID = "something_else";

const questionId = (value: unknown, index: number): string => {
  const id = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return id || `q${index + 1}`;
};

const normalizeQuestion = (
  input: unknown,
  index: number,
): UserAskQuestion | null => {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const question = typeof source.question === "string" ? source.question.trim() : "";
  if (!question) return null;
  const options = normalizeUserAskOptions(source.options).filter(
    (option) => option.id !== LEGACY_SOMETHING_ELSE_OPTION_ID,
  );
  if (options.length === 0) return null;
  const detail = typeof source.detail === "string" ? source.detail.trim() : "";
  const requestedDefault = String(
    source.defaultChoiceId ?? source.default_choice ?? source.defaultChoice ?? "",
  ).trim();
  const defaultOption = options.find(
    (option) =>
      option.id === requestedDefault ||
      option.id === normalizeUserAskOptions([requestedDefault])[0]?.id,
  );
  return {
    id: questionId(source.id, index),
    question,
    ...(detail ? { detail } : {}),
    options,
    ...(defaultOption ? { defaultChoiceId: defaultOption.id } : {}),
  };
};

export const normalizeUserAskQuestions = (
  input: unknown,
): readonly UserAskQuestion[] => {
  if (!input || typeof input !== "object") return [];
  const source = input as Record<string, unknown>;
  const rows = Array.isArray(source.questions) ? source.questions : [source];
  const seen = new Set<string>();
  const questions: UserAskQuestion[] = [];
  for (const row of rows) {
    if (questions.length >= USER_ASK_MAX_QUESTIONS) break;
    const question = normalizeQuestion(row, questions.length);
    if (!question) continue;
    let id = question.id;
    while (seen.has(id)) id = `${id}_${questions.length + 1}`;
    seen.add(id);
    questions.push(id === question.id ? question : { ...question, id });
  }
  return questions;
};

export const userAskQuestionsOf = (
  detail: UserAskDetail,
): readonly UserAskQuestion[] =>
  detail.kind === "question" ? detail.questions : [];

export const userAskTitleOf = (detail: UserAskDetail): string =>
  detail.kind === "question"
    ? (detail.questions[0]?.question ?? "")
    : detail.purpose;

export const userAskHasDefaults = (detail: UserAskDetail): boolean =>
  detail.kind === "question" &&
  detail.questions.length > 0 &&
  detail.questions.every((question) => question.defaultChoiceId !== undefined);

export const userAskDefaultResponses = (
  detail: UserAskDetail,
): readonly UserAskQuestionResponse[] =>
  userAskQuestionsOf(detail).map((question) => ({
    questionId: question.id,
    kind: "option" as const,
    choiceId: question.defaultChoiceId ?? question.options[0]?.id ?? "",
  }));

export const userAskOptionLabel = (
  question: UserAskQuestion,
  choiceId: string,
): string =>
  question.options.find((option) => option.id === choiceId)?.label ?? choiceId;

export const userAskDefaultedResolution = (
  askId: string,
  detail: UserAskDetail,
  defaultedAt: number,
): UserAskResolution => {
  const questions = userAskQuestionsOf(detail);
  const responses = userAskDefaultResponses(detail);
  const labels = responses.map((response, index) =>
    response.kind === "option"
      ? userAskOptionLabel(questions[index]!, response.choiceId)
      : "",
  );
  return {
    outcome: "defaulted",
    askId,
    responses,
    defaultedAt,
    note: userAskDefaultedNote(labels),
  };
};

export const validateUserAskResponses = (
  detail: UserAskDetail,
  input: unknown,
): readonly UserAskQuestionResponse[] => {
  if (detail.kind !== "question") {
    throw new Error("This ask needs field values, not answers to questions.");
  }
  const rows = Array.isArray(input) ? input : [];
  const byId = new Map<string, UserAskQuestionResponse>();
  for (const row of rows) {
    const source = (row ?? {}) as Record<string, unknown>;
    const id = typeof source.questionId === "string" ? source.questionId : "";
    const question = detail.questions.find((candidate) => candidate.id === id);
    if (!question) throw new Error("That answer is for a question this ask did not ask.");
    if (byId.has(id)) throw new Error("That question was answered twice.");
    if (source.kind === "option") {
      const choiceId = typeof source.choiceId === "string" ? source.choiceId : "";
      if (!question.options.some((option) => option.id === choiceId)) {
        throw new Error("That is not one of the offered options.");
      }
      byId.set(id, { questionId: id, kind: "option", choiceId });
      continue;
    }
    if (source.kind === "text") {
      const text =
        typeof source.text === "string"
          ? source.text.trim().slice(0, USER_ASK_MAX_RESPONSE_TEXT)
          : "";
      byId.set(
        id,
        text ? { questionId: id, kind: "text", text } : { questionId: id, kind: "skipped" },
      );
      continue;
    }
    if (source.kind === "skipped") {
      byId.set(id, { questionId: id, kind: "skipped" });
      continue;
    }
    throw new Error("That answer does not match the question.");
  }
  return detail.questions.map(
    (question) =>
      byId.get(question.id) ?? { questionId: question.id, kind: "skipped" as const },
  );
};

export type UserAskReadableAnswer = Readonly<{
  question: string;
  choice?: string;
  label?: string;
  text?: string;
  skipped?: true;
  note?: string;
}>;

export const userAskReadableAnswers = (
  questions: readonly UserAskQuestion[],
  responses: readonly UserAskQuestionResponse[],
): readonly UserAskReadableAnswer[] =>
  questions.map((question) => {
    const response = responses.find((entry) => entry.questionId === question.id);
    if (!response || response.kind === "skipped") {
      return { question: question.question, skipped: true, note: USER_ASK_SKIPPED_NOTE };
    }
    if (response.kind === "text") {
      return { question: question.question, text: response.text };
    }
    return {
      question: question.question,
      choice: response.choiceId,
      label: userAskOptionLabel(question, response.choiceId),
    };
  });

export const toUserAskSummary = (ask: UserAsk): UserAskSummary => ({
  schemaVersion: ask.schemaVersion,
  askId: ask.askId,
  kind: ask.kind,
  conversationId: ask.conversationId,
  threadId: ask.threadId,
  state: ask.state,
  urgency: ask.urgency,
  escalationLevel: ask.escalationLevel,
  blocking: ask.blocking,
  revision: ask.revision,
  createdAt: ask.createdAt,
  updatedAt: ask.updatedAt,
  title: userAskTitleOf(ask.detail),
  ...(ask.deadlineAt === undefined ? {} : { deadlineAt: ask.deadlineAt }),
});

export const USER_ASK_SEAL_PURPOSE = "stella-user-ask-secure-input" as const;

export const USER_ASK_SEAL_PUBLIC_KEY_BYTES = 32;
export const USER_ASK_SEAL_IV_BYTES = 12;
export const USER_ASK_SEAL_TAG_BYTES = 16;
export const USER_ASK_SEAL_KEY_BYTES = 32;
export const USER_ASK_SEAL_MAX_PLAINTEXT_BYTES = 4096;

export type UserAskSealBinding = Readonly<{
  askId: string;
  keyId: string;
  fieldId: string;
}>;

export type UserAskSealKdfInputs = Readonly<{
  aad: Uint8Array;
  salt: Uint8Array;
  info: Uint8Array;
  keyLengthBytes: number;
}>;

const sealStableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => sealStableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${sealStableJson(entry)}`)
    .join(",")}}`;
};

const sealUtf8Bytes = (value: string): Uint8Array => {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (codePoint - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        index += 1;
      }
    }
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
};

export const userAskSealAadString = (binding: UserAskSealBinding): string =>
  sealStableJson({
    schemaVersion: USER_ASK_SCHEMA_VERSION,
    purpose: USER_ASK_SEAL_PURPOSE,
    algorithm: USER_ASK_SEAL_ALGORITHM,
    askId: binding.askId,
    keyId: binding.keyId,
    fieldId: binding.fieldId,
  });

export const userAskSealAad = (binding: UserAskSealBinding): Uint8Array =>
  sealUtf8Bytes(userAskSealAadString(binding));

export const userAskSealSalt = (aadSha256Hex: string): Uint8Array =>
  sealUtf8Bytes(aadSha256Hex.trim().toLowerCase());

export const userAskSealKdfInputs = (args: {
  binding: UserAskSealBinding;
  sha256Hex: (bytes: Uint8Array) => string;
}): UserAskSealKdfInputs => {
  const aad = userAskSealAad(args.binding);
  return {
    aad,
    salt: userAskSealSalt(args.sha256Hex(aad)),
    info: aad,
    keyLengthBytes: USER_ASK_SEAL_KEY_BYTES,
  };
};

