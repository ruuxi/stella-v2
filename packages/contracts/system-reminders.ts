export const SYSTEM_REMINDER_TAG = "system-reminder";

export const wrapSystemReminder = (text: string): string =>
  `<${SYSTEM_REMINDER_TAG}>${text.trim()}</${SYSTEM_REMINDER_TAG}>`;

export const formatTimestampSystemReminder = (text: string): string =>
  `<${SYSTEM_REMINDER_TAG}>${text}</${SYSTEM_REMINDER_TAG}>`;

export const formatAgentTerminalStateSystemReminder = (
  lines: string[],
): string =>
  [
    `<${SYSTEM_REMINDER_TAG}>`,
    "The agent has finished. The user cannot see this report — respond to them yourself, and delegate follow-up work if the task is unfinished.",
    `</${SYSTEM_REMINDER_TAG}>`,
    "",
    ...lines,
  ].join("\n");
