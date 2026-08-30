import { afterEach, describe, expect, test } from "bun:test";
import {
  appBuildEgress,
  egressDestinationTelemetry,
  generalAgentEgress,
} from "../src/sandbox-egress-policy.js";

const realFetch = globalThis.fetch;
const realConsoleLog = console.log;

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realConsoleLog;
});

describe("sandbox egress policy", () => {
  test("telemetry contains the destination but no URL path, query, fragment, or content", () => {
    const event = egressDestinationTelemetry(
      new Request(
        "https://Example.COM:8443/private/path?token=top-secret#fragment",
        { method: "POST", body: "private-body" },
      ),
      {
        workload: "app-build",
        phase: "sealed",
        decision: "deny",
      },
    );

    expect(event).toEqual({
      event: "sandbox_egress_destination",
      workload: "app-build",
      phase: "sealed",
      decision: "deny",
      scheme: "https",
      destinationHost: "example.com",
      destinationPort: 8443,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("fragment");
    expect(serialized).not.toContain("private-body");
  });

  test("general-agent egress stays broad and preserves the streaming request", async () => {
    const request = new Request("https://example.com/general", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    let forwarded: Request | null = null;
    globalThis.fetch = (async (value: RequestInfo | URL) => {
      forwarded = value as Request;
      return new Response("ok");
    }) as typeof fetch;

    const response = await generalAgentEgress(request);

    expect(response.status).toBe(200);
    expect(forwarded).toBe(request);
    expect(request.bodyUsed).toBe(false);
  });

  test("app builds fail closed without invoking upstream fetch", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("upstream");
    }) as typeof fetch;
    const request = new Request("https://registry.npmjs.org/package");

    const sealed = await appBuildEgress(request);

    expect(sealed.status).toBe(403);
    expect(fetchCalls).toBe(0);
  });

  test("a telemetry failure cannot fall through to public app-build egress", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("upstream");
    }) as typeof fetch;
    console.log = () => {
      throw new Error("telemetry unavailable");
    };

    const sealed = await appBuildEgress(
      new Request("https://example.com/private"),
    );
    expect(sealed.status).toBe(403);
    expect(fetchCalls).toBe(0);
  });
});
