import { afterEach, describe, expect, it } from "bun:test";

import { sendTelegramDeliveryTextForTest } from "../../convex/channels/connector_delivery";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Telegram delivery", () => {
  it("sends final connector replies as plain text", async () => {
    const requests: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const messageId = await sendTelegramDeliveryTextForTest(
      "token",
      "chat-1",
      "hi [from] Stella_with punctuation!",
    );

    expect(messageId).toBe("42");
    expect(requests).toEqual([
      {
        chat_id: "chat-1",
        text: "hi [from] Stella_with punctuation!",
      },
    ]);
  });

  it("throws when Telegram returns ok false in a 200 response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    await expect(
      sendTelegramDeliveryTextForTest("token", "chat-1", "hello"),
    ).rejects.toThrow("Bad Request: chat not found");
  });
});
