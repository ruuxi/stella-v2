import {
  DEFAULT_USER_ASK_ESCALATION_POLICY,
  USER_ASK_BLOCKING_TTL_MS,
  USER_ASK_ESCALATION_STEP_MS,
  USER_ASK_FIELD_TYPES,
  USER_ASK_KINDS,
  USER_ASK_MAX_FIELDS,
  USER_ASK_MAX_OPTIONS,
  USER_ASK_MAX_PER_HOUR_LIMIT,
  USER_ASK_MAX_QUESTIONS,
  USER_ASK_MAX_RESPONSE_TEXT,
  USER_ASK_RESPONSE_KINDS,
  USER_ASK_MIN_OPTIONS,
  USER_ASK_PUSH_CATEGORY,
  USER_ASK_PUSH_KIND,
  USER_ASK_SCHEMA_VERSION,
  USER_ASK_SEAL_ALGORITHM,
  clampUrgency,
  clampUserAskTimeoutMs,
  effectiveEscalationCeiling,
  nextEscalationLevel,
  normalizeUserAskEscalationPolicy,
  normalizeUserAskQuestions,
  toUserAskSummary,
  userAskAcceptsAnswer,
  userAskHasDefaults,
  userAskIsOpen,
  userAskTitleOf,
  validateUserAskResponses,
  type UserAsk,
  type UserAskAnswer,
  type UserAskAnswerFieldValue,
  type UserAskDetail,
  type UserAskEscalationPolicy,
  type UserAskField,
  type UserAskKind,
  type UserAskPushPayload,
  type UserAskQuestionResponse,
  type UserAskRecipientKey,
  type UserAskSealedValue,
  type UserAskState,
  type UserAskSummary,
  type UserAskUrgencyLevel,
} from "@stella/contracts/user-ask";
import {
  array,
  boolean,
  empty,
  json,
  literal,
  number,
  object,
  optional,
  string,
  type Parser,
} from "../args.js";
import { RpcError } from "../errors.js";
import { enforceOwnerRateLimit } from "../rate-limit.js";
import type {
  OwnerCaller,
  OwnerContext,
  OwnerDbReader,
  OwnerDomain,
} from "../registry.js";
import { livePushTokens } from "./devices.js";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const MAX_OPEN_ASKS = 32;
const MAX_SEALED_CIPHERTEXT = 16 * 1024;
const MAX_PLAIN_VALUE = 4 * 1024;
const RESOLVED_WINDOW_MS = 10 * 60_000;
const MAX_RESOLVED = 24;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const PUSH_WINDOW_MS = 60 * 60_000;
const PUSH_RETENTION_MS = 25 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const MINUTES_PER_DAY = 24 * 60;
const PUSH_LEVEL_FLOOR = 2;
const BREAKTHROUGH_LEVEL = 4;
const SOUND_LEVEL = 3;
const ANDROID_CHANNEL = "user-ask";
const ANDROID_BREAKTHROUGH_CHANNEL = "user-ask-breakthrough";

export const USER_ASK_CLOUD_ORIGIN_DEVICE_ID = "stella-cloud";

const isCloudOrigin = (originDeviceId: string): boolean =>
  originDeviceId === USER_ASK_CLOUD_ORIGIN_DEVICE_ID;

export const USER_ASKS_DEFAULT_JOB = "userAsks.default";
export const USER_ASKS_EXPIRE_JOB = "userAsks.expire";
export const USER_ASKS_REPEAT_JOB = "userAsks.repeat";
export const USER_ASKS_SWEEP_JOB = "userAsks.sweep";
export const USER_ASKS_CLOUD_ESCALATE_JOB = "userAsks.cloudEscalate";

export const USER_ASKS_MIGRATION = {
  id: "userAsks.1-init",
  statements: [
    `CREATE TABLE user_asks (
       ask_id TEXT PRIMARY KEY,
       kind TEXT NOT NULL,
       conversation_id TEXT NOT NULL,
       thread_id TEXT NOT NULL,
       tool_call_id TEXT NOT NULL,
       agent_label TEXT,
       origin_device_id TEXT NOT NULL,
       state TEXT NOT NULL,
       urgency INTEGER NOT NULL,
       escalation_level INTEGER NOT NULL,
       blocking INTEGER NOT NULL,
       deadline_at INTEGER,
       expires_at INTEGER NOT NULL,
       revision INTEGER NOT NULL,
       next_escalation_at INTEGER,
       local_offset_minutes INTEGER,
       detail TEXT NOT NULL,
       recipient_key TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE UNIQUE INDEX user_asks_tool_call ON user_asks (tool_call_id)`,
    `CREATE INDEX user_asks_state ON user_asks (state, created_at DESC)`,
    `CREATE TABLE user_ask_answers (
       ask_id TEXT PRIMARY KEY,
       answer_kind TEXT NOT NULL,
       choice_id TEXT,
       answer_text TEXT,
       fields TEXT,
       answered_on_device_id TEXT,
       late INTEGER NOT NULL,
       answered_at INTEGER NOT NULL
     )`,
    `CREATE TABLE user_ask_policy (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       policy TEXT NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE user_ask_pushes (
       push_id TEXT PRIMARY KEY,
       ask_id TEXT NOT NULL,
       level INTEGER NOT NULL,
       sent_at INTEGER NOT NULL
     )`,
    `CREATE INDEX user_ask_pushes_sent_at ON user_ask_pushes (sent_at DESC)`,
  ],
};

export const USER_ASKS_POLICY_TIME_ZONE_MIGRATION = {
  id: "userAsks.2-policy-time-zone",
  statements: [`ALTER TABLE user_ask_policy ADD COLUMN time_zone TEXT`],
};

export const USER_ASKS_ANSWER_REVISION_MIGRATION = {
  id: "userAsks.3-answer-revision",
  statements: [`ALTER TABLE user_ask_answers ADD COLUMN answer_revision INTEGER`],
};

export const USER_ASKS_QUESTION_RESPONSES_MIGRATION = {
  id: "userAsks.4-question-responses",
  statements: [`ALTER TABLE user_ask_answers ADD COLUMN responses TEXT`],
};

type AskRow = {
  ask_id: string;
  kind: string;
  conversation_id: string;
  thread_id: string;
  tool_call_id: string;
  agent_label: string | null;
  origin_device_id: string;
  state: string;
  urgency: number;
  escalation_level: number;
  blocking: number;
  deadline_at: number | null;
  expires_at: number;
  revision: number;
  next_escalation_at: number | null;
  local_offset_minutes: number | null;
  detail: string;
  recipient_key: string | null;
  created_at: number;
  updated_at: number;
};

type AnswerRow = {
  ask_id: string;
  answer_kind: string;
  choice_id: string | null;
  answer_text: string | null;
  fields: string | null;
  answered_on_device_id: string | null;
  late: number;
  answered_at: number;
  answer_revision: number | null;
  responses: string | null;
};

type StoredAnswer = {
  answer: UserAskAnswer;
  late: boolean;
  answeredAt: number;
};

