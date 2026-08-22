/**
 * Curated Microsoft Graph tool names in canonical dot form, grouped by the
 * three in-scope services. Registration names use underscores (dots are not
 * valid in registered tool names), mirroring the Google Workspace convention.
 */
export const MICROSOFT_GRAPH_TOOL_ALLOWLIST = [
  // Outlook mail
  "outlook.listMessages",
  "outlook.getMessage",
  "outlook.sendMail",
  "outlook.createDraft",
  // Outlook calendar
  "outlook.listEvents",
  "outlook.createEvent",
  // Microsoft Teams
  "teams.listJoinedTeams",
  "teams.listChannels",
  "teams.listChannelMessages",
  "teams.sendChannelMessage",
  // Excel workbook
  "excel.listWorksheets",
  "excel.getRange",
  "excel.updateRange",
  "excel.listTables",
  "excel.addTableRows",
] as const;

export type MicrosoftGraphToolName =
  (typeof MICROSOFT_GRAPH_TOOL_ALLOWLIST)[number];

/** Maps a connector id to its dot-form tool prefix. */
export const MICROSOFT_GRAPH_TOOL_PREFIXES = {
  outlook: "outlook.",
  microsoft_teams: "teams.",
  excel: "excel.",
} as const;

export const canonicalizeMicrosoftGraphToolName = (name: string): string =>
  name.replace(/_/g, ".");

export const toMicrosoftGraphToolRegistrationName = (name: string): string =>
  canonicalizeMicrosoftGraphToolName(name).replace(/\./g, "_");

const ALLOWLIST_SET = new Set<string>(
  MICROSOFT_GRAPH_TOOL_ALLOWLIST.map(canonicalizeMicrosoftGraphToolName),
);

export const isAllowedMicrosoftGraphTool = (name: string): boolean =>
  ALLOWLIST_SET.has(canonicalizeMicrosoftGraphToolName(name));
