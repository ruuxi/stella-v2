import { ConnectorError } from "../errors";
import type {
  FirstPartyExecuteContext,
  ProviderExecuteHandler,
} from "./first_party";

type ProviderFetch = (args: {
  ctx: FirstPartyExecuteContext;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}) => Promise<{ output: unknown; providerStatusClass: string }>;

type JsonRecord = Record<string, unknown>;

const GRAPH_ORIGIN = "https://graph.microsoft.com";

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

const requiredString = (input: JsonRecord, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ConnectorError("invalid_input");
  }
  return value.trim();
};

const optionalString = (input: JsonRecord, key: string): string | undefined => {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ConnectorError("invalid_input");
  return value.trim() || undefined;
};

const optionalBoolean = (
  input: JsonRecord,
  key: string,
): boolean | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ConnectorError("invalid_input");
  return value;
};

const optionalInteger = (
  input: JsonRecord,
  key: string,
  min: number,
  max: number,
): number | undefined => {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConnectorError("invalid_input");
  }
  return Math.max(min, Math.min(max, value));
};

const stringList = (value: unknown): string[] => {
  if (value === undefined || value === null || value === "") return [];
  const values = typeof value === "string" ? value.split(",") : value;
  if (
    !Array.isArray(values) ||
    values.some((item) => typeof item !== "string")
  ) {
    throw new ConnectorError("invalid_input");
  }
  return values.map((item) => item.trim()).filter(Boolean);
};

const enc = encodeURIComponent;
const odataString = (value: string): string => value.replaceAll("'", "''");

const withQuery = (
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): string => {
  const url = new URL(path, "https://graph.microsoft.com");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
};

const encodePageToken = (nextLink: unknown): string | undefined =>
  typeof nextLink === "string" && nextLink
    ? btoa(nextLink)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "")
    : undefined;

const decodePageToken = (token: string, expectedPath: string): string => {
  try {
    const padded = token.replaceAll("-", "+").replaceAll("_", "/");
    const nextLink = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const url = new URL(nextLink);
    const expectedUrl = new URL(expectedPath, GRAPH_ORIGIN);
    if (url.origin !== GRAPH_ORIGIN || url.pathname !== expectedUrl.pathname) {
      throw new Error("unexpected endpoint");
    }
    return url.toString();
  } catch {
    throw new ConnectorError("invalid_input");
  }
};

const pagedOutput = (value: unknown): JsonRecord => {
  const record = asRecord(value);
  const { "@odata.nextLink": nextLink, ...rest } = record;
  return {
    ...rest,
    ...(encodePageToken(nextLink)
      ? { next_page_token: encodePageToken(nextLink) }
      : {}),
  };
};

const pagedGet = async (
  fetchJson: ProviderFetch,
  ctx: FirstPartyExecuteContext,
  path: string,
  headers?: Record<string, string>,
) => {
  const token = optionalString(ctx.input, "page_token");
  const result = await fetchJson({
    ctx,
    method: "GET",
    path: token ? decodePageToken(token, path) : path,
    headers,
  });
  return { ...result, output: pagedOutput(result.output) };
};

const userPath = (input: JsonRecord): string => {
  const userId = optionalString(input, "user_id") ?? "me";
  return userId.toLowerCase() === "me" ? "me" : `users/${enc(userId)}`;
};

const recipients = (values: string[], name?: string) =>
  values.map((address, index) => ({
    emailAddress: {
      address,
      ...(index === 0 && name ? { name } : {}),
    },
  }));

const OUTLOOK_MINIMAL_MESSAGE_FIELDS = [
  "id",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "bodyPreview",
  "hasAttachments",
  "importance",
  "isRead",
  "categories",
  "conversationId",
  "parentFolderId",
  "webLink",
] as const;

