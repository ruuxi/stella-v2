import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const port = 20_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;
const packageRoot = new URL("..", import.meta.url);

describe("WorldStore in real Workerd", () => {
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
        "tests/fixtures/world-store-workerd.wrangler.jsonc",
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

  test("runs tools, manifests, diff/push, and tar export", async () => {
    expect(await (await fetch(`${origin}/health`)).text()).toBe("ok");
    expect(await (await fetch(`${origin}/entries`)).json()).toEqual({
      entries: [],
    });
    const response = await fetch(origin);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      before: "alpha\nbeta\n",
      edit: { ok: true },
      grep: { ok: true, output: expect.stringContaining("gamma") },
      firstChangeRevision: 1,
      secondChangeRevision: 2,
      idempotent: true,
      changed: ["pushed.txt"],
      missing: [expect.stringMatching(/^[0-9a-f]{64}$/u)],
      pushed: [],
      pushRevision: 3,
      after: "pushed",
      tarName: "pushed.txt",
      tarContent: "pushed",
    });
  });

  test("compacts an oversized change batch into resync", async () => {
    const response = await fetch(`${origin}/compaction`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pushed: { missingBlobs: [], revision: 1 },
      changes: {
        revision: 1,
        entries: [],
        deleted: [],
        resync: true,
      },
    });
  }, 30_000);

  test("keeps forked tools isolated and starts new workspaces empty", async () => {
    const response = await fetch(`${origin}/fork`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      write: { ok: true },
      shared: "shared",
      forked: "isolated",
      fresh: { entries: [] },
      status: {
        kind: "fork",
        changedSinceBase: 1,
        revision: 1,
      },
    });
    expect(body.isolated).toMatchObject({
      forkId: expect.stringMatching(/^fork-[0-9a-f-]{36}$/u),
      headManifestId: expect.stringMatching(/^live:/u),
    });
  });
});
