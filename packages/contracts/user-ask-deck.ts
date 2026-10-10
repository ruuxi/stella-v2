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