const filterMessages = (input: JsonRecord, value: unknown[]): unknown[] => {
  const fromAddress = optionalString(input, "from_address")?.toLowerCase();
  const conversationId = optionalString(input, "conversation_id");
  const hasAttachments = optionalBoolean(input, "has_attachments");
  const subjectContains = optionalString(
    input,
    "subject_contains",
  )?.toLowerCase();
  const subjectStartsWith = optionalString(
    input,
    "subject_startswith",
  )?.toLowerCase();
  const subjectEndsWith = optionalString(
    input,
    "subject_endswith",
  )?.toLowerCase();

  return value.filter((message) => {
    const record = asRecord(message);
    const subject =
      typeof record.subject === "string" ? record.subject.toLowerCase() : "";
    const from = asRecord(asRecord(record.from).emailAddress).address;
    if (
      fromAddress &&
      (typeof from !== "string" || from.toLowerCase() !== fromAddress)
    ) {
      return false;
    }
    if (conversationId && record.conversationId !== conversationId)
      return false;
    if (
      hasAttachments !== undefined &&
      record.hasAttachments !== hasAttachments
    ) {
      return false;
    }
    if (subjectContains && !subject.includes(subjectContains)) return false;
    if (subjectStartsWith && !subject.startsWith(subjectStartsWith))
      return false;
    if (subjectEndsWith && !subject.endsWith(subjectEndsWith)) return false;
    return true;
  });
};

const recurringEventWindow = (
  input: JsonRecord,
  filter: string | undefined,
): { startDateTime: string; endDateTime: string } => {
  const startDateTime =
    optionalString(input, "start_datetime") ??
    filter?.match(/\bstart\/dateTime\s+(?:ge|gt)\s+'([^']+)'/iu)?.[1];
  const endDateTime =
    optionalString(input, "end_datetime") ??
    filter?.match(/\bend\/dateTime\s+(?:le|lt)\s+'([^']+)'/iu)?.[1];
  if (!startDateTime || !endDateTime) {
    throw new ConnectorError("invalid_input");
  }
  return { startDateTime, endDateTime };
};

const messageBody = (input: JsonRecord) => ({
  subject: optionalString(input, "subject") ?? "",
  body: {
    contentType: optionalBoolean(input, "is_html") ? "html" : "text",
    content: optionalString(input, "body") ?? "",
  },
});

const rejectAttachments = (input: JsonRecord) => {
  if (input.attachment !== undefined && input.attachment !== null) {
    // Composio file handles are not transferable to Graph without a separate,
    // verified content-download contract. Refuse rather than dropping data.
    throw new ConnectorError("invalid_input");
  }
};

