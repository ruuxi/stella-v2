import { describe, expect, it } from "vitest";

import {
  GraphApiError,
  GraphClient,
  type GraphFetch,
} from "@stella/runtime/kernel/microsoft-graph/GraphClient";

type Recorded = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

const makeClient = (
  responder: (req: Recorded) => {
    status?: number;
    ok?: boolean;
    body?: string;
    headers?: Record<string, string>;
  },
  token = "tok-123",
) => {
  const calls: Recorded[] = [];
  const fetchImpl: GraphFetch = async (url, init) => {
    const recorded: Recorded = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(recorded);
    const res = responder(recorded);
    return {
      status: res.status ?? 200,
      ok: res.ok ?? (res.status ?? 200) < 400,
      text: async () => res.body ?? "",
      headers: { get: (name: string) => res.headers?.[name.toLowerCase()] ?? null },
    };
  };
  const client = new GraphClient({
    getAccessToken: async () => token,
    baseUrl: "https://graph.microsoft.com/v1.0",
    fetchImpl,
  });
  return { client, calls };
};

describe("GraphClient", () => {
  it("builds absolute URLs from relative paths and encodes query", () => {
    const { client } = makeClient(() => ({ body: "{}" }));
    expect(client.buildUrl("/me/messages", { $top: 5, $select: "id" })).toBe(
      "https://graph.microsoft.com/v1.0/me/messages?%24top=5&%24select=id",
    );
    // Absolute (nextLink-style) URLs pass through untouched.
    expect(client.buildUrl("https://graph.microsoft.com/v1.0/me/events")).toBe(
      "https://graph.microsoft.com/v1.0/me/events",
    );
  });

  it("injects the bearer token and JSON headers on write requests", async () => {
    const { client, calls } = makeClient(() => ({ status: 201, body: '{"id":"1"}' }));
    const result = await client.post("/me/messages", { subject: "hi" });
    expect(result).toEqual({ id: "1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok-123");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body).toBe(JSON.stringify({ subject: "hi" }));
  });

  it("omits a body and Content-Type on GET", async () => {
    const { client, calls } = makeClient(() => ({ body: '{"value":[]}' }));
    await client.get("/me/messages");
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok-123");
  });

  it("parses Graph error envelopes into GraphApiError without leaking the token", async () => {
    const { client } = makeClient(() => ({
      status: 403,
      ok: false,
      body: JSON.stringify({
        error: { code: "ErrorAccessDenied", message: "Access is denied." },
      }),
      headers: { "request-id": "abc-123" },
    }));
    await expect(client.get("/me/messages")).rejects.toMatchObject({
      name: "GraphApiError",
      status: 403,
      code: "ErrorAccessDenied",
      message: "Access is denied.",
      requestId: "abc-123",
    });
    try {
      await client.get("/me/messages");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphApiError);
      // The credential must never appear in a surfaced error.
      expect((error as Error).message).not.toContain("tok-123");
      expect(JSON.stringify(error)).not.toContain("tok-123");
    }
  });

  it("returns undefined for empty (204) bodies", async () => {
    const { client } = makeClient(() => ({ status: 204, body: "" }));
    await expect(client.delete("/me/messages/1")).resolves.toBeUndefined();
  });
});
