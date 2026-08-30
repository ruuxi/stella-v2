import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = randomInt(21_000, 22_000);
const origin = `http://127.0.0.1:${port}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

describe("service bearer verification in real Workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";

  beforeAll(async () => {
    persistencePath = await mkdtemp(
      join(tmpdir(), "stella-service-bearer-workerd-"),
    );
    const inspectorPort = await allocateWorkerdInspectorPort();
    const child = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/service-bearer-workerd.wrangler.jsonc",
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
      if (persistencePath.includes("stella-service-bearer-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("uses Workerd's native timing-safe comparison and fails closed", async () => {
    const response = await fetch(origin);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      nativeTimingSafeEqual: true,
      matching: true,
      mismatched: false,
      malformed: false,
      probeMatching: true,
      probeLengthMismatch: false,
      probeLengthMismatchCode: "probe_not_found",
    });
  });
});
