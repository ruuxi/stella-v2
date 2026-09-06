import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = randomInt(22_000, 23_000);
const origin = `http://127.0.0.1:${port}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const chunkedBody = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let canceled = false;
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (canceled) return;
        controller.enqueue(encoder.encode(chunk));
        await pause(1);
      }
      if (!canceled) controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
};

describe("HTTP and R2 boundaries in real Workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-http-r2-boundary-workerd-"),
    );
    const inspectorPort = await allocateWorkerdInspectorPort();
    const child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/http-r2-boundary-workerd.wrangler.jsonc",
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
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
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
        const response = await fetch(origin);
        if (response.ok) return;
      } catch {
        // Workerd is still starting.
      }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${workerdOutput}`);
  });

  afterAll(async () => {
    const child = workerd;
    workerd = null;
    try {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), pause(5_000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
      }
    } finally {
      if (persistencePath.includes("stella-http-r2-boundary-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("auth and readiness execute with the native Workerd surfaces", async () => {
    const ready = await fetch(`${origin}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ready: true,
      missing: [],
      invalid: [],
    });

    const denied = await fetch(`${origin}/auth`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${origin}/auth`, {
      headers: { authorization: "Bearer workerd-boundary-fixture-secret" },
    });
    expect(allowed.status).toBe(200);
  });

  test("rejects oversized chunked ingress with a deterministic 413", async () => {
    const response = await fetch(`${origin}/ingress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunkedBody(['{"value":"', "x".repeat(128), '"}']),
      // Bun follows the Fetch standard extension used by streaming Node bodies.
      duplex: "half",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "request_too_large" });
  });

  test("copies a multi-megabyte R2 object as a stream and bounds transforms", async () => {
    const streamed = await fetch(`${origin}/r2-stream`);
    const streamedText = await streamed.text();
    if (streamed.status !== 200) {
      throw new Error(
        `R2 stream proof returned ${streamed.status}: ${streamedText}\n${workerdOutput}`,
      );
    }
    expect(JSON.parse(streamedText)).toEqual({
      streamed: true,
      size: 5 * 1024 * 1024,
      first: 17,
      last: 29,
    });

    const transformed = await fetch(`${origin}/r2-transform-too-large`);
    expect(transformed.status).toBe(200);
    expect(await transformed.json()).toEqual({ rejected: true });
  });
});
