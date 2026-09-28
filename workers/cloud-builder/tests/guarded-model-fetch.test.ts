import { describe, expect, test } from "bun:test";
import { guardedModelFetch } from "../src/guarded-model-fetch.js";

const request = (signal?: AbortSignal) =>
  new Request("https://gateway/model", {
    method: "POST",
    body: JSON.stringify({ messages: ["private memory"] }),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-capability",
    },
    signal,
  });

describe("guarded model fetch", () => {
  test("returns an early gateway refusal intact without reading the source", async () => {
    const authorize = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let sourceRead = false;
    let sourceCanceled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sourceRead = true;
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          sourceCanceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const work = guardedModelFetch({
      request: new Request("https://gateway/model", { method: "POST", body }),
      authorize: () => authorize.promise,
      fetch: async () => {
        entered.resolve();
        return new Response("suspended", { status: 403 });
      },
    });
    await entered.promise;
    authorize.resolve();
    const response = await work;
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("suspended");
    expect(sourceRead).toBe(false);
    expect(sourceCanceled).toBe(true);
  });

  test("local authorization waits before transport and forwards the original request", async () => {
    const source = new Request("https://gateway/model", {
      method: "POST",
      body: JSON.stringify({ messages: ["private memory"] }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-capability",
      },
    });
    const authorize = Promise.withResolvers<void>();
    let fetchStarted = false;
    let forwarded: Request | undefined;
    const work = guardedModelFetch({
      request: source,
      mode: "authorize-before-fetch",
      authorize: () => authorize.promise,
      fetch: async (value) => {
        fetchStarted = true;
        forwarded = value;
        return new Response(await value.arrayBuffer(), { status: 202 });
      },
    });

    await Promise.resolve();
    expect(fetchStarted).toBe(false);
    authorize.resolve();
    const response = await work;

    expect(response.status).toBe(202);
    expect(forwarded).toBe(source);
    expect(await response.json()).toEqual({ messages: ["private memory"] });
  });

  test("local authorization refusal sends zero requests and leaves the body untouched", async () => {
    const source = request();
    const refusal = new Error("MEMORY_POLICY_CHANGED");
    let calls = 0;
    await expect(
      guardedModelFetch({
        request: source,
        mode: "authorize-before-fetch",
        authorize: async () => {
          throw refusal;
        },
        fetch: async () => {
          calls++;
          return new Response("must not run");
        },
      }),
    ).rejects.toBe(refusal);

    expect(calls).toBe(0);
    expect(await source.json()).toEqual({ messages: ["private memory"] });
  });

  test("local authorization abort sends zero requests and leaves the body untouched", async () => {
    const abort = new AbortController();
    const source = request(abort.signal);
    const reason = new Error("exact turn canceled");
    let calls = 0;
    await expect(
      guardedModelFetch({
        request: source,
        mode: "authorize-before-fetch",
        authorize: async () => {
          abort.abort(reason);
        },
        fetch: async () => {
          calls++;
          return new Response("must not run");
        },
      }),
    ).rejects.toBe(reason);

    expect(calls).toBe(0);
    expect(await source.json()).toEqual({ messages: ["private memory"] });
  });

  test("does not retry a failed transport", async () => {
    const failure = new Error("gateway disconnected");
    let calls = 0;
    await expect(
      guardedModelFetch({
        request: request(),
        authorize: async () => undefined,
        fetch: async () => {
          calls++;
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});
