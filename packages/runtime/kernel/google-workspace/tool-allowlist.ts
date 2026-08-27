export const GOOGLE_WORKSPACE_TOOL_ALLOWLIST = [

  "auth.clear",
  "auth.refreshToken",

  "docs.create",
  "docs.getSuggestions",
  "docs.getComments",
  "docs.writeText",
  "docs.getText",
  "docs.replaceText",
  "docs.formatText",

  "drive.search",
  "drive.findFolder",
  "drive.createFolder",
  "drive.downloadFile",
  "drive.renameFile",

  "calendar.list",
  "calendar.createEvent",
  "calendar.listEvents",
  "calendar.getEvent",
  "calendar.findFreeTime",
  "calendar.updateEvent",
  "calendar.respondToEvent",

  "gmail.search",
  "gmail.get",
  "gmail.downloadAttachment",
  "gmail.modify",
  "gmail.send",
  "gmail.createDraft",
  "gmail.sendDraft",
  "gmail.listLabels",
  "gmail.createLabel",

  "time.getCurrentDate",
  "time.getCurrentTime",
  "time.getTimeZone",

  "people.getMe",
] as const;

export type GoogleWorkspaceToolName =
  (typeof GOOGLE_WORKSPACE_TOOL_ALLOWLIST)[number];

export const canonicalizeGoogleWorkspaceToolName = (name: string): string =>
  name.replace(/_/g, ".");

export const toGoogleWorkspaceToolRegistrationName = (
  name: string,
): string => canonicalizeGoogleWorkspaceToolName(name).replace(/\./g, "_");

export const getGoogleWorkspaceToolAliases = (name: string): string[] => {
  const canonicalName = canonicalizeGoogleWorkspaceToolName(name);
  return Array.from(
    new Set([
      canonicalName,
      toGoogleWorkspaceToolRegistrationName(canonicalName),
    ]),
  );
};

const ALLOWLIST_SET = new Set<string>(
  GOOGLE_WORKSPACE_TOOL_ALLOWLIST.map(canonicalizeGoogleWorkspaceToolName),
);

export const isAllowedGoogleWorkspaceTool = (name: string): boolean =>
  ALLOWLIST_SET.has(canonicalizeGoogleWorkspaceToolName(name));
