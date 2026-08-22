import { GRAPH_DEFAULT_PAGE_SIZE, GRAPH_MAX_PAGE_SIZE } from "./constants.js";
import type { GraphClient } from "./GraphClient.js";
import { ok, fail, type ServiceContent } from "./service-result.js";

const clampTop = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return GRAPH_DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), GRAPH_MAX_PAGE_SIZE);
};

type Recipient = string | { address?: string; name?: string };

const toRecipients = (value: Recipient | Recipient[] | undefined) => {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((entry) =>
      typeof entry === "string"
        ? { emailAddress: { address: entry } }
        : entry.address
          ? {
              emailAddress: {
                address: entry.address,
                ...(entry.name ? { name: entry.name } : {}),
              },
            }
          : null,
    )
    .filter((entry): entry is { emailAddress: { address: string } } =>
      Boolean(entry),
    );
};

const buildMessage = (args: {
  subject?: string;
  body?: string;
  bodyType?: "text" | "html";
  to?: Recipient | Recipient[];
  cc?: Recipient | Recipient[];
  bcc?: Recipient | Recipient[];
}) => ({
  ...(args.subject !== undefined ? { subject: args.subject } : {}),
  body: {
    contentType: args.bodyType === "html" ? "html" : "text",
    content: args.body ?? "",
  },
  toRecipients: toRecipients(args.to),
  ...(args.cc ? { ccRecipients: toRecipients(args.cc) } : {}),
  ...(args.bcc ? { bccRecipients: toRecipients(args.bcc) } : {}),
});

const MESSAGE_SELECT =
  "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,webLink,hasAttachments";

const EVENT_SELECT =
  "id,subject,start,end,location,organizer,attendees,isAllDay,webLink,bodyPreview";

/**
 * Representative first-party Outlook (mail + calendar) service over Microsoft
 * Graph. Delegated `/me` endpoints only, backed by the shared Microsoft grant's
 * `Mail.ReadWrite`, `Mail.Send`, and `Calendars.ReadWrite` scopes.
 */
export class OutlookService {
  constructor(private readonly graph: GraphClient) {}

  /** Lists recent mail; `search` uses Graph `$search`, otherwise most-recent first. */
  public listMessages = async (args: {
    top?: number;
    search?: string;
    folderId?: string;
  }): Promise<ServiceContent> => {
    try {
      const base = args.folderId
        ? `/me/mailFolders/${encodeURIComponent(args.folderId)}/messages`
        : "/me/messages";
      const query: Record<string, string | number> = {
        $top: clampTop(args.top),
        $select: MESSAGE_SELECT,
      };
      if (args.search) {
        query.$search = `"${args.search.replace(/"/g, '\\"')}"`;
      } else {
        query.$orderby = "receivedDateTime desc";
      }
      const data = await this.graph.get<{ value?: unknown[] }>(base, query);
      return ok({ messages: data.value ?? [] });
    } catch (error) {
      return fail("outlook.listMessages", error);
    }
  };

  /** Fetches a single message with its full body. */
  public getMessage = async (args: {
    messageId: string;
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.get(
        `/me/messages/${encodeURIComponent(args.messageId)}`,
      );
      return ok(data);
    } catch (error) {
      return fail("outlook.getMessage", error);
    }
  };

  /** Sends mail immediately, saving a copy to Sent Items by default. */
  public sendMail = async (args: {
    subject?: string;
    body?: string;
    bodyType?: "text" | "html";
    to?: Recipient | Recipient[];
    cc?: Recipient | Recipient[];
    bcc?: Recipient | Recipient[];
    saveToSentItems?: boolean;
  }): Promise<ServiceContent> => {
    try {
      await this.graph.post("/me/sendMail", {
        message: buildMessage(args),
        saveToSentItems: args.saveToSentItems !== false,
      });
      return ok({ sent: true });
    } catch (error) {
      return fail("outlook.sendMail", error);
    }
  };

  /** Creates a draft message, returning its id and web link. */
  public createDraft = async (args: {
    subject?: string;
    body?: string;
    bodyType?: "text" | "html";
    to?: Recipient | Recipient[];
    cc?: Recipient | Recipient[];
    bcc?: Recipient | Recipient[];
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.post<{ id?: string; webLink?: string }>(
        "/me/messages",
        buildMessage(args),
      );
      return ok({ id: data.id, webLink: data.webLink });
    } catch (error) {
      return fail("outlook.createDraft", error);
    }
  };

  /** Lists calendar events in a time window (calendarView expands recurrences). */
  public listEvents = async (args: {
    top?: number;
    start?: string;
    end?: string;
  }): Promise<ServiceContent> => {
    try {
      if (args.start && args.end) {
        const data = await this.graph.get<{ value?: unknown[] }>(
          "/me/calendarView",
          {
            startDateTime: args.start,
            endDateTime: args.end,
            $top: clampTop(args.top),
            $select: EVENT_SELECT,
            $orderby: "start/dateTime",
          },
        );
        return ok({ events: data.value ?? [] });
      }
      const data = await this.graph.get<{ value?: unknown[] }>("/me/events", {
        $top: clampTop(args.top),
        $select: EVENT_SELECT,
        $orderby: "start/dateTime",
      });
      return ok({ events: data.value ?? [] });
    } catch (error) {
      return fail("outlook.listEvents", error);
    }
  };

  /** Creates a calendar event. Times are ISO 8601 with an IANA time zone. */
  public createEvent = async (args: {
    subject: string;
    start: string;
    end: string;
    timeZone?: string;
    body?: string;
    location?: string;
    attendees?: Recipient | Recipient[];
    isAllDay?: boolean;
  }): Promise<ServiceContent> => {
    try {
      const tz = args.timeZone ?? "UTC";
      const data = await this.graph.post<{ id?: string; webLink?: string }>(
        "/me/events",
        {
          subject: args.subject,
          start: { dateTime: args.start, timeZone: tz },
          end: { dateTime: args.end, timeZone: tz },
          ...(args.isAllDay ? { isAllDay: true } : {}),
          ...(args.body
            ? { body: { contentType: "text", content: args.body } }
            : {}),
          ...(args.location
            ? { location: { displayName: args.location } }
            : {}),
          ...(args.attendees
            ? {
                attendees: toRecipients(args.attendees).map((r) => ({
                  emailAddress: r.emailAddress,
                  type: "required",
                })),
              }
            : {}),
        },
      );
      return ok({ id: data.id, webLink: data.webLink });
    } catch (error) {
      return fail("outlook.createEvent", error);
    }
  };
}
