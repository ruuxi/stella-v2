import { describe, expect, test } from "bun:test";
import {
  CloudConnectorDirectory,
  createCloudConnectClient,
  resolveCloudConnectorEntry,
} from "../src/cloud-connect-client.js";
import { createCloudConnectorStatusTool } from "../src/cloud-connector-status-tool.js";

const catalog = [
  {
    id: "gmail",
    name: "Gmail",
    category: "email",
    description: "Read and send Gmail messages.",
    catalogToolCount: 12,
    iconUrl: "https://icons.example/gmail.png",
    connector: { type: "composio", toolkit: "gmail" },
  },
  {
    id: "notion",
    name: "Notion",
    category: "docs",
    description: "Pages and databases.",
    catalogToolCount: 30,
    connector: { type: "composio", toolkit: "notion" },
  },
  {
    id: "legacy",
    name: "Legacy OAuth",
    category: "misc",
    description: "Not Composio-backed.",
    catalogToolCount: 1,
    connector: { type: "oauth" },
  },
];

type Call = { path: string; method: string; body?: unknown; headers?: Record<string, string> };

const directoryWith = (
  routes: (call: Call) => Response | Promise<Response>,
  calls: Call[] = [],
  declined = new Set<string>(),
) =>
  new CloudConnectorDirectory({
    convexFetch: async (path, init) => {
      const call: Call = {
        path,
        method: init.method,
        ...(init.body ? { body: JSON.parse(init.body) } : {}),
        ...(init.headers ? { headers: init.headers } : {}),
      };
      calls.push(call);
      return await routes(call);
    },
    declines: {
      isDeclined: async (id) => declined.has(id),
      recordDecline: async (id) => {
        declined.add(id);
      },
    },
  });

