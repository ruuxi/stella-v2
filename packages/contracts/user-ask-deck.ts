import type {
  UserAsk,
  UserAskAnswer,
  UserAskQuestion,
  UserAskQuestionResponse,
} from "./user-ask.js";
import { USER_ASK_MAX_RESPONSE_TEXT } from "./user-ask.js";

export type UserAskDeckEntry = Readonly<{
  key: string;
  ask: UserAsk;
  question: UserAskQuestion;
}>;

export type UserAskDraft = Readonly<{
  choiceId?: string;
  skipped?: boolean;
  text: string;
}>;

export type UserAskDrafts = Readonly<Record<string, UserAskDraft>>;

export const EMPTY_USER_ASK_DRAFT: UserAskDraft = { text: "" };

export const userAskDeckKey = (askId: string, questionId: string): string =>
  `${askId}\u0000${questionId}`;

export const userAskDeckEntries = (
  asks: readonly UserAsk[],
): readonly UserAskDeckEntry[] =>
  asks.flatMap((ask) =>
    ask.detail.kind === "question"
      ? ask.detail.questions.map((question) => ({
          key: userAskDeckKey(ask.askId, question.id),
          ask,
          question,
        }))
      : [],
  );

export const userAskDraftResponse = (
  questionId: string,
  draft: UserAskDraft | undefined,
): UserAskQuestionResponse | null => {
  if (!draft) return null;
  if (draft.choiceId) {
    return { questionId, kind: "option", choiceId: draft.choiceId };
  }
  if (draft.skipped) return { questionId, kind: "skipped" };
  const text = draft.text.trim().slice(0, USER_ASK_MAX_RESPONSE_TEXT);
  return text ? { questionId, kind: "text", text } : null;
};

export const userAskEntryAnswered = (
  entry: UserAskDeckEntry,
  drafts: UserAskDrafts,
): boolean => userAskDraftResponse(entry.question.id, drafts[entry.key]) !== null;

export const userAskDeckComplete = (
  entries: readonly UserAskDeckEntry[],
  drafts: UserAskDrafts,
): boolean =>
  entries.length > 0 && entries.every((entry) => userAskEntryAnswered(entry, drafts));

export const nextUnansweredIndex = (
  entries: readonly UserAskDeckEntry[],
  drafts: UserAskDrafts,
  from: number,
): number | null => {
  for (let step = 1; step <= entries.length; step += 1) {
    const index = (from + step) % entries.length;
    if (!userAskEntryAnswered(entries[index]!, drafts)) return index;
  }
  return null;
};

export const pickUserAskOption = (draft: UserAskDraft, choiceId: string): UserAskDraft => ({
  text: draft.text,
  choiceId,
});

export const typeUserAskText = (text: string): UserAskDraft => ({ text });

export const skipUserAskQuestion = (draft: UserAskDraft): UserAskDraft => ({
  text: draft.text,
  skipped: true,
});

export const userAskDeckAnswers = (
  entries: readonly UserAskDeckEntry[],
  drafts: UserAskDrafts,
): readonly UserAskAnswer[] => {
  const byAsk = new Map<string, { ask: UserAsk; responses: UserAskQuestionResponse[] }>();
  for (const entry of entries) {
    const group = byAsk.get(entry.ask.askId) ?? { ask: entry.ask, responses: [] };
    group.responses.push(
      userAskDraftResponse(entry.question.id, drafts[entry.key]) ?? {
        questionId: entry.question.id,
        kind: "skipped",
      },
    );
    byAsk.set(entry.ask.askId, group);
  }
  return [...byAsk.values()].map(({ ask, responses }) => ({
    askId: ask.askId,
    revision: ask.revision,
    kind: "questions",
    responses,
  }));
};

export type UserAskRecordAnswer = Readonly<{
  question: string;
  answer: string;
  kind: "option" | "text" | "skipped";
}>;

export type UserAskRecord = Readonly<{
  id: string;
  toolCallId?: string;
  createdAt: number;
  defaulted: boolean;
  answers: readonly UserAskRecordAnswer[];
}>;

const recordAnswerOf = (input: unknown): UserAskRecordAnswer | null => {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const question = typeof source.question === "string" ? source.question.trim() : "";
  if (!question) return null;
  if (source.skipped === true) return { question, answer: "", kind: "skipped" };
  if (typeof source.text === "string" && source.text.trim()) {
    return { question, answer: source.text.trim(), kind: "text" };
  }
  const label =
    typeof source.label === "string" && source.label.trim()
      ? source.label.trim()
      : typeof source.choice === "string"
        ? source.choice
        : "";
  return label ? { question, answer: label, kind: "option" } : null;
};

export const parseAskUserToolResult = (
  input: unknown,
): { defaulted: boolean; answers: readonly UserAskRecordAnswer[] } | null => {
  let value: unknown = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    try {
      value = JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const nested =
    source.result && typeof source.result === "object" ? source.result : null;
  if (nested && !Array.isArray(source.answers)) return parseAskUserToolResult(nested);
  if (source.outcome !== "answered" && source.outcome !== "defaulted") return null;
  const answers = (Array.isArray(source.answers) ? source.answers : [])
    .map(recordAnswerOf)
    .filter((answer): answer is UserAskRecordAnswer => answer !== null);
  if (answers.length === 0) return null;
  return { defaulted: source.outcome === "defaulted", answers };
};

export const userAskRecordFromAnswer = (
  entries: readonly UserAskDeckEntry[],
  drafts: UserAskDrafts,
  ask: UserAsk,
): UserAskRecord => ({
  id: ask.askId,
  ...(ask.toolCallId ? { toolCallId: ask.toolCallId } : {}),
  createdAt: ask.createdAt,
  defaulted: false,
  answers: entries
    .filter((entry) => entry.ask.askId === ask.askId)
    .map((entry) => {
      const response = userAskDraftResponse(entry.question.id, drafts[entry.key]);
      if (!response || response.kind === "skipped") {
        return { question: entry.question.question, answer: "", kind: "skipped" as const };
      }
      if (response.kind === "text") {
        return { question: entry.question.question, answer: response.text, kind: "text" as const };
      }
      return {
        question: entry.question.question,
        answer:
          entry.question.options.find((option) => option.id === response.choiceId)?.label ??
          response.choiceId,
        kind: "option" as const,
      };
    }),
});