const outlookHandler = async (
  fetchJson: ProviderFetch,
  ctx: FirstPartyExecuteContext,
) => {
  const input = ctx.input;
  const user = userPath(input);
  switch (ctx.action) {
    case "OUTLOOK_LIST_MESSAGES": {
      const folder = optionalString(input, "folder") ?? "inbox";
      const base =
        folder.toLowerCase() === "allfolders"
          ? `/v1.0/${user}/messages`
          : `/v1.0/${user}/mailFolders/${enc(folder)}/messages`;
      const search = optionalString(input, "search");
      const filters: string[] = [];
      if (typeof input.is_read === "boolean") {
        filters.push(`isRead eq ${String(input.is_read)}`);
      }
      for (const [key, field, operator] of [
        ["sent_date_time_gt", "sentDateTime", "gt"],
        ["sent_date_time_lt", "sentDateTime", "lt"],
        ["received_date_time_ge", "receivedDateTime", "ge"],
        ["received_date_time_gt", "receivedDateTime", "gt"],
        ["received_date_time_le", "receivedDateTime", "le"],
        ["received_date_time_lt", "receivedDateTime", "lt"],
      ] as const) {
        const value = optionalString(input, key);
        if (value) filters.push(`${field} ${operator} ${value}`);
      }
      const subject = optionalString(input, "subject");
      if (subject) filters.push(`subject eq '${odataString(subject)}'`);
      const importance = optionalString(input, "importance");
      if (importance)
        filters.push(`importance eq '${odataString(importance)}'`);
      for (const category of stringList(input.categories)) {
        filters.push(`categories/any(c:c eq '${odataString(category)}')`);
      }
      const requestedSelect = stringList(input.select);
      const clientFilterFields = [
        ...(optionalString(input, "from_address") ? ["from"] : []),
        ...(optionalString(input, "conversation_id") ? ["conversationId"] : []),
        ...(optionalBoolean(input, "has_attachments") !== undefined
          ? ["hasAttachments"]
          : []),
        ...(optionalString(input, "subject_contains") ||
        optionalString(input, "subject_startswith") ||
        optionalString(input, "subject_endswith")
          ? ["subject"]
          : []),
      ];
      const responseDetail =
        optionalString(input, "response_detail") ?? "minimal";
      if (responseDetail !== "minimal" && responseDetail !== "full") {
        throw new ConnectorError("invalid_input");
      }
      const baseSelect =
        requestedSelect.length > 0
          ? requestedSelect
          : responseDetail === "minimal"
            ? [...OUTLOOK_MINIMAL_MESSAGE_FIELDS]
            : [];
      const select = (
        baseSelect.length > 0 ? [...baseSelect, ...clientFilterFields] : []
      ).filter((field, index, fields) => fields.indexOf(field) === index);
      const orderby = stringList(input.orderby);
      const result = await pagedGet(
        fetchJson,
        ctx,
        withQuery(base, {
          $top: optionalInteger(input, "top", 1, 1000) ?? 10,
          $skip: optionalInteger(input, "skip", 0, 100_000) ?? 0,
          $search: search,
          $select: select.length > 0 ? select.join(",") : undefined,
          $filter:
            !search && filters.length > 0 ? filters.join(" and ") : undefined,
          $orderby:
            !search && orderby.length > 0
              ? orderby.join(",")
              : !search
                ? "receivedDateTime desc"
                : undefined,
        }),
        search ? { ConsistencyLevel: "eventual" } : undefined,
      );
      const output = asRecord(result.output);
      if (!Array.isArray(output.value)) return result;
      const value = filterMessages(input, output.value);
      return { ...result, output: { ...output, value } };
    }
    case "OUTLOOK_GET_MESSAGE": {
      const select = stringList(input.select);
      return fetchJson({
        ctx,
        method: "GET",
        path: withQuery(
          `/v1.0/${user}/messages/${enc(requiredString(input, "message_id"))}`,
          { $select: select.length > 0 ? select.join(",") : undefined },
        ),
      });
    }
    case "OUTLOOK_SEND_EMAIL": {
      rejectAttachments(input);
      const to = stringList(input.to ?? input.to_email);
      if (to.length === 0) throw new ConnectorError("invalid_input");
      const fromAddress =
        optionalString(input, "from_address") ?? optionalString(input, "from");
      return fetchJson({
        ctx,
        method: "POST",
        path: `/v1.0/${user}/sendMail`,
        body: {
          message: {
            ...messageBody(input),
            toRecipients: recipients(to, optionalString(input, "to_name")),
            ccRecipients: recipients(stringList(input.cc_emails)),
            bccRecipients: recipients(stringList(input.bcc_emails)),
            ...(fromAddress
              ? { from: { emailAddress: { address: fromAddress } } }
              : {}),
          },
          saveToSentItems: optionalBoolean(input, "save_to_sent_items") ?? true,
        },
      });
    }
    case "OUTLOOK_CREATE_DRAFT": {
      rejectAttachments(input);
      return fetchJson({
        ctx,
        method: "POST",
        path: `/v1.0/${user}/messages`,
        body: {
          ...messageBody(input),
          toRecipients: recipients(stringList(input.to_recipients)),
          ccRecipients: recipients(stringList(input.cc_recipients)),
          bccRecipients: recipients(stringList(input.bcc_recipients)),
          ...(optionalString(input, "conversation_id")
            ? { conversationId: optionalString(input, "conversation_id") }
            : {}),
        },
      });
    }
    case "OUTLOOK_LIST_EVENTS": {
      const calendarId = optionalString(input, "calendar_id");
      const select = stringList(input.select);
      const orderby = stringList(input.orderby);
      const filter = optionalString(input, "filter");
      const expandRecurring =
        optionalBoolean(input, "expand_recurring_events") ?? false;
      if (expandRecurring && optionalString(input, "page_token")) {
        throw new ConnectorError("invalid_input");
      }
      const eventCollection = expandRecurring ? "calendarView" : "events";
      const base = calendarId
        ? `/v1.0/${user}/calendars/${enc(calendarId)}/${eventCollection}`
        : `/v1.0/${user}/${eventCollection}`;
      const window = expandRecurring
        ? recurringEventWindow(input, filter)
        : undefined;
      return pagedGet(
        fetchJson,
        ctx,
        withQuery(base, {
          startDateTime: window?.startDateTime,
          endDateTime: window?.endDateTime,
          $top: optionalInteger(input, "top", 1, 1000) ?? 10,
          $skip: optionalInteger(input, "skip", 0, 100_000) ?? 0,
          $filter: filter,
          $select: select.length > 0 ? select.join(",") : undefined,
          $orderby: orderby.length > 0 ? orderby.join(",") : undefined,
        }),
        {
          Prefer: `outlook.timezone="${optionalString(input, "timezone") ?? "UTC"}"`,
        },
      );
    }
    case "OUTLOOK_CALENDAR_CREATE_EVENT": {
      const calendarId = optionalString(input, "calendar_id");
      const attendees = Array.isArray(input.attendees_info)
        ? input.attendees_info.map((attendee) => {
            if (typeof attendee === "string") {
              return { emailAddress: { address: attendee }, type: "required" };
            }
            const record = asRecord(attendee);
            const nested = asRecord(record.emailAddress);
            const address =
              (typeof record.email === "string" && record.email) ||
              (typeof nested.address === "string" && nested.address);
            if (!address) throw new ConnectorError("invalid_input");
            return {
              emailAddress: {
                address,
                ...((typeof record.name === "string" && record.name) ||
                (typeof nested.name === "string" && nested.name)
                  ? {
                      name:
                        (typeof record.name === "string" && record.name) ||
                        (typeof nested.name === "string"
                          ? nested.name
                          : undefined),
                    }
                  : {}),
              },
              type: typeof record.type === "string" ? record.type : "required",
            };
          })
        : [];
      const timeZone = requiredString(input, "time_zone");
      const startDateTime = requiredString(input, "start_datetime");
      const endDateTime = requiredString(input, "end_datetime");
      const startTime = Date.parse(startDateTime);
      const endTime = Date.parse(endDateTime);
      if (
        !Number.isFinite(startTime) ||
        !Number.isFinite(endTime) ||
        startTime >= endTime
      ) {
        throw new ConnectorError("invalid_input");
      }
      return fetchJson({
        ctx,
        method: "POST",
        path: calendarId
          ? `/v1.0/${user}/calendars/${enc(calendarId)}/events`
          : `/v1.0/${user}/events`,
        body: {
          subject: requiredString(input, "subject"),
          start: {
            dateTime: startDateTime,
            timeZone,
          },
          end: { dateTime: endDateTime, timeZone },
          body: {
            contentType: optionalBoolean(input, "is_html") ? "html" : "text",
            content: optionalString(input, "body") ?? "",
          },
          showAs: optionalString(input, "show_as") ?? "busy",
          importance: optionalString(input, "importance") ?? "normal",
          categories: stringList(input.categories),
          attendees,
          ...(optionalString(input, "location")
            ? { location: { displayName: optionalString(input, "location") } }
            : {}),
          ...(asRecord(input.recurrence).pattern
            ? { recurrence: input.recurrence }
            : {}),
          ...(typeof input.is_online_meeting === "boolean"
            ? { isOnlineMeeting: input.is_online_meeting }
            : {}),
          ...(optionalString(input, "online_meeting_provider")
            ? {
                onlineMeetingProvider: optionalString(
                  input,
                  "online_meeting_provider",
                ),
              }
            : {}),
        },
      });
    }
    default:
      throw new ConnectorError("action_not_found");
  }
};

