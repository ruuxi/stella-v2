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

  test("connection rate is reserved before concurrent fetches and uses a rolling minute", async () => {
    let now = 10_000;
    let releaseFetches!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    let fetchCalls = 0;
    const policy = createGeneralAgentEgress({
      fetch: async () => {
        fetchCalls += 1;
        await fetchGate;
        return new Response(null, { status: 204 });
      },
      now: () => now,
      limits: { budgetBytes: 1_000, requestsPerMinute: 2 },
    });
    const request = () => new Request("https://example.com/rate");
    const context = { containerId: "world-a" };

    const first = policy(request(), undefined, context);
    const second = policy(request(), undefined, context);
    const refused = await policy(request(), undefined, context);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain(
      "worker isolate's rolling one-minute",
    );
    expect(fetchCalls).toBe(2);

    releaseFetches();
    expect((await first).status).toBe(204);
    expect((await second).status).toBe(204);
    now += 60_000;
    expect((await policy(request(), undefined, context)).status).toBe(204);
    expect(fetchCalls).toBe(3);
  });

  test("known-length refusal does not wait for never-settling cancellation", async () => {
    const cancellations: unknown[] = [];
    const policy = createGeneralAgentEgress({
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(4));
              controller.close();
            },
            cancel(reason) {
              cancellations.push(reason);
              return new Promise<void>(() => {});
            },
          }),
          { headers: { "content-length": "4" } },
        ),
      limits: { budgetBytes: 6, requestsPerMinute: 120 },
    });
    const request = () => new Request("https://example.com/known");
    const context = { containerId: "world-a" };

    const [first, second] = await Promise.all([
      policy(request(), undefined, context),
      policy(request(), undefined, context),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 403]);
    expect(cancellations).toEqual(["isolate_local_egress_budget"]);
    const allowed = first.status === 200 ? first : second;
    expect((await allowed.arrayBuffer()).byteLength).toBe(4);
  });

  test("chunked refusal errors immediately when cancellation never settles", async () => {
    const events: string[] = [];
    const cancellations: unknown[] = [];
    console.log = (value?: unknown) => events.push(String(value));
    let chunk = 0;
    let now = 20_000;
    const policy = createGeneralAgentEgress({
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(
                new TextEncoder().encode(chunk++ === 0 ? "abc" : "def"),
              );
            },
            cancel(reason) {
              cancellations.push(reason);
              return new Promise<void>(() => {});
            },
          }),
        ),
      now: () => now,
      limits: { budgetBytes: 5, requestsPerMinute: 120 },
    });
    const response = await policy(
      new Request("https://example.com/chunked"),
      undefined,
      { containerId: "world-a" },
    );
    const reader = response.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("abc");
    await expect(reader.read()).rejects.toThrow(
      "worker isolate's tracked download budget",
    );
    expect(cancellations).toEqual(["isolate_local_egress_budget"]);
    expect(
      events.some((event) => event.includes('"reason":"egress_budget"')),
    ).toBe(true);

    const refused = await policy(
      new Request("https://example.com/after-cap"),
      undefined,
      { containerId: "world-a" },
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("turn");

    now += 60 * 60_000;
    const afterRetention = await policy(
      new Request("https://example.com/after-cancel-retention"),
      undefined,
      { containerId: "world-a" },
    );
    expect(afterRetention.status).toBe(200);
  });

  test("unknown-length concurrent streams atomically share the byte cap", async () => {
    const cancellations: unknown[] = [];
    const policy = createGeneralAgentEgress({
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(3));
            },
            cancel(reason) {
              cancellations.push(reason);
            },
          }),
        ),
      limits: { budgetBytes: 5, requestsPerMinute: 120 },
    });
    const context = { containerId: "world-a" };
    const [a, b] = await Promise.all([
      policy(new Request("https://example.com/a"), undefined, context),
      policy(new Request("https://example.com/b"), undefined, context),
    ]);
    const results = await Promise.allSettled([
      a.body!.getReader().read(),
      b.body!.getReader().read(),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    // Both wrappers may pull concurrently before either consumer read. The one
    // buffered allowed chunk is readable; both upstream streams are stopped.
    expect(cancellations).toEqual([
      "isolate_local_egress_budget",
      "isolate_local_egress_budget",
    ]);
  });

  test("stream errors release known-length reservations", async () => {
    let call = 0;
    const policy = createGeneralAgentEgress({
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new Error("upstream failed"));
              },
            }),
            { headers: { "content-length": "5" } },
          );
        }
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(5));
              controller.close();
            },
          }),
          { headers: { "content-length": "5" } },
        );
      },
      limits: { budgetBytes: 5, requestsPerMinute: 120 },
    });
    const context = { containerId: "world-a" };
    const failed = await policy(
      new Request("https://example.com/fail"),
      undefined,
      context,
    );
    await expect(failed.text()).rejects.toThrow("upstream failed");

    const replacement = await policy(
      new Request("https://example.com/replacement"),
      undefined,
      context,
    );
    expect(replacement.status).toBe(200);
    expect((await replacement.arrayBuffer()).byteLength).toBe(5);
  });

  test("isolate-local byte state resets after one hour without activity", async () => {
    let now = 50_000;
    const policy = createGeneralAgentEgress({
      fetch: async () => new Response("abc"),
      now: () => now,
      limits: { budgetBytes: 3, requestsPerMinute: 120 },
    });
    const context = { containerId: "world-a" };
    const first = await policy(
      new Request("https://example.com/first"),
      undefined,
      context,
    );
    expect(await first.text()).toBe("abc");

    now += 60 * 60_000;
    const afterRetention = await policy(
      new Request("https://example.com/after-retention"),
      undefined,
      context,
    );
    expect(afterRetention.status).toBe(200);
    expect(await afterRetention.text()).toBe("abc");
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
