import { afterEach, describe, expect, test } from "bun:test";
import {
  isBlockedTargetHostname,
  MAX_PROXY_ENVELOPE_BYTES,
  MAX_PROXY_RESPONSE_BYTES,
} from "../src/http-security";
import worker from "../src/index";
import { createEnv } from "./fixtures";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const proxyRequest = (
  body: unknown,
  origin = "http://localhost:57315",
): Request =>
  new Request(
    "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/api/apps/fetch",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    },
  );

describe("bounded Stella fetch proxy", () => {
  test("allows only the exact preflight shape from a trusted shell", async () => {
    const accepted = await worker.fetch(
      new Request(
        "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/api/apps/fetch",
        {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:57315",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        },
      ),
      createEnv(),
    );
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:57315",
    );

    const rejected = await worker.fetch(
      new Request(
        "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/api/apps/fetch",
        {
          method: "OPTIONS",
          headers: {
            origin: "https://attacker.example.com",
            "access-control-request-method": "POST",
          },
        },
      ),
      createEnv(),
    );
    expect(rejected.status).toBe(403);
    expect(rejected.headers.has("access-control-allow-origin")).toBeFalse();
  });

  test("supports the packaged renderer's serialized null origin", async () => {
    globalThis.fetch = (async () =>
      new Response("ok", {
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;
    const response = await worker.fetch(
      proxyRequest({ input: "https://api.example.com/data" }, "null"),
      createEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("x-stella-proxy")).toBe("bounded-v1");
    expect(await response.text()).toBe("ok");
  });

  test("rejects untrusted origins without contacting the upstream", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("unexpected");
    }) as typeof fetch;
    const response = await worker.fetch(
      proxyRequest(
        { input: "https://api.example.com/data" },
        "https://attacker.example.com",
      ),
      createEnv(),
    );
    expect(response.status).toBe(403);
    expect(called).toBeFalse();
  });

  test.each([
    "localhost",
    "api.internal",
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "198.18.0.1",
    "203.0.113.10",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("recognizes %s as a non-public target", (hostname) => {
    expect(isBlockedTargetHostname(hostname)).toBeTrue();
  });

  test.each([
    "http://api.example.com/data",
    "https://user:password@api.example.com/data",
    "https://127.0.0.1/private",
    "https://[::1]/private",
    "https://metadata.google.internal/computeMetadata/v1/",
  ])("blocks unsafe target %s", async (input) => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("unexpected");
    }) as typeof fetch;
    const response = await worker.fetch(proxyRequest({ input }), createEnv());
    expect(response.status).toBe(400);
    expect(called).toBeFalse();
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:57315",
    );
  });

  test("drops credential-bearing request headers", async () => {
    let observedHeaders = new Headers();
    globalThis.fetch = (async (_input, init) => {
      observedHeaders = new Headers(init?.headers);
      return new Response("ok");
    }) as typeof fetch;
    const response = await worker.fetch(
      proxyRequest({
        input: "https://api.example.com/data",
        init: {
          headers: {
            accept: "application/json",
            authorization: "Bearer secret",
            cookie: "session=secret",
            "x-api-key": "secret",
          },
        },
      }),
      createEnv(),
    );
    expect(response.status).toBe(200);
    expect(observedHeaders.get("accept")).toBe("application/json");
    expect(observedHeaders.has("authorization")).toBeFalse();
    expect(observedHeaders.has("cookie")).toBeFalse();
    expect(observedHeaders.has("x-api-key")).toBeFalse();
  });

  test("blocks redirects to a private target", async () => {
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private" },
      })) as typeof fetch;
    const response = await worker.fetch(
      proxyRequest({ input: "https://api.example.com/start" }),
      createEnv(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The upstream redirect was blocked.",
    });
  });

  test("rejects oversized request envelopes before an upstream call", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("unexpected");
    }) as typeof fetch;
    const request = new Request(
      "https://stella-v2-apps-host-dev.lolruuxi.workers.dev/api/apps/fetch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:57315",
        },
        body: "x".repeat(MAX_PROXY_ENVELOPE_BYTES + 1),
      },
    );
    const response = await worker.fetch(request, createEnv());
    expect(response.status).toBe(413);
    expect(called).toBeFalse();
  });

  test("rejects oversized upstream responses without forwarding bytes", async () => {
    globalThis.fetch = (async () =>
      new Response("too large", {
        headers: {
          "content-length": String(MAX_PROXY_RESPONSE_BYTES + 1),
        },
      })) as typeof fetch;
    const response = await worker.fetch(
      proxyRequest({ input: "https://api.example.com/data" }),
      createEnv(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The upstream response is too large.",
    });
  });

  test("cancels a chunked oversized upstream response without a content length", async () => {
    let canceled = false;
    const halfLimit = Math.floor(MAX_PROXY_RESPONSE_BYTES / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(halfLimit));
        controller.enqueue(
          new Uint8Array(MAX_PROXY_RESPONSE_BYTES - halfLimit),
        );
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        canceled = true;
      },
    });
    const upstream = new Response(stream, {
      headers: { "content-type": "application/octet-stream" },
    });
    expect(upstream.headers.has("content-length")).toBeFalse();
    globalThis.fetch = (async () => upstream) as typeof fetch;

    const response = await worker.fetch(
      proxyRequest({ input: "https://api.example.com/chunked" }),
      createEnv(),
    );

    expect(response.status).toBe(502);
    expect(canceled).toBeTrue();
    expect(response.headers.get("x-stella-proxy")).toBeNull();
    expect(await response.json()).toEqual({
      error: "The upstream response is too large.",
    });
  });
});
