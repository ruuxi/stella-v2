import { describe, expect, test } from "bun:test";
import { fetchWithManagedCancellation } from "../src/managed-request-cancellation.js";

const setup = () => {
  const abort = new AbortController();
  const calls: unknown[] = [];
  const background: Promise<unknown>[] = [];
  return {
    abort,
    calls,
    background,
    args: {
      request: new Request("https://gateway/v2/relay", {
        headers: { "x-stella-request-id": "request-1" },
        signal: abort.signal,
      }),
      capability: "signed-turn-capability",
      control: {
        async cancelManagedRequest(value: unknown) {
          calls.push(value);
          return { canceled: true };
        },
      },
      waitUntil: (work: Promise<unknown>) => {
        background.push(work);
      },
    },
  };
};

describe("private managed cancellation", () => {
  test("sends exact cancellation when a fetch hop ignores AbortSignal", async () => {
    const h = setup();
    let release!: (value: Response) => void;
    const work = fetchWithManagedCancellation({
      ...h.args,
      fetch: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await Promise.resolve();
    h.abort.abort();
    await Promise.all(h.background);
    expect(h.calls).toEqual([
      { capability: "signed-turn-capability", requestId: "request-1" },
    ]);
    await expect(work).rejects.toBeDefined();
    release(new Response(null, { status: 204 }));
  });

  test("keeps cancellation connected after headers and until response consumption", async () => {
    const h = setup();
    const response = await fetchWithManagedCancellation({
      ...h.args,
      fetch: async () => new Response(new ReadableStream({ pull() {} })),
    });
    h.abort.abort();
    await Promise.all(h.background);
    expect(h.calls).toHaveLength(1);
    await expect(response.text()).rejects.toBeDefined();
  });

  test("aborts a response read already waiting on a non-propagating hop", async () => {
    const h = setup();
    const response = await fetchWithManagedCancellation({
      ...h.args,
      fetch: async () => new Response(new ReadableStream({ pull() {} })),
    });
    const read = response.text();
    h.abort.abort();
    await expect(read).rejects.toBeDefined();
    await Promise.all(h.background);
    expect(h.calls).toHaveLength(1);
  });

  test("retries a lost cancellation response without retrying inference", async () => {
    const h = setup();
    let attempts = 0,
      executions = 0;
    const response = await fetchWithManagedCancellation({
      ...h.args,
      control: {
        async cancelManagedRequest() {
          attempts++;
          if (attempts === 1) throw Error("lost response");
          return { canceled: true };
        },
      },
      fetch: async () => {
        executions++;
        return new Response("ok");
      },
    });
    await response.body!.cancel();
    await Promise.all(h.background);
    expect(attempts).toBe(2);
    expect(executions).toBe(1);
  });

  test("completed requests detach from subsequent turn cancellation", async () => {
    const h = setup();
    const response = await fetchWithManagedCancellation({
      ...h.args,
      fetch: async () => new Response("complete"),
    });
    expect(await response.text()).toBe("complete");
    h.abort.abort();
    expect(h.calls).toHaveLength(0);
  });
});
