/**
 * iMessage-style time labels for the transcript: a centered time between
 * messages, shown only when a long enough gap precedes one, instead of a stamp
 * under every message.
 *
 * This is the SAME rule mobile applies (`packages/mobile/src/lib/
 * message-time-labels.ts` — same gap threshold, same label shapes), so the two
 * clients break a conversation into the same time groups. Desktop builds the
 * label through `Intl` with the active UI locale rather than hardcoding
 * English, which is the only intentional difference.
 */

/** A new centered time appears after this much quiet. */
export const TIMESTAMP_GAP_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

const startOfDay = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const timeOfDay = (ms: number, locale?: string): string =>
  new Date(ms).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });

/** Calendar days between `ms` and `now` (0 = today, 1 = yesterday). */
const daysAgo = (ms: number, now: number): number =>
  Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);

const capitalize = (value: string): string =>
  value.length > 0 ? value[0]!.toLocaleUpperCase() + value.slice(1) : value;

/**
 * `Intl`'s own "today" / "yesterday" wording for the active locale, so the
 * divider doesn't need a translation key per language.
 */
const relativeDayLabel = (days: number, locale?: string): string =>
  capitalize(
    new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      -days,
      "day",
    ),
  );

/**
 * "Today 5:48 PM", "Yesterday 5:48 PM", "Monday 5:48 PM" within the week,
 * "Sep 23, 11:07 PM" this year, then "Sep 23, 2025, 11:07 PM".
 */
export function formatTimestampHeader(
  ms: number,
  locale?: string,
  now = Date.now(),
): string {
  const days = daysAgo(ms, now);
  const time = timeOfDay(ms, locale);
  if (days <= 0) return `${relativeDayLabel(0, locale)} ${time}`;
  if (days === 1) return `${relativeDayLabel(1, locale)} ${time}`;
  const date = new Date(ms);
  if (days < 7) {
    return `${capitalize(date.toLocaleDateString(locale, { weekday: "long" }))} ${time}`;
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The messages that get a centered time above them, with that time. Entries
 * must be in display order; ones without a usable created time are skipped
 * (they can't open or close a time group).
 */
export function timestampHeaders(
  entries: readonly { id: string; timestampMs?: number }[],
): Map<string, number> {
  const headers = new Map<string, number>();
  let previous: number | null = null;
  for (const entry of entries) {
    const at = entry.timestampMs;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (previous === null || at - previous >= TIMESTAMP_GAP_MS) {
      headers.set(entry.id, at);
    }
    previous = at;
  }
  return headers;
}