const defaultJobId = (askId: string): string => `${USER_ASKS_DEFAULT_JOB}:${askId}`;
const expireJobId = (askId: string): string => `${USER_ASKS_EXPIRE_JOB}:${askId}`;
const repeatJobId = (askId: string): string => `${USER_ASKS_REPEAT_JOB}:${askId}`;
const cloudEscalateJobId = (askId: string): string =>
  `${USER_ASKS_CLOUD_ESCALATE_JOB}:${askId}`;

const log = (event: string, fields: Record<string, unknown>): void =>
  console.error(JSON.stringify({ service: "owner-user-asks", event, ...fields }));

const requireAccountCaller = (caller: OwnerCaller | null): OwnerCaller => {
  if (!caller || caller.isAnonymous) {
    throw new RpcError("FORBIDDEN", "Sign in with an account to use this.");
  }
  return caller;
};

const utcMinuteOfDay = (now: number): number =>
  Math.floor(now / 60_000) % MINUTES_PER_DAY;

const localMinuteOf = (now: number, offsetMinutes: number | null): number => {
  const base = utcMinuteOfDay(now) + (offsetMinutes ?? 0);
  return ((base % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
};

const minuteOfDayInZone = (now: number, timeZone: string | null): number | null => {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return ((hour % 24) * 60 + minute) % MINUTES_PER_DAY;
  } catch {
    return null;
  }
};

const isUsableTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const quietHoursMinute = (
  ctx: Pick<OwnerContext, "db" | "now">,
  fallbackOffsetMinutes: number | null,
): number => {
  const timeZone = readPolicyTimeZone(ctx.db);
  if (timeZone) {
    const minute = minuteOfDayInZone(ctx.now, timeZone);
    if (minute !== null) return minute;
    log("user_ask_policy_time_zone_unusable", { timeZone });
    return localMinuteOf(ctx.now, null);
  }
  return localMinuteOf(ctx.now, fallbackOffsetMinutes);
};

const offsetFromLocalMinute = (
  now: number,
  localMinuteOfDay: number | undefined,
): number | null => {
  if (localMinuteOfDay === undefined) return null;
  const difference = localMinuteOfDay - utcMinuteOfDay(now);
  return ((difference % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
};

const parseDetail = (row: AskRow): UserAskDetail => {
  const stored = JSON.parse(row.detail) as UserAskDetail;
  return stored.kind === "question"
    ? { kind: "question", questions: normalizeUserAskQuestions(stored) }
    : stored;
};

const legacyChoiceResponses = (
  row: AnswerRow,
  detail: UserAskDetail | null,
): readonly UserAskQuestionResponse[] => {
  const questionId =
    detail?.kind === "question" ? (detail.questions[0]?.id ?? "q1") : "q1";
  if (row.answer_text) {
    return [{ questionId, kind: "text", text: row.answer_text }];
  }
  return row.choice_id
    ? [{ questionId, kind: "option", choiceId: row.choice_id }]
    : [{ questionId, kind: "skipped" }];
};

const rowToAsk = (row: AskRow): UserAsk => ({
  schemaVersion: USER_ASK_SCHEMA_VERSION,
  askId: row.ask_id,
  kind: row.kind as UserAskKind,
  conversationId: row.conversation_id,
  threadId: row.thread_id,
  toolCallId: row.tool_call_id,
  ...(row.agent_label ? { agentLabel: row.agent_label } : {}),
  originDeviceId: row.origin_device_id,
  revision: row.revision,
  state: row.state as UserAskState,
  urgency: clampUrgency(row.urgency),
  escalationLevel: clampUrgency(row.escalation_level),
  blocking: row.blocking === 1,
  ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.next_escalation_at === null
    ? {}
    : { nextEscalationAt: row.next_escalation_at }),
  detail: parseDetail(row),
  ...(row.recipient_key
    ? { recipientKey: JSON.parse(row.recipient_key) as UserAskRecipientKey }
    : {}),
});

const summaryOf = (row: AskRow): UserAskSummary => toUserAskSummary(rowToAsk(row));

const readRow = (db: OwnerDbReader, askId: string): AskRow | null =>
  db.one<AskRow>("SELECT * FROM user_asks WHERE ask_id = ?", askId);

const readAnswer = (db: OwnerDbReader, askId: string): StoredAnswer | null => {
  const row = db.one<AnswerRow>(
    "SELECT * FROM user_ask_answers WHERE ask_id = ?",
    askId,
  );
  if (!row) return null;
  const askRow = row.answer_kind === "fields" ? null : readRow(db, askId);
  const revision = row.answer_revision ?? 1;
  const answeredOnDeviceId = row.answered_on_device_id
    ? { answeredOnDeviceId: row.answered_on_device_id }
    : {};
  const answer: UserAskAnswer =
    row.answer_kind === "fields"
      ? {
          askId: row.ask_id,
          revision,
          kind: "fields",
          fields: row.fields
            ? (JSON.parse(row.fields) as readonly UserAskAnswerFieldValue[])
            : [],
          ...answeredOnDeviceId,
        }
      : {
          askId: row.ask_id,
          revision,
          kind: "questions",
          responses: row.responses
            ? (JSON.parse(row.responses) as readonly UserAskQuestionResponse[])
            : legacyChoiceResponses(row, askRow ? parseDetail(askRow) : null),
          ...answeredOnDeviceId,
        };
  return { answer, late: row.late === 1, answeredAt: row.answered_at };
};

export const listOpenUserAsks = (db: OwnerDbReader): UserAsk[] =>
  db
    .all<AskRow>(
      `SELECT * FROM user_asks WHERE state IN ('pending', 'defaulted')
       ORDER BY urgency DESC, created_at ASC LIMIT ?`,
      MAX_OPEN_ASKS,
    )
    .map(rowToAsk);

const openAsks = (db: OwnerDbReader): AskRow[] =>
  db.all<AskRow>(
    `SELECT * FROM user_asks WHERE state IN ('pending', 'defaulted')
     ORDER BY urgency DESC, created_at ASC LIMIT ?`,
    MAX_OPEN_ASKS,
  );

const resolvedAsks = (db: OwnerDbReader, now: number): AskRow[] =>
  db.all<AskRow>(
    `SELECT * FROM user_asks WHERE state NOT IN ('pending', 'defaulted') AND updated_at >= ?
     ORDER BY updated_at DESC LIMIT ?`,
    now - RESOLVED_WINDOW_MS,
    MAX_RESOLVED,
  );

const readPolicy = (db: OwnerDbReader): UserAskEscalationPolicy => {
  const row = db.one<{ policy: string; time_zone: string | null }>(
    "SELECT policy, time_zone FROM user_ask_policy WHERE id = 1",
  );
  if (!row) return DEFAULT_USER_ASK_ESCALATION_POLICY;
  let stored: unknown = {};
  try {
    stored = JSON.parse(row.policy);
  } catch {
    stored = {};
  }
  return normalizeUserAskEscalationPolicy({
    ...(stored && typeof stored === "object" ? stored : {}),
    timeZone: row.time_zone ?? undefined,
  });
};

export const readPolicyTimeZone = (db: OwnerDbReader): string | null =>
  db.one<{ time_zone: string | null }>(
    "SELECT time_zone FROM user_ask_policy WHERE id = 1",
  )?.time_zone ?? null;

const writePolicy = (
  ctx: OwnerContext,
  policy: UserAskEscalationPolicy,
  timeZone: string | null,
): UserAskEscalationPolicy => {
  ctx.db.run(
    `INSERT INTO user_ask_policy (id, policy, time_zone, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET policy = excluded.policy, time_zone = excluded.time_zone,
       updated_at = excluded.updated_at`,
    JSON.stringify(policy),
    timeZone,
    ctx.now,
  );
  return policy;
};

const optionParser = object({
  id: string({ min: 1, max: 64 }),
  label: string({ min: 1, max: 240 }),
  hint: optional(string({ max: 240 })),
});

const fieldParser = object({
  id: string({ min: 1, max: 64 }),
  label: string({ min: 1, max: 240 }),
  type: literal(...USER_ASK_FIELD_TYPES),
  sensitive: boolean(),
  placeholder: optional(string({ max: 240 })),
  hint: optional(string({ max: 240 })),
  optional: optional(boolean()),
  choices: optional(array(optionParser, { max: USER_ASK_MAX_OPTIONS })),
});

const questionParser = object({
  id: string({ min: 1, max: 64 }),
  question: string({ min: 1, max: 2_000 }),
  detail: optional(string({ max: 4_000 })),
  options: array(optionParser, { max: USER_ASK_MAX_OPTIONS }),
  defaultChoiceId: optional(string({ max: 64 })),
});

const questionDetailParser = object({
  kind: literal("question"),
  questions: array(questionParser, { max: USER_ASK_MAX_QUESTIONS }),
});

const legacyQuestionDetailParser = object({
  kind: literal("question"),
  question: string({ min: 1, max: 2_000 }),
  detail: optional(string({ max: 4_000 })),
  options: array(optionParser, { max: USER_ASK_MAX_OPTIONS + 1 }),
  defaultChoiceId: optional(string({ max: 64 })),
});

const parseQuestionDetail = (raw: unknown) => {
  if (raw && typeof raw === "object" && "questions" in raw) {
    return questionDetailParser(raw, "detail");
  }
  return {
    kind: "question" as const,
    questions: normalizeUserAskQuestions(legacyQuestionDetailParser(raw, "detail")),
  };
};

const secureInputDetailParser = object({
  kind: literal("secure_input"),
  purpose: string({ min: 1, max: 2_000 }),
  detail: optional(string({ max: 4_000 })),
  fields: array(fieldParser, { max: USER_ASK_MAX_FIELDS }),
});

const recipientKeyParser = object({
  algorithm: literal(USER_ASK_SEAL_ALGORITHM),
  keyId: string({ min: 1, max: 128 }),
  publicKey: string({ min: 1, max: 256 }),
});

const sealedParser = object({
  algorithm: literal(USER_ASK_SEAL_ALGORITHM),
  keyId: string({ min: 1, max: 128 }),
  clientPublicKey: string({ min: 1, max: 256 }),
  iv: string({ min: 1, max: 128 }),
  ciphertext: string({ min: 1, max: MAX_SEALED_CIPHERTEXT }),
});

const registerParser = object({
  askId: string({ min: 1, max: 128 }),
  kind: literal(...USER_ASK_KINDS),
  conversationId: string({ min: 1, max: 128 }),
  threadId: string({ min: 1, max: 128 }),
  toolCallId: string({ min: 1, max: 160 }),
  agentLabel: optional(string({ max: 96 })),
  originDeviceId: string({ min: 1, max: 256 }),
  urgency: optional(number({ int: true, min: 1, max: 4 })),
  blocking: optional(boolean()),
  timeoutMs: optional(number({ int: true, min: 0, max: USER_ASK_BLOCKING_TTL_MS })),
  localMinuteOfDay: optional(number({ int: true, min: 0, max: MINUTES_PER_DAY - 1 })),
  detail: json({ maxBytes: 32 * 1024 }),
  recipientKey: optional(recipientKeyParser),
});

const answerFieldParser: Parser<UserAskAnswerFieldValue> = (value, path = "") => {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "sealed") {
    return object({
      fieldId: string({ min: 1, max: 64 }),
      kind: literal("sealed"),
      sealed: sealedParser,
    })(value, path);
  }
  return object({
    fieldId: string({ min: 1, max: 64 }),
    kind: literal("plain"),
    value: string({ max: MAX_PLAIN_VALUE }),
  })(value, path);
};

const responseParser: Parser<UserAskQuestionResponse> = (value, path = "") => {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "option") {
    return object({
      questionId: string({ min: 1, max: 64 }),
      kind: literal("option"),
      choiceId: string({ min: 1, max: 64 }),
    })(value, path);
  }
  if (kind === "text") {
    return object({
      questionId: string({ min: 1, max: 64 }),
      kind: literal("text"),
      text: string({ max: USER_ASK_MAX_RESPONSE_TEXT }),
    })(value, path);
  }
  return object({
    questionId: string({ min: 1, max: 64 }),
    kind: literal(...USER_ASK_RESPONSE_KINDS),
  })(value, path) as UserAskQuestionResponse;
};