const teamsHandler = (
  fetchJson: ProviderFetch,
  ctx: FirstPartyExecuteContext,
) => {
  const input = ctx.input;
  switch (ctx.action) {
    case "MICROSOFT_TEAMS_LIST_USER_JOINED_TEAMS": {
      const userId = requiredString(input, "user_id");
      const user =
        userId.toLowerCase() === "me" ? "me" : `users/${enc(userId)}`;
      return pagedGet(fetchJson, ctx, `/v1.0/${user}/joinedTeams`);
    }
    case "MICROSOFT_TEAMS_TEAMS_LIST_CHANNELS": {
      const teamId = enc(requiredString(input, "team_id"));
      const includeShared =
        optionalBoolean(input, "include_shared_channels") ?? false;
      const filter = optionalString(input, "filter");
      return pagedGet(
        fetchJson,
        ctx,
        withQuery(
          `/v1.0/teams/${teamId}/${includeShared ? "allChannels" : "channels"}`,
          {
            $filter: includeShared
              ? filter
              : filter
                ? `(${filter}) and membershipType ne 'shared'`
                : "membershipType ne 'shared'",
            $select: optionalString(input, "select"),
          },
        ),
      );
    }
    case "MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES": {
      const teamId = enc(requiredString(input, "team_id"));
      const channelId = enc(requiredString(input, "channel_id"));
      const expand = optionalString(input, "expand");
      if (expand && expand !== "replies")
        throw new ConnectorError("invalid_input");
      return pagedGet(
        fetchJson,
        ctx,
        withQuery(`/v1.0/teams/${teamId}/channels/${channelId}/messages`, {
          $top: optionalInteger(input, "top", 1, 50) ?? 50,
          $expand: expand,
        }),
      );
    }
    case "MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE": {
      const mentions = Array.isArray(input.mentions)
        ? input.mentions
        : undefined;
      const hostedContents = Array.isArray(input.hosted_contents)
        ? input.hosted_contents.map((item) => {
            const record = asRecord(item);
            return {
              "@microsoft.graph.temporaryId": requiredString(
                record,
                "temporary_id",
              ),
              contentBytes: requiredString(record, "content_bytes"),
              contentType: requiredString(record, "content_type"),
            };
          })
        : undefined;
      return fetchJson({
        ctx,
        method: "POST",
        path: `/v1.0/teams/${enc(requiredString(input, "team_id"))}/channels/${enc(
          requiredString(input, "channel_id"),
        )}/messages`,
        body: {
          body: {
            contentType: mentions?.length
              ? "html"
              : (optionalString(input, "content_type") ?? "text"),
            content: requiredString(input, "content"),
          },
          ...(optionalString(input, "subject")
            ? { subject: optionalString(input, "subject") }
            : {}),
          ...(optionalString(input, "summary")
            ? { summary: optionalString(input, "summary") }
            : {}),
          ...(optionalString(input, "importance")
            ? { importance: optionalString(input, "importance") }
            : {}),
          ...(optionalString(input, "locale")
            ? { locale: optionalString(input, "locale") }
            : {}),
          ...(mentions ? { mentions } : {}),
          ...(Array.isArray(input.attachments)
            ? { attachments: input.attachments }
            : {}),
          ...(hostedContents ? { hostedContents } : {}),
        },
      });
    }
    default:
      throw new ConnectorError("action_not_found");
  }
};

