import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  USER_ASK_DEFAULT_TIMEOUT_MS,
  USER_ASK_MAX_TIMEOUT_MS,
  USER_ASK_MIN_TIMEOUT_MS,
  clampUrgency,
  userAskDefaultedNote,
  withSomethingElseOption,
  type UserAskAnswer,
  type UserAskOption,
  type UserAskResolution,
  type UserAskState,
} from "@stella/contracts/user-ask";
import type {
  AskUserRequest,
  SecureInputRequest,
  UserToolsConfig,
} from "@stella/runtime/kernel/tools/user.js";

export const CLOUD_USER_ASK_PATH = "/api/cloud/user-ask";

const SOMETHING_ELSE_LABEL = "Something else";
const ANSWER_POLL_MS = 10_000;
const FIRST_POLL_MS = 1_500;

export type CloudUserAskHost = {
  handlers: Required<Pick<UserToolsConfig, "askUser" | "requestSecureInput">> &
    Pick<UserToolsConfig, "useSecureValue">;
  cancelOpenAsks: (note: string) => Promise<void>;
};

type AnswerRead = {
  askId: string;
  state: UserAskState;
  revision: number;
  answer?: UserAskAnswer;
  late?: boolean;
  answeredAt?: number;
};

const sleep = (milliseconds: number): Promise<void> =>
  Effect.runPromise(Effect.sleep(milliseconds));

const normalizeTimeout = (value: number | undefined): number =>
  Math.min(
    USER_ASK_MAX_TIMEOUT_MS,
    Math.max(
      USER_ASK_MIN_TIMEOUT_MS,
      Number.isFinite(value) && (value ?? 0) > 0
        ? Math.round(value!)
        : USER_ASK_DEFAULT_TIMEOUT_MS,
    ),
  );

const choiceLabelOf = (
  options: readonly UserAskOption[],
  choiceId: string,
): string => options.find((option) => option.id === choiceId)?.label ?? choiceId;

const answeredResolution = (
  askId: string,
  read: AnswerRead,
): UserAskResolution | null => {
  const answer = read.answer;
  if (!answer) return null;
  const answeredAt = read.answeredAt ?? Date.now();
  if (answer.kind === "choice") {
    return {
      outcome: "answered",
      askId,
      choiceId: answer.choiceId,
      ...(answer.text ? { text: answer.text } : {}),
      answeredAt,
      ...(read.late ? { late: true } : {}),
    };
  }
  const values: Record<string, string> = {};
  for (const field of answer.fields) {
    if (field.kind === "plain") values[field.fieldId] = field.value;
  }
  return {
    outcome: "answered",
    askId,
    ...(Object.keys(values).length > 0 ? { values } : {}),
    answeredAt,
    ...(read.late ? { late: true } : {}),
  };
};

