import {
  USER_ASK_MAX_FIELDS,
  USER_ASK_MAX_OPTIONS,
  USER_ASK_MIN_OPTIONS,
  USER_ASK_FIELD_TYPES,
  clampUrgency,
  clampUserAskTimeoutMs,
  normalizeUserAskOptions,
  normalizeUserAskQuestions,
  userAskReadableAnswers,
  type SecureValueTarget,
  type SecureValueUseReceipt,
  type UserAskField,
  type UserAskFieldType,
  type UserAskQuestion,
  type UserAskResolution,
  type UserAskUrgencyLevel,
} from "@stella/contracts/user-ask";
import type { ToolContext, ToolResult } from "./types.js";

export type AskUserRequest = {
  questions: readonly UserAskQuestion[];
  timeoutMs?: number;
  blocking: boolean;
  urgency: UserAskUrgencyLevel;
  conversationId?: string;
  agentId?: string;
  toolCallId?: string;
};

export type SecureInputRequest = {
  purpose: string;
  detail?: string;
  fields: readonly UserAskField[];
  urgency: UserAskUrgencyLevel;
  conversationId?: string;
  agentId?: string;
  toolCallId?: string;
};

export type SecureValueUseRequest = {
  handle: string;
  target: SecureValueTarget;
  conversationId?: string;
  agentId?: string;
};

export type UserToolsConfig = {
  askUser?: (request: AskUserRequest) => Promise<UserAskResolution>;
  requestSecureInput?: (
    request: SecureInputRequest,
  ) => Promise<UserAskResolution>;
  useSecureValue?: (
    request: SecureValueUseRequest,
  ) => Promise<SecureValueUseReceipt>;
};

const text = (value: unknown, max = 2000): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const contextFields = (
  context: ToolContext | undefined,
  args: Record<string, unknown>,
): { conversationId?: string; agentId?: string; toolCallId?: string } => {
  const conversationId = context?.conversationId;
  const agentId = context?.agentId;
  const toolCallId = text(args.__toolCallId, 128) || context?.requestId;
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  };
};

const resolutionToResult = (
  resolution: UserAskResolution,
  questions: readonly UserAskQuestion[] = [],
): ToolResult => {
  if (resolution.outcome === "answered") {
    return {
      result: {
        outcome: "answered",
        ...(resolution.responses
          ? { answers: userAskReadableAnswers(questions, resolution.responses) }
          : {}),
        ...(resolution.values ? { values: resolution.values } : {}),
        ...(resolution.handles ? { handles: resolution.handles } : {}),
        ...(resolution.late ? { late: true } : {}),
      },
    };
  }
  if (resolution.outcome === "defaulted") {
    return {
      result: {
        outcome: "defaulted",
        answers: userAskReadableAnswers(questions, resolution.responses),
        note: resolution.note,
        tellTheUser: resolution.note,
      },
    };
  }
  return {
    result: { outcome: resolution.outcome, note: resolution.note },
  };
};

const normalizeTimeout = (
  value: unknown,
  blocking: boolean,
): number | undefined => {
  if (blocking) return undefined;
  return clampUserAskTimeoutMs(value);
};

export const handleAskUser = async (
  config: UserToolsConfig,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  if (!config.askUser) {
    return { error: "Asking the user is not supported on this device." };
  }
  const questions = normalizeUserAskQuestions(args);
  if (questions.length === 0) return { error: "questions is required." };
  const thin = questions.find(
    (question) => question.options.length < USER_ASK_MIN_OPTIONS,
  );
  if (thin) {
    return {
      error: `Give "${thin.question}" between ${USER_ASK_MIN_OPTIONS} and ${USER_ASK_MAX_OPTIONS} concrete options. The user can always type their own answer or skip.`,
    };
  }

  const blocking = args.blocking === true;
  if (!blocking) {
    const missing = questions.find(
      (question) => question.defaultChoiceId === undefined,
    );
    if (missing) {
      return {
        error: `A timed ask needs default_choice on every question, set to one of its option ids, so the work can continue without an answer ("${missing.question}" has none). Use blocking only for hard-to-undo actions.`,
      };
    }
  }

  const timeoutMs = normalizeTimeout(args.timeout_ms ?? args.timeoutMs, blocking);

  try {
    const resolution = await config.askUser({
      questions,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      blocking,
      urgency: clampUrgency(args.urgency),
      ...contextFields(context, args),
    });
    return resolutionToResult(resolution, questions);
  } catch (error) {
    return { error: (error as Error).message || "The ask failed." };
  }
};

