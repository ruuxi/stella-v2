import type { ChatMessage } from "../types";

/**
 * iMessage-style time labels for the transcript: a centered time above a
 * message only when a long enough gap precedes it, and a "Read" receipt under
 * the latest user message sent while busy, once the model has it.
 */

/** A new centered time appears after this much quiet. */
export const TIMESTAMP_GAP_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

const startOfDay = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const timeOfDay = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

/** Calendar days between `ms` and `now` (0 = today, 1 = yesterday). */
const daysAgo = (ms: number, now: number): number =>
  Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);

/**
 * "Today 5:48 PM", "Yesterday 5:48 PM", "Monday 5:48 PM" within the week,
 * "Sep 23 at 11:07 PM" this year, then "Sep 23, 2025 at 11:07 PM".
 */
export function formatTimestampHeader(ms: number, now = Date.now()): string {
  const days = daysAgo(ms, now);
  const time = timeOfDay(ms);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const date = new Date(ms);
  if (days < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${day} at ${time}`;
}

/** Ids of the messages that get a centered time above them, with that time. */
export function timestampHeaders(
  messages: readonly ChatMessage[],
): Map<string, number> {
  const headers = new Map<string, number>();
  let previous: number | null = null;
  for (const message of messages) {
    const at = message.createdAt;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (previous === null || at - previous >= TIMESTAMP_GAP_MS) {
      headers.set(message.id, at);
    }
    previous = at;
  }
  return headers;
}

/**
 * The model has a user message once the conversation journal records it: the
 * backend appends the prompt row right before the turn's model loop, on cloud
 * and desktop alike, and a message queued behind a running turn only gets its
 * row when its own turn starts. Optimistic rows carry no journal identity.
 */
const readAt = (message: ChatMessage): number | null => {
  if (!message.sentWhileBusy) return null;
  if (message.queued) return null;
  if (message.sequence === undefined && !message.canonicalId) return null;
  return message.canonicalCreatedAt ?? message.createdAt ?? null;
};

const showsContent = (message: ChatMessage): boolean =>
  message.text.trim().length > 0 || (message.artifacts?.length ?? 0) > 0;

/**
 * The receipt under the latest user message, while nothing has answered it
 * yet: "Read 5:48 PM" today, "Read Yesterday", or "Read Sep 23".
 */
export function readReceipt(
  messages: readonly ChatMessage[],
  now = Date.now(),
): { id: string; label: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      // The reply row exists, empty, from the moment the turn dispatches.
      if (showsContent(message)) return null;
      continue;
    }
    const at = readAt(message);
    if (at === null) return null;
    const days = daysAgo(at, now);
    const when =
      days <= 0
        ? timeOfDay(at)
        : days === 1
          ? "Yesterday"
          : new Date(at).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            });
    return { id: message.id, label: `Read ${when}` };
  }
  return null;
}
