/** Shared timestamp utilities for message tagging. */
import {
  formatTimestampSystemReminder,
  wrapSystemReminder,
} from "@stella/contracts/system-reminders";

export { wrapSystemReminder };

const TIME_PATTERN =
  "(?:1[0-2]|0?[1-9]):[0-5]\\d\\s?(?:AM|PM)(?:,\\s+[A-Za-z]{3}\\s+\\d{1,2})?";

/** Matches a leading `<system-reminder>time</system-reminder>` tag. */
export const LEADING_TIME_TAG_RE = new RegExp(
  `^<system-reminder>${TIME_PATTERN}<\\/system-reminder>\\s*`,
  "i",
);

/** Matches a trailing `\n\n<system-reminder>time</system-reminder>` tag. */
export const TRAILING_TIME_TAG_RE = new RegExp(
  `\\s*\\n\\n<system-reminder>${TIME_PATTERN}<\\/system-reminder>$`,
  "i",
);

export const TEN_MINUTES_MS = 10 * 60 * 1000;
export const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export const formatDateTimeReminder = (
  timestamp: number,
  timezone?: string,
): string => {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const value = new Date(timestamp).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  return `Current date and time: ${value}.`;
};

// `Date#toLocale{Time,Date}String(locale, options)` builds a fresh
// `Intl.DateTimeFormat` on every call (~16us each in JSC). History building
// formats every legacy event, so reuse one formatter per timezone. The
// options below request explicit fields, so `format()` produces exactly
// what the `toLocale*String` calls did (no ECMA-402 defaults are added).
type TimestampTagFormatters = { time: Intl.DateTimeFormat; date: Intl.DateTimeFormat };
const MAX_CACHED_TIMEZONES = 32;
const timestampTagFormatters = new Map<string, TimestampTagFormatters>();

const getTimestampTagFormatters = (tz: string): TimestampTagFormatters => {
  const cached = timestampTagFormatters.get(tz);
  if (cached) return cached;
  const formatters: TimestampTagFormatters = {
    time: new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: tz,
    }),
    date: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: tz,
    }),
  };
  if (timestampTagFormatters.size >= MAX_CACHED_TIMEZONES) {
    timestampTagFormatters.clear();
  }
  timestampTagFormatters.set(tz, formatters);
  return formatters;
};

const formatTimeAndDate = (
  timestamp: number,
  timezone?: string,
): { timeStr: string; dateStr: string } => {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const formatters = getTimestampTagFormatters(tz);
  const d = new Date(timestamp);
  // `format()` throws on an invalid date where `toLocale*String` returned
  // "Invalid Date"; keep the old output.
  if (Number.isNaN(d.getTime())) {
    return { timeStr: "Invalid Date", dateStr: "Invalid Date" };
  }
  return { timeStr: formatters.time.format(d), dateStr: formatters.date.format(d) };
};

/**
 * Format a timestamp tag for appending to a user message.
 * Always includes the date portion.
 */
export const formatTimestampTag = (timestamp: number, timezone?: string): string => {
  const { timeStr, dateStr } = formatTimeAndDate(timestamp, timezone);
  return formatTimestampSystemReminder(`${timeStr}, ${dateStr}`);
};

/**
 * Format a timestamp for history building. Omits the date when it matches prevDate.
 */
export const formatTimestampForHistory = (
  timestamp: number,
  prevDate?: string,
  timezone?: string,
): { tag: string; dateStr: string } => {
  const { timeStr, dateStr } = formatTimeAndDate(timestamp, timezone);
  const tag =
    prevDate && dateStr === prevDate
      ? formatTimestampSystemReminder(timeStr)
      : formatTimestampSystemReminder(`${timeStr}, ${dateStr}`);
  return { tag, dateStr };
};
