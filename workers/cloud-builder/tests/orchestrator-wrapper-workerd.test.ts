import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = 23_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const requestJson = async (
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${origin}${path}`);
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
};

const eventually = async <T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest) && Date.now() < deadline) {
    await pause(50);
    latest = await read();
  }
  if (!accept(latest)) {
    throw new Error(`condition not reached: ${JSON.stringify(latest)}`);
  }
  return latest;
};

describe("thin OrchestratorSession wrapper in real Workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let output = "";

  const startWorkerd = async (): Promise<void> => {
    output = "";
    const inspectorPort = await allocateWorkerdInspectorPort();
    const child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/orchestrator-wrapper-workerd.wrangler.jsonc",
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
      output += String(chunk);
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`wrangler exited before readiness:\n${output}`);
      }
      try {
        if ((await fetch(`${origin}/`)).ok) return;
      } catch {
        // Still starting.
      }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${output}`);
  };

  const restartWorkerd = async (): Promise<void> => {
    await stopWorkerd();
    await startWorkerd();
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
      join(tmpdir(), "stella-orchestrator-wrapper-workerd-"),
    );
    await startWorkerd();
  }, 30_000);

  afterAll(async () => {
    try {
      await stopWorkerd();
    } finally {
      if (persistencePath.includes("stella-orchestrator-wrapper-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("forwards public RPC methods, fetch, and constructor reader registration", async () => {
    const conversationId = `wrapper-${crypto.randomUUID()}`;
    const reader = await requestJson(`/reader/${conversationId}`);
    expect(reader.status).toBe(200);
    expect(typeof reader.body.readerId).toBe("string");
    expect(String(reader.body.readerId).length).toBeGreaterThan(0);

    expect(await requestJson(`/freeze/${conversationId}`)).toEqual({
      status: 200,
      body: { frozen: true },
    });
    expect(await requestJson(`/cancel/${conversationId}`)).toEqual({
      status: 400,
      body: { canceled: false, reason: "exact_turn_identity_required" },
    });
  }, 60_000);

  test("loads the real conversation hub and registers the reader on a bound wake", async () => {
    const conversationId = `socket-${crypto.randomUUID()}`;
    const socket = new WebSocket(
      `${origin.replace("http://", "ws://")}/socket/${conversationId}`,
      "stella.v1",
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`socket did not open:\n${output}`)),
        10_000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error(`socket errored during open:\n${output}`));
        },
        { once: true },
      );
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close(1000, "done");

    await restartWorkerd();
    const reader = await requestJson(`/reader/${conversationId}`);
    expect(reader.status).toBe(200);
    await eventually(
      () => requestJson("/registrations/owner-1"),
      (response) =>
        response.status === 200 &&
        Array.isArray(response.body.registrations) &&
        response.body.registrations.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as Record<string, unknown>).conversationId ===
              conversationId &&
            (entry as Record<string, unknown>).readerId ===
              reader.body.readerId,
        ),
    );
  }, 60_000);
});
