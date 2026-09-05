import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "../../cloud-builder/tests/helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = 24_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const requestJson = async (
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> | null }> => {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const responseBody: unknown = await response.json();
  if (
    responseBody !== null &&
    (typeof responseBody !== "object" || Array.isArray(responseBody))
  )
    throw new Error("Unexpected test response");
  return {
    status: response.status,
    body:
      responseBody === null
        ? null
        : Object.fromEntries(Object.entries(responseBody)),
  };
};

describe("owner capability ledger in real Workerd", () => {
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
        "tests/fixtures/owner-ledger.wrangler.jsonc",
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

  const restartWorkerd = async (): Promise<void> => {
    await stopWorkerd();
    await startWorkerd();
  };

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-owner-ledger-workerd-"),
    );
    await startWorkerd();
  }, 30_000);

  afterAll(async () => {
    try {
      await stopWorkerd();
    } finally {
      if (persistencePath.includes("stella-owner-ledger-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("concurrent capabilities and duplicates preserve isolated accounting through restart", async () => {
    const results = await Promise.all([
      requestJson("/reserve?jti=a"),
      requestJson("/reserve?jti=a"),
      requestJson("/reserve?jti=b"),
    ]);
    expect(results.map((x) => x.body?.kind).sort()).toEqual([
      "in_flight",
      "reserved",
      "reserved",
    ]);
    await requestJson("/settle?jti=a");
    await restartWorkerd();
    expect((await requestJson("/reserve?jti=a")).body).toEqual({
      kind: "replay",
      status: 200,
      body: "reply:a",
    });
    expect((await requestJson("/reserve?jti=b")).body?.kind).toBe("in_flight");
    expect((await requestJson("/snapshot?jti=b")).body).toMatchObject({
      spentMicroCents: 0,
      reservedMicroCents: 400,
      requests: 1,
    });
    await requestJson("/settle?jti=a");
    expect((await requestJson("/snapshot?jti=a")).body?.spentMicroCents).toBe(
      200,
    );
    expect((await requestJson("/reserve?jti=a&owner=another")).body?.kind).toBe(
      "reserved",
    );
  }, 30_000);

  test("alarm cleanup preserves unexpired capability rows and results", async () => {
    await requestJson("/reserve?owner=expiry&jti=live");
    await requestJson("/settle?owner=expiry&jti=live");
    await requestJson("/reserve?owner=expiry&jti=expired&expires=1");
    const deadline = Date.now() + 5000;
    while (
      (await requestJson("/snapshot?owner=expiry&jti=expired")).body !== null &&
      Date.now() < deadline
    ) {
      await pause(50);
    }
    expect(
      (await requestJson("/snapshot?owner=expiry&jti=expired")).body,
    ).toBeNull();
    expect((await requestJson("/replay?owner=expiry&jti=live")).body).toEqual({
      status: 200,
      body: "reply:live",
    });
    await restartWorkerd();
    expect(
      (await requestJson("/reserve?owner=expiry&jti=new")).body?.kind,
    ).toBe("reserved");
  }, 30_000);
});
