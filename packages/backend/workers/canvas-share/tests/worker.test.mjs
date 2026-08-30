import { describe, expect, test } from "bun:test";

import worker from "../src/index.ts";

const request = (pathname, init) =>
  new Request(`https://stellashare.example${pathname}`, init);

const context = () => {
  const pending = [];
  return {
    ctx: {
      waitUntil(promise) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
    pending,
  };
};

const environment = ({ object = null, disabled = "" } = {}) => {
  const reads = [];
  const deletes = [];
  return {
    env: {
      SHARES_DISABLED: disabled,
      SHARES_BUCKET: {
        async get(key) {
          reads.push(key);
          return object;
        },
        async delete(key) {
          deletes.push(key);
        },
      },
    },
    reads,
    deletes,
  };
};

describe("canvas-share Worker", () => {
  test("returns the normal 404 boundary for malformed percent-encoding", async () => {
    const { env, reads } = environment();
    const { ctx } = context();

    const response = await worker.fetch(
      request("/c/%E0%A4%A"),
      env,
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(reads).toEqual([]);
  });

  test("streams a valid share with the sandbox boundary intact", async () => {
    const slug = "abcdefghijklmnopqrstuv";
    const html = "<!doctype html><script>document.body.textContent='ok'</script>";
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    });
    const { env, reads } = environment({
      object: {
        body,
        customMetadata: {},
        httpEtag: '"canvas-etag"',
      },
    });
    const { ctx } = context();

    const response = await worker.fetch(request(`/c/${slug}`), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(html);
    expect(reads).toEqual([`shares/${slug}.html`]);
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-popups allow-forms allow-downloads;",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(response.headers.get("etag")).toBe('"canvas-etag"');
  });

  test("expires shares through a tracked lazy delete", async () => {
    const slug = "abcdefghijklmnopqrstuv";
    const { env, deletes } = environment({
      object: {
        body: new ReadableStream(),
        customMetadata: { "expires-at": "1" },
      },
    });
    const { ctx, pending } = context();

    const response = await worker.fetch(request(`/c/${slug}`), env, ctx);
    await Promise.all(pending);

    expect(response.status).toBe(404);
    expect(deletes).toEqual([`shares/${slug}.html`]);
  });

  test("honors the global kill-switch before touching R2", async () => {
    const { env, reads } = environment({ disabled: "true" });
    const { ctx } = context();

    const response = await worker.fetch(
      request("/c/abcdefghijklmnopqrstuv"),
      env,
      ctx,
    );

    expect(response.status).toBe(503);
    expect(reads).toEqual([]);
  });
});