const answerParser: Parser<UserAskAnswer> = (value, path = "") => {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "fields") {
    return object({
      askId: string({ min: 1, max: 128 }),
      revision: number({ int: true, min: 1 }),
      kind: literal("fields"),
      fields: array(answerFieldParser, { max: USER_ASK_MAX_FIELDS }),
      answeredOnDeviceId: optional(string({ max: 256 })),
    })(value, path);
  }
  return object({
    askId: string({ min: 1, max: 128 }),
    revision: number({ int: true, min: 1 }),
    kind: literal("questions"),
    responses: array(responseParser, { max: USER_ASK_MAX_QUESTIONS }),
    answeredOnDeviceId: optional(string({ max: 256 })),
  })(value, path);
};

const escalateParser = object({
  level: number({ int: true, min: 1, max: 4 }),
  deviceId: optional(string({ max: 256 })),
  localMinuteOfDay: optional(number({ int: true, min: 0, max: MINUTES_PER_DAY - 1 })),
});

const policyParser = object({
  schemaVersion: optional(number({ int: true, min: 1, max: 1_000 })),
  ceiling: optional(number({ int: true, min: 1, max: 4 })),
  soundEnabled: optional(boolean()),
  quietHours: optional(
    object({
      enabled: optional(boolean()),
      startMinute: optional(number({ int: true, min: 0, max: MINUTES_PER_DAY - 1 })),
      endMinute: optional(number({ int: true, min: 0, max: MINUTES_PER_DAY - 1 })),
    }),
  ),
  quietHoursCeiling: optional(number({ int: true, min: 1, max: 4 })),
  maxPerHour: optional(
    number({ int: true, min: 1, max: USER_ASK_MAX_PER_HOUR_LIMIT }),
  ),
  timeZone: optional(
    string({ max: 64, pattern: /^$|^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+)*$/ }),
  ),
});

