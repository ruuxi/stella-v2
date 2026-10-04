/**
 * Hand-off from onboarding into the real chat.
 *
 * Onboarding finishes before the chat has resolved its conversation, so the
 * first message (a starter the user tapped, or whatever they typed into the
 * onboarding composer) is parked here and taken once by the chat screen,
 * which sends it as soon as the conversation can accept a turn. Held in
 * memory: onboarding replaces itself with the chat in the same process.
 */
export type PendingComposerDraft = {
  text: string;
  /** Send as soon as the chat can, instead of leaving it as a draft. */
  send: boolean;
};

let pending: PendingComposerDraft | null = null;

export function setPendingComposerDraft(draft: PendingComposerDraft): void {
  const text = draft.text.trim();
  pending = text ? { text, send: draft.send } : null;
}

/** The parked draft, left in place (safe to read during render). */
export function peekPendingComposerDraft(): PendingComposerDraft | null {
  return pending;
}

/** Drops the parked draft once the chat has taken it. */
export function clearPendingComposerDraft(): void {
  pending = null;
}
