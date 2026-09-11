import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";
const fetchUncompressed = async (url: string, init: RequestInit = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, "accept-encoding": "identity" },
  });
  if (url.includes("/api/count") && response.status !== 404) {
    const text = await response.clone().text();
    try {
      JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid Workerd response ${response.status}: ${text.slice(0, 800)}`,
      );
    }
  }
  return response;
};
const port = 23000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const packageRoot = new URL("..", import.meta.url);
describe("workspace apps in Workerd", () => {
  let child: ChildProcess | null = null;
  let persistence = "";
  let output = "";
  beforeAll(async () => {
    persistence = await mkdtemp(join(tmpdir(), "stella-world-workerd-"));
    child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/workspace-apps-workerd.wrangler.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        persistence,
        "--inspector-port",
        String(await allocateWorkerdInspectorPort()),
        "--show-interactive-dev-session=false",
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const observe = (chunk: unknown): void => {
      output += String(chunk);
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`wrangler exited before readiness:\n${output}`);
      try {
        if ((await fetch(`${origin}/health`)).ok) return;
      } catch {}
      await Bun.sleep(50);
    }
    throw new Error(`workerd did not become ready:\n${output}`);
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), Bun.sleep(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (persistence.includes("stella-world-workerd-"))
      await rm(persistence, { recursive: true, force: true });
  }, 30_000);

  test("publishes files, isolates owners, persists backend state and retains a good revision after a bad update", async () => {
    const put = async (path: string, text: string) => {
      const r = await fetchUncompressed(origin + "/write", {
        method: "POST",
        body: JSON.stringify({ path, text }),
      });
      expect(r.status).toBe(200);
      return r.json();
    };
    await put(
      "apps/counter/revisions/1/public/index.html",
      "<!doctype html><h1>Counter</h1>",
    );
    await put(
      "apps/counter/revisions/1/src/server.ts",
      `import {DurableObject} from 'cloudflare:workers'; export class App extends DurableObject { async fetch(req) { let count = (await this.ctx.storage.get('count')) || 0; if(req.method==='POST') await this.ctx.storage.put('count',++count); return Response.json({count}); } }`,
    );
    expect(await (await fetchUncompressed(origin + "/apps")).json()).toEqual(
      [],
    );
    await put(
      "apps/counter/stella.app.json",
      JSON.stringify({
        schemaVersion: 1,
        slug: "counter",
        name: "Counter",
        revision: "1",
      }),
    );
    expect(
      await (await fetchUncompressed(origin + "/apps")).json(),
    ).toMatchObject([{ slug: "counter", status: "ready" }]);
    expect(await (await fetchUncompressed(origin + "/")).text()).toContain(
      "<h1>Counter</h1>",
    );
    await (
      await fetchUncompressed(origin + "/api/count", {
        method: "POST",
        headers: { "accept-encoding": "identity" },
      })
    ).text();
    expect(
      await (await fetchUncompressed(origin + "/api/count")).json(),
    ).toEqual({ count: 1 });
    expect(
      await (await fetchUncompressed(origin + "/apps?owner=bob")).json(),
    ).toEqual([]);
    expect(
      (await fetchUncompressed(origin + "/api/count?owner=bob")).status,
    ).toBe(404);
    await put(
      "apps/counter/revisions/2/public/index.html",
      "<!doctype html><h1>Broken revision</h1>",
    );
    await put(
      "apps/counter/revisions/2/src/server.ts",
      "this is invalid typescript !!!",
    );
    await put(
      "apps/counter/stella.app.json",
      JSON.stringify({
        schemaVersion: 1,
        slug: "counter",
        name: "Counter",
        revision: "2",
      }),
    );
    expect(
      await (await fetchUncompressed(origin + "/apps")).json(),
    ).toMatchObject([
      { revision: "1", status: "ready", error: expect.any(String) },
    ]);
    expect(await (await fetchUncompressed(origin + "/")).text()).toContain(
      "<h1>Counter</h1>",
    );
    expect(
      await (await fetchUncompressed(origin + "/api/count")).json(),
    ).toEqual({ count: 1 });
    await put(
      "apps/counter/revisions/3/public/index.html",
      "<!doctype html><h1>Updated counter</h1>",
    );
    await put(
      "apps/counter/revisions/3/src/server.ts",
      `import {DurableObject} from 'cloudflare:workers'; export class App extends DurableObject { async fetch() { return Response.json({count: (await this.ctx.storage.get('count')) || 0}); } }`,
    );
    await put(
      "apps/counter/stella.app.json",
      JSON.stringify({
        schemaVersion: 1,
        slug: "counter",
        name: "Updated counter",
        revision: "3",
      }),
    );
    expect(
      await (await fetchUncompressed(origin + "/apps")).json(),
    ).toMatchObject([{ revision: "3", status: "ready" }]);
    expect(await (await fetchUncompressed(origin + "/")).text()).toContain(
      "Updated counter",
    );
    expect(
      await (await fetchUncompressed(origin + "/api/count")).json(),
    ).toEqual({ count: 1 });
  }, 30000);
});