const uniqueIds = (ids: readonly string[], what: string): void => {
  if (new Set(ids).size !== ids.length) {
    throw new RpcError("BAD_REQUEST", `Duplicate ${what} id.`);
  }
};

const validateDetail = (
  kind: UserAskKind,
  raw: unknown,
  recipientKey: UserAskRecipientKey | undefined,
): UserAskDetail => {
  if (kind === "question") {
    const detail = parseQuestionDetail(raw);
    if (detail.questions.length === 0) {
      throw new RpcError("BAD_REQUEST", "A question ask needs at least one question.");
    }
    uniqueIds(
      detail.questions.map((question) => question.id),
      "question",
    );
    for (const question of detail.questions) {
      if (
        question.options.length < USER_ASK_MIN_OPTIONS ||
        question.options.length > USER_ASK_MAX_OPTIONS
      ) {
        throw new RpcError(
          "BAD_REQUEST",
          `A question needs between ${USER_ASK_MIN_OPTIONS} and ${USER_ASK_MAX_OPTIONS} options.`,
        );
      }
      uniqueIds(
        question.options.map((option) => option.id),
        "option",
      );
      if (
        question.defaultChoiceId !== undefined &&
        !question.options.some((option) => option.id === question.defaultChoiceId)
      ) {
        throw new RpcError("BAD_REQUEST", "defaultChoiceId is not one of the options.");
      }
    }
    return detail as UserAskDetail;
  }
  const detail = secureInputDetailParser(raw, "detail");
  if (detail.fields.length === 0) {
    throw new RpcError("BAD_REQUEST", "A secure input needs at least one field.");
  }
  uniqueIds(
    detail.fields.map((field) => field.id),
    "field",
  );
  for (const field of detail.fields) {
    if (field.type === "choice" && (field.choices ?? []).length === 0) {
      throw new RpcError("BAD_REQUEST", "A choice field needs choices.");
    }
    if (field.sensitive && !recipientKey) {
      throw new RpcError(
        "BAD_REQUEST",
        "A sensitive field needs the asking device's recipientKey.",
      );
    }
  }
  return detail as UserAskDetail;
};

const fieldsOf = (detail: UserAskDetail): readonly UserAskField[] =>
  detail.kind === "secure_input" ? detail.fields : [];

const sealedMatchesAsk = (
  sealed: UserAskSealedValue,
  recipientKey: UserAskRecipientKey | undefined,
): boolean =>
  recipientKey !== undefined &&
  sealed.algorithm === recipientKey.algorithm &&
  sealed.keyId === recipientKey.keyId;

const validateAnswer = (
  ask: UserAsk,
  answer: UserAskAnswer,
): readonly UserAskQuestionResponse[] | null => {
  if (answer.kind === "questions") {
    try {
      return validateUserAskResponses(ask.detail, answer.responses);
    } catch (error) {
      throw new RpcError("BAD_REQUEST", (error as Error).message);
    }
  }
  if (ask.detail.kind !== "secure_input") {
    throw new RpcError("BAD_REQUEST", "This ask needs a choice, not field values.");
  }
  const fields = fieldsOf(ask.detail);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  for (const value of answer.fields) {
    const field = byId.get(value.fieldId);
    if (!field) {
      throw new RpcError("BAD_REQUEST", "That field is not part of this ask.");
    }
    if (seen.has(value.fieldId)) {
      throw new RpcError("BAD_REQUEST", "That field was answered twice.");
    }
    seen.add(value.fieldId);
    if (field.sensitive) {
      if (value.kind !== "sealed") {
        throw new RpcError(
          "BAD_REQUEST",
          "A sensitive value must be sealed for the asking device.",
        );
      }
      if (!sealedMatchesAsk(value.sealed, ask.recipientKey)) {
        throw new RpcError(
          "BAD_REQUEST",
          "That sealed value was not sealed for this ask's key.",
        );
      }
      continue;
    }
    if (value.kind !== "plain") {
      throw new RpcError("BAD_REQUEST", "That field does not take a sealed value.");
    }
    if (field.type === "choice") {
      const choices = field.choices ?? [];
      if (!choices.some((choice) => choice.id === value.value)) {
        throw new RpcError("BAD_REQUEST", "That value is not one of the field's choices.");
      }
    }
  }
  for (const field of fields) {
    if (!field.optional && !seen.has(field.id)) {
      throw new RpcError("BAD_REQUEST", `${field.label} is required.`);
    }
  }
  return null;
};

const pushCopy = (row: AskRow): { title: string; body: string } => {
  const detail = parseDetail(row);
  const who = row.agent_label ? `${row.agent_label} needs you` : "Stella needs you";
  const questions = detail.kind === "question" ? detail.questions.length : 0;
  const text =
    questions > 1
      ? `${userAskTitleOf(detail)} (+${questions - 1} more)`
      : userAskTitleOf(detail);
  return { title: who, body: text.slice(0, 240) };
};

const pushesInWindow = (ctx: OwnerContext): number =>
  ctx.db.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM user_ask_pushes WHERE sent_at >= ?",
    ctx.now - PUSH_WINDOW_MS,
  )?.n ?? 0;

const recordPush = (ctx: OwnerContext, row: AskRow, level: number): void => {
  ctx.db.run(
    "INSERT INTO user_ask_pushes (push_id, ask_id, level, sent_at) VALUES (?, ?, ?, ?)",
    crypto.randomUUID(),
    row.ask_id,
    level,
    ctx.now,
  );
};

type PushOutcome = "sent" | "no_push_target" | "send_failed";

const sendAskPush = async (
  ctx: OwnerContext,
  row: AskRow,
  level: UserAskUrgencyLevel,
  policy: UserAskEscalationPolicy,
): Promise<PushOutcome> => {
  const tokens = livePushTokens(ctx);
  if (tokens.length === 0) return "no_push_target";
  const copy = pushCopy(row);
  const payload: UserAskPushPayload = {
    kind: USER_ASK_PUSH_KIND,
    askId: row.ask_id,
    conversationId: row.conversation_id,
    level,
  };
  const breakthrough = level >= BREAKTHROUGH_LEVEL;
  const sound = policy.soundEnabled && level >= SOUND_LEVEL;
  const thread = `${USER_ASK_PUSH_CATEGORY}:${row.ask_id}`;
  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(
      tokens.map(({ token }) => ({
        to: token,
        title: copy.title,
        body: copy.body,
        data: payload,
        categoryId: USER_ASK_PUSH_CATEGORY,
        threadId: thread,
        collapseId: thread,
        priority: "high",
        ttl: breakthrough ? 0 : 60 * 60,
        channelId: breakthrough ? ANDROID_BREAKTHROUGH_CHANNEL : ANDROID_CHANNEL,
        interruptionLevel: breakthrough
          ? "critical"
          : level >= SOUND_LEVEL
            ? "timeSensitive"
            : "active",
        ...(sound ? { sound: "default" } : {}),
        ...(breakthrough ? { badge: 1 } : {}),
      })),
    ),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!response?.ok) {
    log("user_ask_push_failed", { askId: row.ask_id, level });
    return "send_failed";
  }
  const parsed = (await response.json().catch(() => null)) as {
    data?: Array<{ status?: string; details?: { error?: string } }>;
  } | null;
  (parsed?.data ?? []).forEach((ticket, index) => {
    const error = ticket?.details?.error;
    if (
      ticket?.status === "error" &&
      (error === "DeviceNotRegistered" || error === "InvalidCredentials")
    ) {
      ctx.db.run("DELETE FROM push_tokens WHERE token = ?", tokens[index]!.token);
    }
  });
  recordPush(ctx, row, level);
  return "sent";
};

