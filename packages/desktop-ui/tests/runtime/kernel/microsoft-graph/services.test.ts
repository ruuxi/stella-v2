import { describe, expect, it } from "vitest";

import {
  GraphClient,
  type GraphFetch,
} from "@stella/runtime/kernel/microsoft-graph/GraphClient";
import { OutlookService } from "@stella/runtime/kernel/microsoft-graph/OutlookService";
import { TeamsService } from "@stella/runtime/kernel/microsoft-graph/TeamsService";
import { ExcelService } from "@stella/runtime/kernel/microsoft-graph/ExcelService";

type Recorded = { url: string; method: string; body?: unknown };

const harness = (responses: Record<string, unknown> = {}) => {
  const calls: Recorded[] = [];
  const fetchImpl: GraphFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    // Longest-prefix match against the path portion of the URL.
    const path = url.replace("https://graph.microsoft.com/v1.0", "");
    const key =
      Object.keys(responses)
        .filter((k) => path.startsWith(k))
        .sort((a, b) => b.length - a.length)[0] ?? null;
    const payload = key ? responses[key] : {};
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify(payload),
      headers: { get: () => null },
    };
  };
  const graph = new GraphClient({
    getAccessToken: async () => "tok",
    fetchImpl,
  });
  return { graph, calls };
};

const parse = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0]!.text);

describe("OutlookService", () => {
  it("lists messages with $search and select", async () => {
    const { graph, calls } = harness({
      "/me/messages": { value: [{ id: "m1" }] },
    });
    const out = await new OutlookService(graph).listMessages({
      search: "invoice",
      top: 5,
    });
    expect(parse(out)).toEqual({ messages: [{ id: "m1" }] });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain("%24search=%22invoice%22");
    expect(calls[0]!.url).toContain("%24top=5");
  });

  it("sends mail with a normalized recipient envelope", async () => {
    const { graph, calls } = harness();
    const out = await new OutlookService(graph).sendMail({
      to: "a@example.com",
      subject: "Hi",
      body: "Body",
    });
    expect(parse(out)).toEqual({ sent: true });
    expect(calls[0]!.url).toContain("/me/sendMail");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toMatchObject({
      message: {
        subject: "Hi",
        body: { contentType: "text", content: "Body" },
        toRecipients: [{ emailAddress: { address: "a@example.com" } }],
      },
      saveToSentItems: true,
    });
  });

  it("creates a calendar event with start/end time zones", async () => {
    const { graph, calls } = harness({
      "/me/events": { id: "e1", webLink: "http://x" },
    });
    const out = await new OutlookService(graph).createEvent({
      subject: "Sync",
      start: "2026-08-22T09:00:00",
      end: "2026-08-22T09:30:00",
      timeZone: "America/New_York",
    });
    expect(parse(out)).toEqual({ id: "e1", webLink: "http://x" });
    expect(calls[0]!.body).toMatchObject({
      subject: "Sync",
      start: { dateTime: "2026-08-22T09:00:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-08-22T09:30:00", timeZone: "America/New_York" },
    });
  });

  it("uses calendarView when a window is supplied", async () => {
    const { graph, calls } = harness({ "/me/calendarView": { value: [] } });
    await new OutlookService(graph).listEvents({
      start: "2026-08-01T00:00:00Z",
      end: "2026-08-31T00:00:00Z",
    });
    expect(calls[0]!.url).toContain("/me/calendarView");
    expect(calls[0]!.url).toContain("startDateTime=");
  });
});

describe("TeamsService", () => {
  it("lists channels for a team", async () => {
    const { graph, calls } = harness({
      "/teams/team-1/channels": { value: [{ id: "c1" }] },
    });
    const out = await new TeamsService(graph).listChannels({ teamId: "team-1" });
    expect(parse(out)).toEqual({ channels: [{ id: "c1" }] });
    expect(calls[0]!.url).toContain("/teams/team-1/channels");
  });

  it("posts a channel message with the html/text content type", async () => {
    const { graph, calls } = harness({
      "/teams/team-1/channels/c1/messages": { id: "msg-1", webUrl: "http://t" },
    });
    const out = await new TeamsService(graph).sendChannelMessage({
      teamId: "team-1",
      channelId: "c1",
      content: "<b>hi</b>",
      contentType: "html",
    });
    expect(parse(out)).toEqual({ id: "msg-1", webUrl: "http://t" });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      body: { contentType: "html", content: "<b>hi</b>" },
    });
  });
});

describe("ExcelService", () => {
  it("reads a range by worksheet + address on a drive item", async () => {
    const { graph, calls } = harness({
      "/me/drive/items/item-1/workbook": {
        address: "Sheet1!A1:B2",
        values: [[1, 2]],
        text: [["1", "2"]],
      },
    });
    const out = await new ExcelService(graph).getRange({
      itemId: "item-1",
      worksheet: "Sheet1",
      address: "A1:B2",
    });
    expect(parse(out)).toMatchObject({ address: "Sheet1!A1:B2", values: [[1, 2]] });
    expect(calls[0]!.url).toContain(
      "/me/drive/items/item-1/workbook/worksheets/Sheet1/range(address='A1%3AB2')",
    );
  });

  it("patches a range with a 2D value array", async () => {
    const { graph, calls } = harness({
      "/me/drive/items/item-1/workbook": {
        address: "Sheet1!A1:A2",
        rowCount: 2,
        columnCount: 1,
      },
    });
    await new ExcelService(graph).updateRange({
      itemId: "item-1",
      worksheet: "Sheet1",
      address: "A1:A2",
      values: [["x"], ["y"]],
    });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.body).toEqual({ values: [["x"], ["y"]] });
  });

  it("resolves a workbook by drive path when itemPath is used", async () => {
    const { graph, calls } = harness({
      "/me/drive/root:": { value: [] },
    });
    await new ExcelService(graph).listWorksheets({
      itemPath: "Reports/Q3.xlsx",
    });
    expect(calls[0]!.url).toContain(
      "/me/drive/root:/Reports/Q3.xlsx:/workbook/worksheets",
    );
  });

  it("surfaces an error result when no workbook locator is provided", async () => {
    const { graph } = harness();
    const out = await new ExcelService(graph).listWorksheets({});
    expect((out as { isError?: boolean }).isError).toBe(true);
    expect(parse(out as never).error).toMatch(/itemId or itemPath/);
  });

  it("appends table rows via rows/add", async () => {
    const { graph, calls } = harness({
      "/me/drive/items/item-1/workbook": { index: 3 },
    });
    const out = await new ExcelService(graph).addTableRows({
      itemId: "item-1",
      table: "Table1",
      values: [["a", "b"]],
    });
    expect(parse(out)).toEqual({ index: 3, addedRows: 1 });
    expect(calls[0]!.url).toContain(
      "/me/drive/items/item-1/workbook/tables/Table1/rows/add",
    );
    expect(calls[0]!.body).toEqual({ values: [["a", "b"]], index: null });
  });
});
