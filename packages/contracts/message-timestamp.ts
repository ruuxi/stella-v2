import {
  formatTimestampSystemReminder,
  wrapSystemReminder,
} from "@stella/contracts/system-reminders";

export { wrapSystemReminder };

const TIME_PATTERN =
  "(?:1[0-2]|0?[1-9]):[0-5]\\d\\s?(?:AM|PM)(?:,\\s+[A-Za-z]{3}\\s+\\d{1,2})?";

export const LEADING_TIME_TAG_RE = new RegExp(
  `^<system-reminder>${TIME_PATTERN}<\\/system-reminder>\\s*`,
  "i",
);

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

export const formatTimestampTag = (timestamp: number, timezone?: string): string => {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const d = new Date(timestamp);
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  return formatTimestampSystemReminder(`${timeStr}, ${dateStr}`);
};

export const formatTimestampForHistory = (
  timestamp: number,
  prevDate?: string,
  timezone?: string,
): { tag: string; dateStr: string } => {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const d = new Date(timestamp);
  const timeStr = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const dateStr = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: tz,
  });
  const tag =
    prevDate && dateStr === prevDate
      ? formatTimestampSystemReminder(timeStr)
      : formatTimestampSystemReminder(`${timeStr}, ${dateStr}`);
  return { tag, dateStr };
};
