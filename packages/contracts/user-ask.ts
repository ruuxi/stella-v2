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

export const USER_ASK_SOMETHING_ELSE_OPTION_ID = "something_else";

export const USER_ASK_MIN_OPTIONS = 2;
export const USER_ASK_MAX_OPTIONS = 4;

export const USER_ASK_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const USER_ASK_MIN_TIMEOUT_MS = 30_000;
export const USER_ASK_MAX_TIMEOUT_MS = 24 * 60 * 60_000;
export const USER_ASK_BLOCKING_TTL_MS = 24 * 60 * 60_000;

export const USER_ASK_ESCALATION_STEP_MS = 90_000;

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

export type UserAskQuestionDetail = Readonly<{
  kind: "question";
  question: string;
  detail?: string;
  options: readonly UserAskOption[];
  defaultChoiceId?: string;
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

export type UserAskAnswer =
  | Readonly<{
      askId: string;
      revision: number;
      kind: "choice";
      choiceId: string;
      text?: string;
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
      choiceId?: string;
      text?: string;
      values?: Readonly<Record<string, string>>;
      handles?: Readonly<Record<string, string>>;
      answeredAt: number;
      late?: boolean;
    }>
  | Readonly<{
      outcome: "defaulted";
      askId: string;
      choiceId: string;
      choiceLabel: string;
      defaultedAt: number;
      note: string;
    }>
  | Readonly<{
      outcome: "canceled" | "expired";
      askId: string;
      at: number;
      note: string;
    }>;

export const userAskDefaultedNote = (choiceLabel: string): string =>
  `Went with "${choiceLabel}" — you didn't answer in time. Tell me if you want something else and I'll adapt.`;

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

export const withSomethingElseOption = (
  options: readonly UserAskOption[],
  label: string,
): readonly UserAskOption[] =>
  options.some((option) => option.id === USER_ASK_SOMETHING_ELSE_OPTION_ID)
    ? options
    : [...options, { id: USER_ASK_SOMETHING_ELSE_OPTION_ID, label }];

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
  title:
    ask.detail.kind === "question" ? ask.detail.question : ask.detail.purpose,
  ...(ask.deadlineAt === undefined ? {} : { deadlineAt: ask.deadlineAt }),
});