const normalizeFieldType = (value: unknown): UserAskFieldType => {
  const candidate = text(value, 32).toLowerCase();
  return (USER_ASK_FIELD_TYPES as readonly string[]).includes(candidate)
    ? (candidate as UserAskFieldType)
    : "text";
};

const normalizeFields = (input: unknown): readonly UserAskField[] => {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const fields: UserAskField[] = [];
  for (const row of rows) {
    if (fields.length >= USER_ASK_MAX_FIELDS) break;
    const source = (row ?? {}) as Record<string, unknown>;
    const label = text(source.label, 120);
    if (!label) continue;
    const baseId =
      text(source.id, 48)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") ||
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    let id = baseId || `field_${fields.length + 1}`;
    while (seen.has(id)) id = `${id}_${fields.length + 1}`;
    seen.add(id);
    const type = normalizeFieldType(source.type);
    const sensitive =
      typeof source.sensitive === "boolean" ? source.sensitive : type === "secret";
    const placeholder = text(source.placeholder, 120);
    const hint = text(source.hint, 240);
    const choices =
      type === "choice" ? normalizeUserAskOptions(source.choices) : [];
    fields.push({
      id,
      label,
      type,
      sensitive,
      ...(placeholder ? { placeholder } : {}),
      ...(hint ? { hint } : {}),
      ...(source.optional === true ? { optional: true } : {}),
      ...(choices.length > 0 ? { choices } : {}),
    });
  }
  return fields;
};

export const handleRequestSecureInput = async (
  config: UserToolsConfig,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  if (!config.requestSecureInput) {
    return { error: "Secure input is not supported on this device." };
  }
  const purpose = text(args.purpose, 300);
  if (!purpose) return { error: "purpose is required." };
  const fields = normalizeFields(args.fields);
  if (fields.length === 0) {
    return {
      error:
        "fields is required: describe each value you need with a label, a type (text, secret, code, choice), and whether it is sensitive.",
    };
  }
  const detail = text(args.detail, 1000);
  try {
    const resolution = await config.requestSecureInput({
      purpose,
      ...(detail ? { detail } : {}),
      fields,
      urgency: clampUrgency(args.urgency),
      ...contextFields(context, args),
    });
    return resolutionToResult(resolution);
  } catch (error) {
    return { error: (error as Error).message || "Secure input failed." };
  }
};

const normalizeTarget = (input: unknown): SecureValueTarget | null => {
  const source = (input ?? {}) as Record<string, unknown>;
  const kind = text(source.kind, 32);
  if (kind === "browser_field") {
    const selector = text(source.selector, 500);
    if (!selector) return null;
    const tabId = text(source.tabId, 128);
    return { kind, selector, ...(tabId ? { tabId } : {}) };
  }
  if (kind === "command") {
    const command = text(source.command, 4000);
    if (!command) return null;
    const placeholder = text(source.placeholder, 64);
    const cwd = text(source.cwd, 1000);
    return {
      kind,
      command,
      ...(placeholder ? { placeholder } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (kind === "keychain") {
    const service = text(source.service, 200);
    const account = text(source.account, 200);
    if (!service || !account) return null;
    return { kind, service, account };
  }
  return null;
};

export const handleUseSecureValue = async (
  config: UserToolsConfig,
  args: Record<string, unknown>,
  context?: ToolContext,
): Promise<ToolResult> => {
  if (!config.useSecureValue) {
    return { error: "Stored secure values are not usable on this device." };
  }
  const handle = text(args.handle, 256);
  if (!handle) return { error: "handle is required." };
  const target = normalizeTarget(args.into ?? args.target);
  if (!target) {
    return {
      error:
        'into is required: {"kind":"browser_field","selector":"#password"}, {"kind":"command","command":"…{{secret}}…"}, or {"kind":"keychain","service":"…","account":"…"}.',
    };
  }
  try {
    const receipt = await config.useSecureValue({
      handle,
      target,
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
    });
    return { result: receipt };
  } catch (error) {
    return {
      error: (error as Error).message || "The secure value could not be used.",
    };
  }
};