const closeAsk = (
  ctx: OwnerContext,
  row: AskRow,
  state: UserAskState,
): AskRow => {
  ctx.db.run(
    `UPDATE user_asks SET state = ?, revision = revision + 1, next_escalation_at = NULL,
       updated_at = ? WHERE ask_id = ?`,
    state,
    ctx.now,
    row.ask_id,
  );
  ctx.jobs.cancel(defaultJobId(row.ask_id));
  ctx.jobs.cancel(expireJobId(row.ask_id));
  ctx.jobs.cancel(repeatJobId(row.ask_id));
  ctx.jobs.cancel(cloudEscalateJobId(row.ask_id));
  return readRow(ctx.db, row.ask_id)!;
};

const scheduleSweep = (ctx: OwnerContext): void => {
  ctx.jobs.schedule(USER_ASKS_SWEEP_JOB, ctx.now + SWEEP_INTERVAL_MS, null, {
    id: USER_ASKS_SWEEP_JOB,
  });
};

type RegisterArgs = ReturnType<typeof registerParser>;

const askView = (row: AskRow) => ({
  ...rowToAsk(row),
  title: summaryOf(row).title,
});

const resolvedView = (db: OwnerDbReader, row: AskRow) => {
  const stored = readAnswer(db, row.ask_id);
  return {
    ...askView(row),
    ...(stored
      ? {
          answer: stored.answer,
          late: stored.late,
          answeredAt: stored.answeredAt,
        }
      : {}),
  };
};

const registerAsk = (ctx: OwnerContext, args: RegisterArgs) => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "userAsks.register",
    { count: 60, windowMs: 60_000 },
    "Too many questions at once. Please wait a moment.",
  );
  const existing = readRow(ctx.db, args.askId);
  if (existing) {
    if (existing.tool_call_id !== args.toolCallId) {
      throw new RpcError("CONFLICT", "That ask id is already in use.");
    }
    return { ask: askView(existing), created: false };
  }
  const byToolCall = ctx.db.one<AskRow>(
    "SELECT * FROM user_asks WHERE tool_call_id = ?",
    args.toolCallId,
  );
  if (byToolCall) {
    throw new RpcError("CONFLICT", "That tool call already registered an ask.");
  }
  const open = ctx.db.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM user_asks WHERE state IN ('pending', 'defaulted')",
  )?.n ?? 0;
  if (open >= MAX_OPEN_ASKS) {
    throw new RpcError(
      "RATE_LIMITED",
      "Too many questions are already waiting for you.",
    );
  }
  const detail = validateDetail(args.kind, args.detail, args.recipientKey);
  const blocking = args.blocking ?? false;
  const timeout = clampUserAskTimeoutMs(args.timeoutMs);
  const urgency = clampUrgency(args.urgency ?? 1);
  const hasDefault = !blocking && userAskHasDefaults(detail);
  const deadlineAt = ctx.now + timeout;
  const expiresAt = ctx.now + USER_ASK_BLOCKING_TTL_MS;
  ctx.db.run(
    `INSERT INTO user_asks
       (ask_id, kind, conversation_id, thread_id, tool_call_id, agent_label, origin_device_id,
        state, urgency, escalation_level, blocking, deadline_at, expires_at, revision,
        next_escalation_at, local_offset_minutes, detail, recipient_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`,
    args.askId,
    args.kind,
    args.conversationId,
    args.threadId,
    args.toolCallId,
    args.agentLabel ?? null,
    args.originDeviceId,
    urgency,
    blocking ? 1 : 0,
    deadlineAt,
    expiresAt,
    offsetFromLocalMinute(ctx.now, args.localMinuteOfDay),
    JSON.stringify(detail),
    args.recipientKey ? JSON.stringify(args.recipientKey) : null,
    ctx.now,
    ctx.now,
  );
  if (hasDefault) {
    ctx.jobs.schedule(USER_ASKS_DEFAULT_JOB, deadlineAt, { askId: args.askId }, {
      id: defaultJobId(args.askId),
    });
  }
  ctx.jobs.schedule(USER_ASKS_EXPIRE_JOB, expiresAt, { askId: args.askId }, {
    id: expireJobId(args.askId),
  });
  if (isCloudOrigin(args.originDeviceId)) {
    ctx.jobs.schedule(
      USER_ASKS_CLOUD_ESCALATE_JOB,
      ctx.now + USER_ASK_ESCALATION_STEP_MS,
      { askId: args.askId },
      { id: cloudEscalateJobId(args.askId) },
    );
  }
  scheduleSweep(ctx);
  return { ask: askView(readRow(ctx.db, args.askId)!), created: true };
};