const standardRoutes =
  (connections: Array<{ id: string; connected: boolean }>) =>
  (call: Call): Response => {
    if (call.path === "/api/native-integrations/catalog") {
      return Response.json({ integrations: catalog });
    }
    if (call.path === "/api/native-integrations/connections") {
      return Response.json({ connections });
    }
    if (call.path.startsWith("/api/native-integrations/actions?")) {
      const params = new URL(`https://x${call.path}`).searchParams;
      if (params.get("action")) {
        return Response.json({
          id: params.get("id"),
          actionCount: 1,
          actions: [
            {
              name: params.get("action"),
              description: "Fetch the profile.",
              inputSchema: { type: "object", properties: { user_id: { type: "string" } }, required: ["user_id"] },
            },
          ],
          nextCursor: null,
        });
      }
      return Response.json({
        id: params.get("id"),
        actionCount: 2,
        actions: [
          { name: "GMAIL_GET_PROFILE", description: "Fetch the profile.", inputSchema: { type: "object", properties: { user_id: { type: "string" } } } },
          { name: "GMAIL_SEND_EMAIL", description: "Send an email.", inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to"] } },
        ],
        nextCursor: null,
      });
    }
    if (call.path === "/api/native-integrations/run") {
      return Response.json({ successful: true, data: { email: "me@example.com" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };

describe("cloud connect client", () => {
  test("every request carries the cloud-turn caller header", async () => {
    const calls: Call[] = [];
    const client = createCloudConnectClient(
      directoryWith(standardRoutes([{ id: "gmail", connected: true }]), calls),
    );
    await client.connectors();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers?.["x-stella-caller"]).toBe("cloud-turn");
    }
  });

  test("discover ranks Store integrations and reports account connection state", async () => {
    const client = createCloudConnectClient(
      directoryWith(standardRoutes([{ id: "gmail", connected: true }])),
    );
    const discovered = (await client.discover("gmail")) as {
      query: string;
      matches: Array<Record<string, unknown>>;
    };
    expect(discovered.query).toBe("gmail");
    expect(discovered.matches[0]).toMatchObject({
      id: "gmail",
      kind: "native",
      connected: true,
      enabled: true,
      executable: true,
      next: expect.stringContaining('connect.actions("gmail")'),
    });
    expect(discovered.matches.some((match) => match.id === "legacy")).toBe(false);
    const notion = (await client.discover("notion pages")) as { matches: Array<Record<string, unknown>> };
    expect(notion.matches[0]).toMatchObject({
      id: "notion",
      connected: false,
      next: expect.stringContaining("connector_status"),
    });
  });

  test("connectors lists only the account's connected integrations", async () => {
    const client = createCloudConnectClient(
      directoryWith(
        standardRoutes([
          { id: "gmail", connected: true },
          { id: "notion", connected: false },
        ]),
      ),
    );
    expect(await client.connectors()).toEqual([
      { id: "gmail", name: "Gmail", kind: "native", connected: true, description: "Read and send Gmail messages." },
      { id: "notion", name: "Notion", kind: "native", connected: false, description: "Pages and databases." },
    ]);
  });

  test("actions and schema read the Store catalog with the device shapes", async () => {
    const client = createCloudConnectClient(directoryWith(standardRoutes([])));
    const actions = (await client.actions("gmail", { limit: 1 })) as Record<string, unknown>;
    expect(actions).toMatchObject({
      connector: "gmail",
      total: 2,
      shown: 1,
      actions: [{ name: "GMAIL_GET_PROFILE", description: "Fetch the profile.", params: "optional: user_id" }],
      hint: expect.stringContaining("Showing 1 of 2"),
    });
    const schema = (await client.schema("gmail", "GMAIL_GET_PROFILE")) as Record<string, unknown>;
    expect(schema).toMatchObject({
      connector: "gmail",
      name: "GMAIL_GET_PROFILE",
      inputSchema: { type: "object", required: ["user_id"] },
    });
  });

  test("call runs a mutating action through the account-level run route", async () => {
    const calls: Call[] = [];
    const client = createCloudConnectClient(directoryWith(standardRoutes([]), calls));
    const outcome = await client.call("gmail", "GMAIL_SEND_EMAIL", { to: "a@b.c", body: "hi" });
    expect(outcome).toEqual({ successful: true, data: { email: "me@example.com" } });
    const run = calls.find((call) => call.path === "/api/native-integrations/run");
    expect(run).toMatchObject({
      method: "POST",
      body: { id: "gmail", action: "GMAIL_SEND_EMAIL", input: { to: "a@b.c", body: "hi" } },
    });
    expect(run?.headers?.["x-stella-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("call explains a not-connected integration and rejects desktop-only surfaces", async () => {
    const client = createCloudConnectClient(
      directoryWith((call) =>
        call.path === "/api/native-integrations/run"
          ? Response.json({ error: "Connect this integration before using it." }, { status: 409 })
          : standardRoutes([])(call),
      ),
    );
    await expect(client.call("gmail", "GMAIL_GET_PROFILE", {})).rejects.toThrow(
      /connector_status/,
    );
    await expect(client.call("gmail", "/v1/items", {})).rejects.toThrow(/desktop/);
    await expect(client.addMcp({ id: "x" })).rejects.toThrow(/desktop-only/);
    await expect(client.remove("x")).rejects.toThrow(/desktop-only/);
  });

  test("resolveCloudConnectorEntry accepts ids, names, and strong keyword hits", () => {
    const entries = catalog
      .filter((entry) => entry.connector.type === "composio")
      .map((entry) => ({ ...entry, toolkit: entry.id.toUpperCase() }));
    expect(resolveCloudConnectorEntry(entries, "Gmail").entry?.id).toBe("gmail");
    expect(resolveCloudConnectorEntry(entries, "notion").entry?.id).toBe("notion");
    expect(resolveCloudConnectorEntry(entries, "spreadsheet").entry).toBeNull();
  });
});

describe("cloud connector_status", () => {
  test("reports a connected integration without showing a card", async () => {
    let requested = false;
    const tool = createCloudConnectorStatusTool({
      directory: directoryWith(standardRoutes([{ id: "gmail", connected: true }])),
      requestConnection: async () => {
        requested = true;
        return { ok: true, status: "connected" };
      },
    });
    const outcome = await tool.execute("call", { connector: "gmail" });
    expect(requested).toBe(false);
    expect(outcome.details).toMatchObject({ id: "gmail", status: "executable" });
    expect(outcome.content[0]).toMatchObject({
      text: expect.stringContaining('connect.call("gmail"'),
    });
  });

  test("shows the card, then reports the user's answer and remembers a decline", async () => {
    const declined = new Set<string>();
    const directory = directoryWith(
      standardRoutes([{ id: "gmail", connected: false }]),
      [],
      declined,
    );
    const requests: unknown[] = [];
    let answer: { ok: true; status: "connected" } | { ok: false; reason: string } = {
      ok: false,
      reason: "declined",
    };
    const tool = createCloudConnectorStatusTool({
      directory,
      declines: {
        isDeclined: async (id) => declined.has(id),
        recordDecline: async (id) => {
          declined.add(id);
        },
      },
      requestConnection: async (request) => {
        requests.push(request);
        return answer;
      },
    });
    const first = await tool.execute("call-1", { connector: "Gmail", reason: "To read receipts" });
    expect(requests[0]).toMatchObject({
      id: "gmail",
      name: "Gmail",
      iconUrl: "https://icons.example/gmail.png",
      reason: "To read receipts",
    });
    expect(first.details).toMatchObject({ id: "gmail", status: "declined" });
    // A second ask never re-offers.
    const second = await tool.execute("call-2", { connector: "gmail" });
    expect(requests).toHaveLength(1);
    expect(second.details).toMatchObject({ status: "declined", reason: "declined_previously" });

    declined.clear();
    answer = { ok: true, status: "connected" };
    const third = await tool.execute("call-3", { connector: "gmail" });
    expect(third.details).toEqual({ id: "gmail", status: "connected" });
  });

  test("unknown connectors get suggestions instead of a card", async () => {
    const tool = createCloudConnectorStatusTool({
      directory: directoryWith(standardRoutes([])),
      requestConnection: async () => ({ ok: true, status: "connected" }),
    });
    const outcome = await tool.execute("call", { connector: "some spreadsheet thing" });
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]).toMatchObject({
      text: expect.stringContaining("No Store connector matched"),
    });
  });
});
