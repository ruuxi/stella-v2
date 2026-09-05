import { describe, expect, test } from "bun:test";
import { fetchManagedOwnerRelay } from "../src/managed-owner-relay-routing.js";

describe("managed owner relay routing", () => {
  test("uses the named owner object for an eligible request", async () => {
    const calls: string[] = [];
    const response = await fetchManagedOwnerRelay({
      request: new Request("https://gateway.test/v1/responses", {
        method: "POST",
        body: "prompt",
      }),
      ownerId: "issuer|owner-1",
      eligible: true,
      namespace: {
        idFromName: (name) => name,
        get: (name) => ({
          fetch: async (request) => {
            calls.push(`direct:${name}:${await request.text()}`);
            return new Response("direct");
          },
        }),
      },
      fallback: async () => new Response("fallback"),
    });

    expect(await response.text()).toBe("direct");
    expect(calls).toEqual(["direct:issuer|owner-1:prompt"]);
  });

  test("falls back for an ineligible request or absent rolling binding", async () => {
    for (const input of [
      { eligible: false, namespace: undefined },
      { eligible: true, namespace: undefined },
    ]) {
      const response = await fetchManagedOwnerRelay({
        request: new Request("https://gateway.test/v1/responses"),
        ownerId: "issuer|owner-1",
        fallback: async () => new Response("fallback"),
        ...input,
      });
      expect(await response.text()).toBe("fallback");
    }
  });
});