const answerAsk = (ctx: OwnerContext, askId: string, answer: UserAskAnswer) => {
  if (answer.askId !== askId) {
    throw new RpcError("BAD_REQUEST", "The answer is for a different ask.");
  }
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "userAsks.answer",
    { count: 120, windowMs: 60_000 },
    "Too many answers at once. Please wait a moment.",
  );
  const row = readRow(ctx.db, askId);
  if (!row) throw new RpcError("NOT_FOUND", "That question is no longer available.");
  const existing = readAnswer(ctx.db, askId);
  if (existing) {
    return {
      ask: summaryOf(row),
      answer: existing.answer,
      late: existing.late,
      answeredAt: existing.answeredAt,
      accepted: false,
    };
  }
  const state = row.state as UserAskState;
  if (!userAskAcceptsAnswer(state)) {
    throw new RpcError("CONFLICT", "That question was already closed.");
  }
  if (answer.revision !== row.revision) {
    throw new RpcError(
      "CONFLICT",
      "That question changed. Refresh it and answer again.",
    );
  }
  const ask = rowToAsk(row);
  const responses = validateAnswer(ask, answer);
  const late = state === "defaulted";
  ctx.db.run(
    `INSERT INTO user_ask_answers
       (ask_id, answer_kind, choice_id, answer_text, fields, answered_on_device_id, late,
        answered_at, answer_revision, responses)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    askId,
    answer.kind,
    answer.kind === "fields" ? JSON.stringify(answer.fields) : null,
    answer.answeredOnDeviceId ?? null,
    late ? 1 : 0,
    ctx.now,
    answer.revision,
    responses ? JSON.stringify(responses) : null,
  );
  const closed = closeAsk(ctx, row, late ? "answered_late" : "answered");
  const stored = readAnswer(ctx.db, askId)!;
  return {
    ask: summaryOf(closed),
    answer: stored.answer,
    late: stored.late,
    answeredAt: stored.answeredAt,
    accepted: true,
  };
};

const readAnswerForOriginDevice = (
  ctx: OwnerContext,
  askId: string,
  claimedDeviceId: string,
) => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "userAsks.readAnswer",
    { count: 120, windowMs: 60_000 },
    "Too many answer reads. Please wait a moment.",
  );
  const row = readRow(ctx.db, askId);
  if (!row) throw new RpcError("NOT_FOUND", "That question is no longer available.");
  if (!claimedDeviceId) {
    throw new RpcError(
      "FORBIDDEN",
      "Name the asking computer to read this answer.",
    );
  }
  if (claimedDeviceId !== row.origin_device_id) {
    throw new RpcError(
      "FORBIDDEN",
      "Only the computer that asked can read this answer.",
    );
  }
  const stored = readAnswer(ctx.db, askId);
  if (!stored) {
    throw new RpcError("NOT_FOUND", "That question has not been answered yet.");
  }
  return {
    answer: stored.answer,
    state: row.state as UserAskState,
    late: stored.late,
    answeredAt: stored.answeredAt,
  };
};

const cancelAsk = (ctx: OwnerContext, askId: string) => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "userAsks.cancel",
    { count: 120, windowMs: 60_000 },
    "Too many cancellations at once. Please wait a moment.",
  );
  const row = readRow(ctx.db, askId);
  if (!row) throw new RpcError("NOT_FOUND", "That question is no longer available.");
  if (!userAskIsOpen(row.state as UserAskState)) {
    return { ask: summaryOf(row), canceled: false };
  }
  return { ask: summaryOf(closeAsk(ctx, row, "canceled")), canceled: true };
};

const turnRegisterParser = object({
  askId: string({ min: 1, max: 128 }),
  kind: literal(...USER_ASK_KINDS),
  conversationId: string({ min: 1, max: 128 }),
  threadId: string({ min: 1, max: 128 }),
  toolCallId: string({ min: 1, max: 160 }),
  agentLabel: optional(string({ max: 96 })),
  urgency: optional(number({ int: true, min: 1, max: 4 })),
  blocking: optional(boolean()),
  timeoutMs: optional(number({ int: true, min: 0, max: USER_ASK_BLOCKING_TTL_MS })),
  detail: json({ maxBytes: 32 * 1024 }),
});

const turnAskParser = object({ askId: string({ min: 1, max: 128 }) });

const registerTurnAsk = (ctx: OwnerContext, args: unknown) => {
  const parsed = turnRegisterParser(args, "args");
  if (parsed.kind === "secure_input") {
    const detail = secureInputDetailParser(parsed.detail, "detail");
    if (detail.fields.some((field) => field.sensitive || field.type === "secret")) {
      throw new RpcError(
        "BAD_REQUEST",
        "A sensitive value can only be collected on one of the user's computers, not by a cloud agent.",
      );
    }
  }
  return registerAsk(ctx, {
    ...parsed,
    originDeviceId: USER_ASK_CLOUD_ORIGIN_DEVICE_ID,
  });
};

const readTurnAskAnswer = (ctx: OwnerContext, args: unknown) => {
  const { askId } = turnAskParser(args, "args");
  const row = readRow(ctx.db, askId);
  if (!row) throw new RpcError("NOT_FOUND", "That question is no longer available.");
  const stored = readAnswer(ctx.db, askId);
  return {
    askId,
    state: row.state as UserAskState,
    revision: row.revision,
    ...(stored
      ? {
          answer: stored.answer,
          late: stored.late,
          answeredAt: stored.answeredAt,
        }
      : {}),
  };
};

const cancelTurnAsk = (ctx: OwnerContext, args: unknown) => {
  const { askId } = turnAskParser(args, "args");
  const row = readRow(ctx.db, askId);
  if (!row) return { canceled: false };
  if (!userAskIsOpen(row.state as UserAskState)) return { canceled: false };
  closeAsk(ctx, row, "canceled");
  return { canceled: true };
};

type EscalateArgs = ReturnType<typeof escalateParser>;

type EscalateResult = {
  ask: UserAskSummary;
  level: UserAskUrgencyLevel;
  requested: UserAskUrgencyLevel;
  pushed: boolean;
  reason?: "closed" | "ceiling" | "max_per_hour" | "no_push_target" | "send_failed";
};

const escalateAsk = async (
  ctx: OwnerContext,
  askId: string,
  args: EscalateArgs,
): Promise<EscalateResult> => {
  enforceOwnerRateLimit(
    ctx.db,
    ctx.now,
    "userAsks.escalate",
    { count: 60, windowMs: 60_000 },
    "Too many escalations at once. Please wait a moment.",
  );
  const row = readRow(ctx.db, askId);
  if (!row) throw new RpcError("NOT_FOUND", "That question is no longer available.");
  if (
    args.deviceId !== undefined &&
    args.deviceId !== row.origin_device_id &&
    !isCloudOrigin(row.origin_device_id)
  ) {
    throw new RpcError("FORBIDDEN", "Only the asking computer can escalate this.");
  }
  const requested = clampUrgency(args.level);
  if (!userAskIsOpen(row.state as UserAskState)) {
    return { ask: summaryOf(row), level: clampUrgency(row.escalation_level), requested, pushed: false, reason: "closed" };
  }
  if (args.localMinuteOfDay !== undefined) {
    ctx.db.run(
      "UPDATE user_asks SET local_offset_minutes = ? WHERE ask_id = ?",
      offsetFromLocalMinute(ctx.now, args.localMinuteOfDay),
      askId,
    );
  }
  const offset =
    args.localMinuteOfDay === undefined
      ? row.local_offset_minutes
      : offsetFromLocalMinute(ctx.now, args.localMinuteOfDay);
  const policy = readPolicy(ctx.db);
  const allowed = effectiveEscalationCeiling(
    policy,
    requested,
    quietHoursMinute(ctx, offset),
  );
  const level = Math.max(allowed, clampUrgency(row.escalation_level)) as UserAskUrgencyLevel;
  const nextEscalationAt =
    allowed >= BREAKTHROUGH_LEVEL ? ctx.now + USER_ASK_ESCALATION_STEP_MS : null;
  ctx.db.run(
    `UPDATE user_asks SET escalation_level = ?, revision = revision + 1,
       next_escalation_at = ?, updated_at = ? WHERE ask_id = ?`,
    level,
    nextEscalationAt,
    ctx.now,
    askId,
  );
  const updated = readRow(ctx.db, askId)!;
  if (allowed < requested && allowed < PUSH_LEVEL_FLOOR) {
    ctx.jobs.cancel(repeatJobId(askId));
    return { ask: summaryOf(updated), level, requested, pushed: false, reason: "ceiling" };
  }
  if (allowed < PUSH_LEVEL_FLOOR) {
    ctx.jobs.cancel(repeatJobId(askId));
    return { ask: summaryOf(updated), level, requested, pushed: false };
  }
  if (pushesInWindow(ctx) >= policy.maxPerHour) {
    ctx.jobs.cancel(repeatJobId(askId));
    return {
      ask: summaryOf(updated),
      level,
      requested,
      pushed: false,
      reason: "max_per_hour",
    };
  }
  const outcome = await sendAskPush(ctx, updated, allowed, policy);
  if (allowed >= BREAKTHROUGH_LEVEL && outcome === "sent") {
    ctx.jobs.schedule(
      USER_ASKS_REPEAT_JOB,
      ctx.now + USER_ASK_ESCALATION_STEP_MS,
      { askId },
      { id: repeatJobId(askId) },
    );
  } else {
    ctx.jobs.cancel(repeatJobId(askId));
  }
  const result: EscalateResult = {
    ask: summaryOf(readRow(ctx.db, askId)!),
    level,
    requested,
    pushed: outcome === "sent",
  };
  if (outcome !== "sent") return { ...result, reason: outcome };
  if (allowed < requested) return { ...result, reason: "ceiling" };
  return result;
};

const repeatBreakthrough = async (
  ctx: OwnerContext,
  payload: unknown,
): Promise<void> => {
  const askId = (payload as { askId?: unknown } | null)?.askId;
  if (typeof askId !== "string") return;
  const row = readRow(ctx.db, askId);
  if (!row || row.state !== "pending") return;
  if (clampUrgency(row.escalation_level) < BREAKTHROUGH_LEVEL) return;
  const policy = readPolicy(ctx.db);
  const allowed = effectiveEscalationCeiling(
    policy,
    BREAKTHROUGH_LEVEL,
    quietHoursMinute(ctx, row.local_offset_minutes),
  );
  if (allowed < BREAKTHROUGH_LEVEL) {
    ctx.db.run(
      "UPDATE user_asks SET next_escalation_at = NULL, updated_at = ? WHERE ask_id = ?",
      ctx.now,
      askId,
    );
    return;
  }
  if (pushesInWindow(ctx) >= policy.maxPerHour) {
    ctx.db.run(
      "UPDATE user_asks SET next_escalation_at = NULL, updated_at = ? WHERE ask_id = ?",
      ctx.now,
      askId,
    );
    return;
  }
  const outcome = await sendAskPush(ctx, row, BREAKTHROUGH_LEVEL, policy);
  if (outcome === "no_push_target") {
    ctx.db.run(
      "UPDATE user_asks SET next_escalation_at = NULL, updated_at = ? WHERE ask_id = ?",
      ctx.now,
      askId,
    );
    return;
  }
  ctx.db.run(
    "UPDATE user_asks SET next_escalation_at = ?, updated_at = ? WHERE ask_id = ?",
    ctx.now + USER_ASK_ESCALATION_STEP_MS,
    ctx.now,
    askId,
  );
  ctx.jobs.schedule(
    USER_ASKS_REPEAT_JOB,
    ctx.now + USER_ASK_ESCALATION_STEP_MS,
    { askId },
    { id: repeatJobId(askId) },
  );
};

const escalateCloudAsk = async (
  ctx: OwnerContext,
  payload: unknown,
): Promise<void> => {
  const askId = (payload as { askId?: unknown } | null)?.askId;
  if (typeof askId !== "string") return;
  const row = readRow(ctx.db, askId);
  if (!row || row.state !== "pending") return;
  if (!isCloudOrigin(row.origin_device_id)) return;
  const rearm = (): void => {
    ctx.jobs.schedule(
      USER_ASKS_CLOUD_ESCALATE_JOB,
      ctx.now + USER_ASK_ESCALATION_STEP_MS,
      { askId },
      { id: cloudEscalateJobId(askId) },
    );
  };
  const policy = readPolicy(ctx.db);
  const ceiling = effectiveEscalationCeiling(
    policy,
    clampUrgency(row.urgency),
    quietHoursMinute(ctx, row.local_offset_minutes),
  );
  const current = clampUrgency(row.escalation_level);
  const stepped = nextEscalationLevel(current, ceiling);
  const level = stepped ?? current;
  const repeatOnly = stepped === null;
  if (repeatOnly && (level < BREAKTHROUGH_LEVEL || ceiling < BREAKTHROUGH_LEVEL)) {
    rearm();
    return;
  }
  if (level < PUSH_LEVEL_FLOOR) {
    rearm();
    return;
  }
  if (pushesInWindow(ctx) >= policy.maxPerHour) {
    rearm();
    return;
  }
  const outcome = await sendAskPush(ctx, row, level, policy);
  if (outcome === "no_push_target") {
    log("user_ask_cloud_escalation_unreachable", { askId, level });
    ctx.db.run(
      "UPDATE user_asks SET next_escalation_at = NULL, updated_at = ? WHERE ask_id = ?",
      ctx.now,
      askId,
    );
    return;
  }
  if (!repeatOnly) {
    ctx.db.run(
      `UPDATE user_asks SET escalation_level = ?, revision = revision + 1,
         next_escalation_at = ?, updated_at = ? WHERE ask_id = ?`,
      level,
      ctx.now + USER_ASK_ESCALATION_STEP_MS,
      ctx.now,
      askId,
    );
  } else {
    ctx.db.run(
      "UPDATE user_asks SET next_escalation_at = ?, updated_at = ? WHERE ask_id = ?",
      ctx.now + USER_ASK_ESCALATION_STEP_MS,
      ctx.now,
      askId,
    );
  }
  rearm();
};

const defaultAsk = (ctx: OwnerContext, payload: unknown): void => {
  const askId = (payload as { askId?: unknown } | null)?.askId;
  if (typeof askId !== "string") return;
  const row = readRow(ctx.db, askId);
  if (!row || row.state !== "pending") return;
  if (row.deadline_at !== null && row.deadline_at > ctx.now) return;
  const detail = parseDetail(row);
  if (!userAskHasDefaults(detail)) return;
  ctx.db.run(
    `UPDATE user_asks SET state = 'defaulted', revision = revision + 1,
       next_escalation_at = NULL, updated_at = ? WHERE ask_id = ?`,
    ctx.now,
    askId,
  );
  ctx.jobs.cancel(repeatJobId(askId));
};

const expireAsk = (ctx: OwnerContext, payload: unknown): void => {
  const askId = (payload as { askId?: unknown } | null)?.askId;
  if (typeof askId !== "string") return;
  const row = readRow(ctx.db, askId);
  if (!row || !userAskIsOpen(row.state as UserAskState)) return;
  if (row.expires_at > ctx.now) return;
  closeAsk(ctx, row, "expired");
};

const sweep = (ctx: OwnerContext): void => {
  for (const row of ctx.db.all<AskRow>(
    "SELECT * FROM user_asks WHERE state IN ('pending', 'defaulted') AND expires_at <= ?",
    ctx.now,
  )) {
    closeAsk(ctx, row, "expired");
  }
  for (const { ask_id } of ctx.db.all<{ ask_id: string }>(
    `SELECT ask_id FROM user_asks WHERE state NOT IN ('pending', 'defaulted') AND updated_at < ?`,
    ctx.now - RETENTION_MS,
  )) {
    ctx.db.run("DELETE FROM user_ask_answers WHERE ask_id = ?", ask_id);
    ctx.db.run("DELETE FROM user_ask_pushes WHERE ask_id = ?", ask_id);
    ctx.db.run("DELETE FROM user_asks WHERE ask_id = ?", ask_id);
  }
  ctx.db.run(
    "DELETE FROM user_ask_pushes WHERE sent_at < ?",
    ctx.now - PUSH_RETENTION_MS,
  );
  const remaining = ctx.db.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM user_asks",
  )?.n ?? 0;
  if (remaining > 0) scheduleSweep(ctx);
};

export type UserAskRouteInput = {
  route: string;
  askId: string;
  caller: OwnerCaller;
  body: Record<string, unknown>;
  query?: Record<string, string>;
  /** The `x-stella-device-id` request header, when the client sent one. */
  deviceIdHeader?: string;
};

export type UserAskRouteResult = { status: number; body: unknown };

const STATUS_BY_CODE: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

const route = async (
  ctx: OwnerContext,
  input: UserAskRouteInput,
): Promise<UserAskRouteResult> => {
  requireAccountCaller(input.caller);
  switch (input.route) {
    case "POST ask":
      return { status: 200, body: registerAsk(ctx, registerParser(input.body)) };
    case "GET asks": {
      const policy = readPolicy(ctx.db);
      return {
        status: 200,
        body: {
          schemaVersion: USER_ASK_SCHEMA_VERSION,
          now: ctx.now,
          open: openAsks(ctx.db).map(askView),
          resolved: resolvedAsks(ctx.db, ctx.now).map((row) =>
            resolvedView(ctx.db, row),
          ),
          policy,
          ...(readPolicyTimeZone(ctx.db) === null
            ? {}
            : { timeZone: readPolicyTimeZone(ctx.db) }),
        },
      };
    }
    case "POST answer":
      return {
        status: 200,
        body: answerAsk(ctx, input.askId, answerParser(input.body)),
      };
    case "GET answer":
      return {
        status: 200,
        body: readAnswerForOriginDevice(
          ctx,
          input.askId,
          (input.query?.deviceId ?? input.deviceIdHeader ?? "").trim().slice(0, 256),
        ),
      };
    case "POST cancel":
      return { status: 200, body: cancelAsk(ctx, input.askId) };
    case "POST escalate":
      return {
        status: 200,
        body: await escalateAsk(ctx, input.askId, escalateParser(input.body)),
      };
    case "GET policy": {
      const timeZone = readPolicyTimeZone(ctx.db);
      return {
        status: 200,
        body: {
          policy: readPolicy(ctx.db),
          ...(timeZone === null ? {} : { timeZone }),
        },
      };
    }
    case "PUT policy": {
      enforceOwnerRateLimit(
        ctx.db,
        ctx.now,
        "userAsks.policy",
        { count: 60, windowMs: 60_000 },
        "Too many settings changes. Please wait a moment.",
      );
      const args = policyParser(input.body);
      const stored = readPolicy(ctx.db);
      const { timeZone: requestedZone, ...fields } = args;
      const requested = requestedZone?.trim();
      if (requested && !isUsableTimeZone(requested)) {
        throw new RpcError("BAD_REQUEST", "That time zone is not a known IANA zone.");
      }
      const timeZone =
        requested === undefined ? readPolicyTimeZone(ctx.db) : requested || null;
      const policy = normalizeUserAskEscalationPolicy({
        ...stored,
        ...fields,
        quietHours: { ...stored.quietHours, ...(fields.quietHours ?? {}) },
        timeZone: timeZone ?? undefined,
      });
      return {
        status: 200,
        body: {
          policy: writePolicy(ctx, policy, timeZone),
          ...(timeZone === null ? {} : { timeZone }),
        },
      };
    }
    default:
      return { status: 404, body: { error: "Not found" } };
  }
};

export const handleUserAskRoute = async (
  ctx: OwnerContext,
  input: UserAskRouteInput,
): Promise<UserAskRouteResult> => {
  try {
    return await route(ctx, input);
  } catch (caught) {
    if (caught instanceof RpcError) {
      return {
        status: STATUS_BY_CODE[caught.code] ?? 500,
        body: {
          error: caught.message,
          code: caught.code,
          retryable: caught.retryable,
          ...(caught.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: caught.retryAfterMs }),
        },
      };
    }
    throw caught;
  }
};

export const userAsksDomain = {
  name: "userAsks",
  migrations: [
    USER_ASKS_MIGRATION,
    USER_ASKS_POLICY_TIME_ZONE_MIGRATION,
    USER_ASKS_ANSWER_REVISION_MIGRATION,
    USER_ASKS_QUESTION_RESPONSES_MIGRATION,
  ],
  calls: {
    "userAsks.policy": {
      scope: "owner",
      requireAccount: true,
      parse: empty(),
      handler: (ctx: OwnerContext) => readPolicy(ctx.db),
    },
  },
  views: {
    "userAsks.open": {
      requireAccount: true,
      parse: empty(),
      read: (ctx) => listOpenUserAsks(ctx.db),
    },
  },
  internal: {
    "userAsks.turnRegister": registerTurnAsk,
    "userAsks.turnAnswer": readTurnAskAnswer,
    "userAsks.turnCancel": cancelTurnAsk,
  },
  jobs: {
    [USER_ASKS_DEFAULT_JOB]: { run: defaultAsk, maxAttempts: 5 },
    [USER_ASKS_EXPIRE_JOB]: { run: expireAsk, maxAttempts: 5 },
    [USER_ASKS_REPEAT_JOB]: { run: repeatBreakthrough, maxAttempts: 3 },
    [USER_ASKS_CLOUD_ESCALATE_JOB]: { run: escalateCloudAsk, maxAttempts: 3 },
    [USER_ASKS_SWEEP_JOB]: { run: (ctx) => sweep(ctx), maxAttempts: 10 },
  },
  purge: (ctx: OwnerContext) => {
    for (const { ask_id } of ctx.db.all<{ ask_id: string }>(
      "SELECT ask_id FROM user_asks",
    )) {
      ctx.jobs.cancel(defaultJobId(ask_id));
      ctx.jobs.cancel(expireJobId(ask_id));
      ctx.jobs.cancel(repeatJobId(ask_id));
      ctx.jobs.cancel(cloudEscalateJobId(ask_id));
    }
    ctx.jobs.cancel(USER_ASKS_SWEEP_JOB);
    ctx.db.run("DELETE FROM user_ask_answers");
    ctx.db.run("DELETE FROM user_ask_pushes");
    ctx.db.run("DELETE FROM user_ask_policy");
    ctx.db.run("DELETE FROM user_asks");
    return { pending: false };
  },
} satisfies OwnerDomain;