const workbookBase = (input: JsonRecord): string => {
  const itemId = enc(requiredString(input, "item_id"));
  const driveId = optionalString(input, "drive_id");
  return !driveId || driveId.toLowerCase() === "me"
    ? `/v1.0/me/drive/items/${itemId}/workbook`
    : `/v1.0/drives/${enc(driveId)}/items/${itemId}/workbook`;
};

const workbookHeaders = (
  input: JsonRecord,
): Record<string, string> | undefined => {
  const sessionId = optionalString(input, "session_id");
  return sessionId ? { "workbook-session-id": sessionId } : undefined;
};

const excelHandler = (
  fetchJson: ProviderFetch,
  ctx: FirstPartyExecuteContext,
) => {
  const input = ctx.input;
  const base = workbookBase(input);
  const headers = workbookHeaders(input);
  switch (ctx.action) {
    case "EXCEL_LIST_WORKSHEETS":
      return pagedGet(
        fetchJson,
        ctx,
        withQuery(`${base}/worksheets`, {
          $top: optionalInteger(input, "top", 1, 1000),
          $skip: optionalInteger(input, "skip", 0, 100_000),
        }),
        headers,
      );
    case "EXCEL_GET_RANGE":
      return fetchJson({
        ctx,
        method: "GET",
        path: `${base}/worksheets/${enc(
          requiredString(input, "worksheet_id"),
        )}/range(address='${enc(requiredString(input, "address")).replaceAll(
          "'",
          "%27",
        )}')`,
        headers,
      });
    case "EXCEL_UPDATE_RANGE": {
      if (!Array.isArray(input.values))
        throw new ConnectorError("invalid_input");
      return fetchJson({
        ctx,
        method: "PATCH",
        path: `${base}/worksheets/${enc(
          requiredString(input, "worksheet_id"),
        )}/range(address='${enc(requiredString(input, "address")).replaceAll(
          "'",
          "%27",
        )}')`,
        body: { values: input.values },
        headers,
      });
    }
    case "EXCEL_LIST_TABLES":
      return pagedGet(
        fetchJson,
        ctx,
        withQuery(
          `${base}/worksheets/${enc(requiredString(input, "worksheet"))}/tables`,
          {
            $top: optionalInteger(input, "top", 1, 1000),
            $skip: optionalInteger(input, "skip", 0, 100_000),
          },
        ),
        headers,
      );
    case "EXCEL_ADD_TABLE_ROW": {
      if (!Array.isArray(input.values))
        throw new ConnectorError("invalid_input");
      const index = input.index;
      if (index !== undefined && index !== null && !Number.isInteger(index)) {
        throw new ConnectorError("invalid_input");
      }
      return fetchJson({
        ctx,
        method: "POST",
        path: `${base}/tables/${enc(requiredString(input, "table_id"))}/rows/add`,
        body: { values: input.values, index: index ?? null },
        headers,
      });
    }
    default:
      throw new ConnectorError("action_not_found");
  }
};

