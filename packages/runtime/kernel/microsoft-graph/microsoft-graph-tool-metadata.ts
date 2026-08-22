/**
 * Tool descriptions and JSON Schema parameters for the first-party Microsoft
 * Graph services (Outlook, Teams, Excel). Keyed by canonical dot-form name.
 */

export type MicrosoftGraphToolMeta = {
  description: string;
  parameters: Record<string, unknown>;
};

const str = (description: string) => ({ type: "string", description });
const rows2d = (description: string) => ({
  type: "array",
  description,
  items: { type: "array", items: {} },
});
const recipients = (description: string) => ({
  description,
  anyOf: [
    { type: "string" },
    { type: "array", items: { type: "string" } },
    { type: "array", items: { type: "object" } },
    { type: "object" },
  ],
});

const workbookLocator = {
  itemId: str("Drive item id of the workbook (.xlsx). Provide itemId or itemPath."),
  itemPath: str(
    "Path to the workbook relative to the drive root, e.g. 'Reports/Q3.xlsx'.",
  ),
};

export const MICROSOFT_GRAPH_TOOL_METADATA: Record<
  string,
  MicrosoftGraphToolMeta
> = {
  "outlook.listMessages": {
    description:
      "List recent Outlook mail. Optionally full-text search or scope to a mail folder.",
    parameters: {
      type: "object",
      properties: {
        top: { type: "number", description: "Max messages to return (<=100)." },
        search: str("Optional full-text search across the mailbox."),
        folderId: str("Optional mail folder id, e.g. 'inbox' or a folder id."),
      },
    },
  },
  "outlook.getMessage": {
    description: "Fetch a single Outlook message with its full body.",
    parameters: {
      type: "object",
      properties: { messageId: str("The message id.") },
      required: ["messageId"],
    },
  },
  "outlook.sendMail": {
    description:
      "Send an email from the connected Outlook account (saved to Sent Items by default).",
    parameters: {
      type: "object",
      properties: {
        to: recipients("Recipient address(es)."),
        cc: recipients("CC address(es)."),
        bcc: recipients("BCC address(es)."),
        subject: str("Email subject."),
        body: str("Email body content."),
        bodyType: {
          type: "string",
          enum: ["text", "html"],
          description: "Body content type. Defaults to text.",
        },
        saveToSentItems: {
          type: "boolean",
          description: "Save a copy to Sent Items. Defaults to true.",
        },
      },
      required: ["to"],
    },
  },
  "outlook.createDraft": {
    description: "Create a draft email in the connected Outlook account.",
    parameters: {
      type: "object",
      properties: {
        to: recipients("Recipient address(es)."),
        cc: recipients("CC address(es)."),
        bcc: recipients("BCC address(es)."),
        subject: str("Email subject."),
        body: str("Email body content."),
        bodyType: {
          type: "string",
          enum: ["text", "html"],
          description: "Body content type. Defaults to text.",
        },
      },
    },
  },
  "outlook.listEvents": {
    description:
      "List Outlook calendar events. Provide start+end (ISO 8601) to expand recurrences in a window.",
    parameters: {
      type: "object",
      properties: {
        top: { type: "number", description: "Max events to return (<=100)." },
        start: str("Window start, ISO 8601 (requires end)."),
        end: str("Window end, ISO 8601 (requires start)."),
      },
    },
  },
  "outlook.createEvent": {
    description: "Create an Outlook calendar event.",
    parameters: {
      type: "object",
      properties: {
        subject: str("Event title."),
        start: str("Start time, ISO 8601 (e.g. 2026-08-22T09:00:00)."),
        end: str("End time, ISO 8601."),
        timeZone: str("IANA time zone, e.g. 'America/New_York'. Defaults to UTC."),
        body: str("Optional event body/notes."),
        location: str("Optional location display name."),
        attendees: recipients("Optional attendee address(es)."),
        isAllDay: { type: "boolean", description: "Mark as an all-day event." },
      },
      required: ["subject", "start", "end"],
    },
  },
  "teams.listJoinedTeams": {
    description: "List the Microsoft Teams the signed-in user belongs to.",
    parameters: { type: "object", properties: {} },
  },
  "teams.listChannels": {
    description: "List channels within a Microsoft Team.",
    parameters: {
      type: "object",
      properties: { teamId: str("The team (group) id.") },
      required: ["teamId"],
    },
  },
  "teams.listChannelMessages": {
    description: "List recent messages in a Teams channel.",
    parameters: {
      type: "object",
      properties: {
        teamId: str("The team (group) id."),
        channelId: str("The channel id."),
        top: { type: "number", description: "Max messages to return (<=100)." },
      },
      required: ["teamId", "channelId"],
    },
  },
  "teams.sendChannelMessage": {
    description: "Post a message to a Microsoft Teams channel.",
    parameters: {
      type: "object",
      properties: {
        teamId: str("The team (group) id."),
        channelId: str("The channel id."),
        content: str("Message content."),
        contentType: {
          type: "string",
          enum: ["text", "html"],
          description: "Content type. Defaults to text.",
        },
      },
      required: ["teamId", "channelId", "content"],
    },
  },
  "excel.listWorksheets": {
    description: "List the worksheets in an Excel workbook.",
    parameters: {
      type: "object",
      properties: { ...workbookLocator },
    },
  },
  "excel.getRange": {
    description:
      "Read a range of cells (values, text, formulas) from a worksheet, e.g. 'A1:C10'.",
    parameters: {
      type: "object",
      properties: {
        ...workbookLocator,
        worksheet: str("Worksheet name or id."),
        address: str("Range address, e.g. 'A1:C10'."),
      },
      required: ["worksheet", "address"],
    },
  },
  "excel.updateRange": {
    description:
      "Write a 2D array of values into a worksheet range, overwriting existing cells.",
    parameters: {
      type: "object",
      properties: {
        ...workbookLocator,
        worksheet: str("Worksheet name or id."),
        address: str("Range address to write, e.g. 'A1:C3'."),
        values: rows2d("2D array of cell values matching the range shape."),
      },
      required: ["worksheet", "address", "values"],
    },
  },
  "excel.listTables": {
    description: "List the tables defined in an Excel workbook.",
    parameters: {
      type: "object",
      properties: { ...workbookLocator },
    },
  },
  "excel.addTableRows": {
    description: "Append one or more rows to an Excel table (by name or id).",
    parameters: {
      type: "object",
      properties: {
        ...workbookLocator,
        table: str("Table name or id."),
        values: rows2d("2D array of rows to append, matching the table columns."),
        index: {
          type: ["number", "null"],
          description: "Optional insert index; null appends at the end.",
        },
      },
      required: ["table", "values"],
    },
  },
};
