import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = randomInt(20_000, 21_000);
const origin = `http://127.0.0.1:${port}`;
const tunnelMarker = "must-not-leak-preview.trycloudflare.com";

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

describe("Vite preview access in real Workerd and Durable Object storage", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";

  const startWorkerd = async (): Promise<void> => {
    workerdOutput = "";
    const inspectorPort = await allocateWorkerdInspectorPort();
    const child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/vite-preview-access-workerd.wrangler.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--local",
        "--persist-to",
        persistencePath,
        "--inspector-port",
        String(inspectorPort),
        "--show-interactive-dev-session=false",
      ],
      {
        cwd: packageRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    workerd = child;
    const observe = (chunk: unknown): void => {
      workerdOutput += String(chunk);
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`wrangler exited before readiness:\n${workerdOutput}`);
      }
      try {
        const response = await fetch(`${origin}/snapshot`);
        if (response.ok) return;
      } catch {
        // Workerd is still starting.
      }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${workerdOutput}`);
  };

  const stopWorkerd = async (): Promise<void> => {
    const child = workerd;
    workerd = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), pause(5_000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  };

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-vite-preview-workerd-"),
    );
    await startWorkerd();
  });

  afterAll(async () => {
    try {
      await stopWorkerd();
    } finally {
      if (persistencePath.includes("stella-vite-preview-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("survives an isolate restart and revokes when the active record is deleted", async () => {
    const issuedResponse = await fetch(`${origin}/issue`, { method: "POST" });
    const issuedText = await issuedResponse.text();
    expect(issuedResponse.status).toBe(200);
    expect(issuedText).not.toContain(tunnelMarker);
    const issued = JSON.parse(issuedText) as {
      capability: string;
      logFields: Record<string, unknown>;
    };
    expect(issued.capability).toMatch(
      /^pv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/,
    );
    expect(JSON.stringify(issued.logFields)).not.toContain(tunnelMarker);

    const verifyRequest = (): Promise<Response> =>
      fetch(`${origin}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: issued.capability }),
      });
    const beforeRestart = await verifyRequest();
    const beforeRestartText = await beforeRestart.text();
    expect(beforeRestartText).not.toContain(tunnelMarker);
    expect(JSON.parse(beforeRestartText)).toEqual({
      ok: true,
      targetMatched: true,
    });

    await stopWorkerd();
    await startWorkerd();
    const afterRestart = await verifyRequest();
    expect(await afterRestart.json()).toEqual({
      ok: true,
      targetMatched: true,
    });

    const revoke = await fetch(`${origin}/revoke`, { method: "DELETE" });
    expect(revoke.status).toBe(204);
    const afterRevoke = await verifyRequest();
    expect(await afterRevoke.json()).toEqual({
      ok: false,
      code: "inactive",
    });
  }, 60_000);

  test("rejects URL authority tricks inside real Workerd URL semantics", async () => {
    for (const path of [
      "/vite-preview//attacker.invalid/private",
      "/vite-preview/\\attacker.invalid/private",
      "/vite-preview/%2f%2fattacker.invalid/private",
      "/vite-preview/%5c%5cattacker.invalid/private",
    ]) {
      const response = await fetch(`${origin}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false });
    }
    const accepted = await fetch(`${origin}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/vite-preview/src/main.tsx" }),
    });
    expect(await accepted.json()).toEqual({
      ok: true,
      originMatched: true,
    });

    for (const requestPath of [
      "/resolve-path//attacker.invalid/private",
      "/resolve-path/%2f%2fattacker.invalid/private",
      "/resolve-path/%5c%5cattacker.invalid/private",
    ]) {
      const response = await fetch(`${origin}${requestPath}`);
      expect(await response.json()).toEqual({ ok: false });
    }
  });
});