export const createMicrosoftHandler =
  (fetchJson: ProviderFetch): ProviderExecuteHandler =>
  async (ctx) => {
    if (ctx.action.startsWith("OUTLOOK_"))
      return outlookHandler(fetchJson, ctx);
    if (ctx.action.startsWith("MICROSOFT_TEAMS_")) {
      return teamsHandler(fetchJson, ctx);
    }
    if (ctx.action.startsWith("EXCEL_")) return excelHandler(fetchJson, ctx);
    throw new ConnectorError("action_not_found");
  };

export const MICROSOFT_ACTION_OPERATIONS = {
  OUTLOOK_LIST_MESSAGES: "read",
  OUTLOOK_GET_MESSAGE: "read",
  OUTLOOK_SEND_EMAIL: "write",
  OUTLOOK_CREATE_DRAFT: "write",
  OUTLOOK_LIST_EVENTS: "read",
  OUTLOOK_CALENDAR_CREATE_EVENT: "write",
  MICROSOFT_TEAMS_LIST_USER_JOINED_TEAMS: "read",
  MICROSOFT_TEAMS_TEAMS_LIST_CHANNELS: "read",
  MICROSOFT_TEAMS_TEAMS_LIST_CHANNEL_MESSAGES: "read",
  MICROSOFT_TEAMS_TEAMS_POST_CHANNEL_MESSAGE: "write",
  EXCEL_LIST_WORKSHEETS: "read",
  EXCEL_GET_RANGE: "read",
  EXCEL_UPDATE_RANGE: "write",
  EXCEL_LIST_TABLES: "read",
  EXCEL_ADD_TABLE_ROW: "write",
} as const;

export const MICROSOFT_CONNECTOR_ACTIONS: Readonly<
  Record<string, readonly string[]>
> = {
  outlook: Object.keys(MICROSOFT_ACTION_OPERATIONS).filter((action) =>
    action.startsWith("OUTLOOK_"),
  ),
  microsoft_teams: Object.keys(MICROSOFT_ACTION_OPERATIONS).filter((action) =>
    action.startsWith("MICROSOFT_TEAMS_"),
  ),
  excel: Object.keys(MICROSOFT_ACTION_OPERATIONS).filter((action) =>
    action.startsWith("EXCEL_"),
  ),
};