export const createCloudUserAskHost = (args: {
  post: (route: string, body: unknown) => Promise<Response>;
  turnId: string;
  conversationId: string;
}): CloudUserAskHost => {
  const openAsks = new Set<string>();
  let shutdownNote: string | null = null;

  const request = async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await args.post(CLOUD_USER_ASK_PATH, {
      turnId: args.turnId,
      ...body,
    });
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        detail?.error ?? `The ask could not be registered (${response.status}).`,
      );
    }
    return (await response.json()) as unknown;
  };

  const cancel = async (askId: string): Promise<void> => {
    openAsks.delete(askId);
    await request({ op: "cancel", askId }).catch(() => undefined);
  };

  const readAnswer = async (askId: string): Promise<AnswerRead> =>
    (await request({ op: "answer", askId })) as AnswerRead;

  const register = async (body: Record<string, unknown>): Promise<string> => {
    const askId = randomUUID();
    await request({
      op: "register",
      askId,
      conversationId: args.conversationId,
      ...body,
    });
    openAsks.add(askId);
    return askId;
  };

  const waitForAnswer = async (input: {
    askId: string;
    deadlineAt: number | null;
    onDefault: () => UserAskResolution;
  }): Promise<UserAskResolution> => {
    let delay = FIRST_POLL_MS;
    while (true) {
      if (shutdownNote) {
        return {
          outcome: "canceled",
          askId: input.askId,
          at: Date.now(),
          note: shutdownNote,
        };
      }
      const now = Date.now();
      if (input.deadlineAt !== null && now >= input.deadlineAt) {
        return input.onDefault();
      }
      const remaining =
        input.deadlineAt === null ? delay : Math.min(delay, input.deadlineAt - now);
      await sleep(Math.max(250, remaining));
      let read: AnswerRead;
      try {
        read = await readAnswer(input.askId);
      } catch (error) {
        openAsks.delete(input.askId);
        return {
          outcome: "canceled",
          askId: input.askId,
          at: Date.now(),
          note: `That question could not be kept open: ${(error as Error).message}`,
        };
      }
      delay = ANSWER_POLL_MS;
      const resolution = answeredResolution(input.askId, read);
      if (resolution) {
        openAsks.delete(input.askId);
        return resolution;
      }
      if (read.state === "canceled" || read.state === "expired") {
        openAsks.delete(input.askId);
        return {
          outcome: read.state,
          askId: input.askId,
          at: Date.now(),
          note:
            read.state === "canceled"
              ? "The user dismissed that question without answering."
              : "That question went unanswered long enough that it expired.",
        };
      }
    }
  };

  const askUser = async (
    askRequest: AskUserRequest,
  ): Promise<UserAskResolution> => {
    const options = withSomethingElseOption(
      askRequest.options ?? [],
      SOMETHING_ELSE_LABEL,
    );
    const blocking = askRequest.blocking === true;
    const timeoutMs = blocking ? null : normalizeTimeout(askRequest.timeoutMs);
    const defaultChoiceId = blocking
      ? undefined
      : options.some((option) => option.id === askRequest.defaultChoiceId)
        ? askRequest.defaultChoiceId
        : options[0]?.id;
    const askId = await register({
      kind: "question",
      toolCallId: askRequest.toolCallId ?? randomUUID(),
      urgency: clampUrgency(askRequest.urgency),
      blocking,
      ...(timeoutMs === null ? {} : { timeoutMs }),
      detail: {
        kind: "question",
        question: askRequest.question,
        ...(askRequest.detail ? { detail: askRequest.detail } : {}),
        options,
        ...(defaultChoiceId ? { defaultChoiceId } : {}),
      },
    });
    return await waitForAnswer({
      askId,
      deadlineAt: timeoutMs === null ? null : Date.now() + timeoutMs,
      onDefault: () => {
        const choiceId = defaultChoiceId ?? options[0]?.id ?? "";
        const choiceLabel = choiceLabelOf(options, choiceId);
        return {
          outcome: "defaulted",
          askId,
          choiceId,
          choiceLabel,
          defaultedAt: Date.now(),
          note: userAskDefaultedNote(choiceLabel),
        };
      },
    });
  };

  const requestSecureInput = async (
    secureRequest: SecureInputRequest,
  ): Promise<UserAskResolution> => {
    const fields = secureRequest.fields ?? [];
    if (fields.length === 0) {
      throw new Error("Describe at least one field to collect.");
    }
    const refused = fields.filter(
      (field) => field.sensitive || field.type === "secret",
    );
    if (refused.length > 0) {
      throw new Error(
        `A value this agent must never see (${refused
          .map((field) => field.label)
          .join(", ")}) can only be collected on one of the user's own computers: it is sealed to a key the asking computer holds, and this agent runs in Stella's cloud with nowhere safe to keep one. Ask for it from a desktop agent, or ask here only for values you may read, such as an address or a preference.`,
      );
    }
    const askId = await register({
      kind: "secure_input",
      toolCallId: secureRequest.toolCallId ?? randomUUID(),
      urgency: clampUrgency(secureRequest.urgency),
      blocking: true,
      detail: {
        kind: "secure_input",
        purpose: secureRequest.purpose,
        ...(secureRequest.detail ? { detail: secureRequest.detail } : {}),
        fields,
      },
    });
    return await waitForAnswer({
      askId,
      deadlineAt: null,
      onDefault: () => ({
        outcome: "canceled",
        askId,
        at: Date.now(),
        note: "That request for values was closed before it was answered.",
      }),
    });
  };

  const useSecureValue = async (): Promise<never> => {
    throw new Error(
      "A secure value handle lives only on the computer that collected it, and this agent runs in Stella's cloud, which keeps no secret store. Have an agent on that computer spend the handle.",
    );
  };

  return {
    handlers: { askUser, requestSecureInput, useSecureValue },
    cancelOpenAsks: async (note: string) => {
      shutdownNote = note;
      const pending = [...openAsks];
      openAsks.clear();
      await Promise.all(pending.map(async (askId) => await cancel(askId)));
    },
  };
};
