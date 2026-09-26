import type { ChatMessage } from "../types";

const hasOwn = Object.prototype.hasOwnProperty;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Returns `next`, reusing every part of `previous` that is structurally equal
 * to it: `previous` itself when the two are deep-equal, otherwise a copy of
 * `next` whose equal branches are the previous objects. Only plain objects and
 * arrays are walked; anything else is compared by identity.
 */
export const replaceEqualDeep = <T>(previous: unknown, next: T): T => {
  if (previous === next) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let equal = previous.length === next.length;
    const shared = next.map((item: unknown, index) => {
      const kept = replaceEqualDeep(previous[index], item);
      if (kept !== previous[index]) equal = false;
      return kept;
    });
    return (equal ? previous : shared) as T;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    const keys = Object.keys(next);
    let equal = keys.length === Object.keys(previous).length;
    const shared: Record<string, unknown> = {};
    for (const key of keys) {
      const kept = replaceEqualDeep(previous[key], next[key]);
      shared[key] = kept;
      if (kept !== previous[key] || !hasOwn.call(previous, key)) equal = false;
    }
    return (equal ? previous : shared) as T;
  }
  return next;
};

/**
 * Keeps transcript rows referentially stable across re-projections.
 *
 * The journal projection rebuilds every row from the raw records whenever one
 * record lands, so without this each committed record handed the list a new
 * object for every message: every mounted row re-rendered, and every memo
 * keyed on a row's artifacts or steps recomputed. Rows are matched by id (an
 * insertion shifts indexes); an unchanged row is the previous object, a
 * changed row still shares its unchanged branches, and an unchanged transcript
 * is the previous array itself so downstream memos skip entirely.
 */
export const reuseEqualChatMessages = (
  previous: readonly ChatMessage[] | null,
  next: ChatMessage[],
): ChatMessage[] => {
  if (!previous || previous === next || previous.length === 0) return next;
  const previousById = new Map<string, ChatMessage>();
  for (const message of previous) previousById.set(message.id, message);
  let same = previous.length === next.length;
  const shared = next.map((message, index) => {
    const prior = previousById.get(message.id);
    const kept = prior ? replaceEqualDeep(prior, message) : message;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? (previous as ChatMessage[]) : shared;
};
