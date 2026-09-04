import { afterEach, describe, expect, test } from "bun:test";
import {
  GENERAL_AGENT_EGRESS_ALLOWED_PORTS,
  GENERAL_AGENT_EGRESS_BUDGET_BYTES,
  GENERAL_AGENT_EGRESS_REQUESTS_PER_MINUTE,
  appBuildEgress,
  createGeneralAgentEgress,
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
  test("uses the fixed per-container egress limits", () => {
    expect(GENERAL_AGENT_EGRESS_BUDGET_BYTES).toBe(500 * 1024 * 1024);
    expect(GENERAL_AGENT_EGRESS_REQUESTS_PER_MINUTE).toBe(120);
    expect(GENERAL_AGENT_EGRESS_ALLOWED_PORTS).toEqual([80, 443, 22]);
  });

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

  test("general-agent egress permits the Worker origin used for world transport", async () => {
    let forwarded = false;
    const policy = createGeneralAgentEgress({
      fetch: async () => {
        forwarded = true;
        return new Response(null, { status: 204 });
      },
    });
    const response = await policy(
      new Request(
        "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev/internal/worlds/name/export",
      ),
      undefined,
      { containerId: "world-attach" },
    );
    expect(response.status).toBe(204);
    expect(forwarded).toBe(true);
  });

  test("general-agent egress refuses destination ports outside 80, 443, and 22", async () => {
    let fetchCalls = 0;
    const policy = createGeneralAgentEgress({
      fetch: async () => {
        fetchCalls += 1;
        return new Response("ok");
      },
    });

    for (const port of GENERAL_AGENT_EGRESS_ALLOWED_PORTS) {
      const response = await policy(
        new Request(`https://example.com:${port}/allowed`),
        undefined,
        { containerId: "turn-ports" },
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    const refused = await policy(
      new Request("https://example.com:8443/refused"),
      undefined,
      { containerId: "turn-ports" },
    );
    expect(refused.status).toBe(403);
    expect(fetchCalls).toBe(3);
  });

  test("connection rate is capped per container and rolls after one minute", async () => {
    let now = 10_000;
    let fetchCalls = 0;
    const policy = createGeneralAgentEgress({
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 204 });
      },
      now: () => now,
      limits: { budgetBytes: 1_000, requestsPerMinute: 2 },
    });
    const request = () => new Request("https://example.com/rate");

    expect(
      (await policy(request(), undefined, { containerId: "world-a" })).status,
    ).toBe(204);
    expect(
      (await policy(request(), undefined, { containerId: "world-a" })).status,
    ).toBe(204);
    expect(
      (await policy(request(), undefined, { containerId: "world-a" })).status,
    ).toBe(429);
    expect(
      (await policy(request(), undefined, { containerId: "world-b" })).status,
    ).toBe(204);

    now += 60_001;
    expect(
      (await policy(request(), undefined, { containerId: "world-a" })).status,
    ).toBe(204);
    expect(fetchCalls).toBe(4);
  });

  test("response bytes exhaust a per-container budget and emit egress_budget telemetry", async () => {
    const events: string[] = [];
    console.log = (value?: unknown) => events.push(String(value));
    const policy = createGeneralAgentEgress({
      fetch: async () => new Response("abc"),
      limits: { budgetBytes: 5, requestsPerMinute: 120 },
    });
    const request = () => new Request("https://example.com/download");

    const first = await policy(request(), undefined, {
      containerId: "world-a",
    });
    expect(await first.text()).toBe("abc");
    const second = await policy(request(), undefined, {
      containerId: "world-a",
    });
    expect(await second.text()).toBe("abc");
    const refused = await policy(request(), undefined, {
      containerId: "world-a",
    });
    expect(refused.status).toBe(403);

    const otherContainer = await policy(request(), undefined, {
      containerId: "world-b",
    });
    expect(await otherContainer.text()).toBe("abc");
    expect(
      events.some((event) => event.includes('"reason":"egress_budget"')),
    ).toBe(true);
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
