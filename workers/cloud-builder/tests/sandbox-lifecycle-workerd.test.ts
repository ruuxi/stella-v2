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

type Snapshot = {
  debts: number;
  attemptCount: number | null;
  alarmScheduled: boolean;
  completed: boolean;
};

type AbaSnapshot = Snapshot & {
  oldId: string;
  successorId: string;
  oldDestroyed: boolean;
  successorDestroyed: boolean;
};

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

describe("sandbox destroy debt in real Workerd Durable Object alarms", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let workerdOutput = "";

  const snapshot = async (): Promise<Snapshot> => {
    const response = await fetch(`${origin}/snapshot`);
    if (!response.ok) throw new Error(`snapshot failed: ${response.status}`);
    return (await response.json()) as Snapshot;
  };

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
        "tests/fixtures/sandbox-lifecycle-workerd.wrangler.jsonc",
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
        await snapshot();
        return;
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
      join(tmpdir(), "stella-sandbox-lifecycle-workerd-"),
    );
    await startWorkerd();
  });

  afterAll(async () => {
    try {
      await stopWorkerd();
    } finally {
      if (persistencePath.includes("stella-sandbox-lifecycle-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("survives restart, retries a failed destroy, and clears only after confirmation", async () => {
    const seededResponse = await fetch(`${origin}/seed`, { method: "POST" });
    expect(seededResponse.status).toBe(200);
    expect((await seededResponse.json()) as Snapshot).toEqual({
      debts: 1,
      attemptCount: 0,
      alarmScheduled: true,
      completed: false,
    });

    await stopWorkerd();
    await startWorkerd();

    let observedRetry = false;
    let final: Snapshot | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = await snapshot();
      if (current.attemptCount === 1) observedRetry = true;
      if (current.completed) {
        final = current;
        break;
      }
      await pause(50);
    }
    expect(observedRetry).toBe(true);
    expect(final).toEqual({
      debts: 0,
      attemptCount: null,
      alarmScheduled: false,
      completed: true,
    });
  }, 30_000);

  test("atomically retains both tombstone and alarm when the isolate faults after commit", async () => {
    const fault = await fetch(`${origin}/seed-committed-fault`, {
      method: "POST",
    });
    expect(fault.status).toBe(503);
    await stopWorkerd();
    await startWorkerd();
    const restored = await snapshot();
    // Workerd may deliver the restored alarm before this snapshot. Either the
    // exact debt is still alarm-owned (at attempt 0 or 1), or its confirmed
    // retry already completed. Neither outcome permits silent tombstone loss.
    expect(restored.debts === 1 || restored.completed).toBe(true);
    if (restored.debts === 1) {
      expect([0, 1]).toContain(restored.attemptCount);
      expect(restored.alarmScheduled).toBe(true);
    }

    const deadline = Date.now() + 10_000;
    let completed = false;
    while (Date.now() < deadline) {
      const current = await snapshot();
      if (current.completed) {
        completed = true;
        break;
      }
      await pause(50);
    }
    expect(completed).toBe(true);
  }, 30_000);

  test("uses the real Sandbox SDK to retire only old ABA identity, never its successor", async () => {
    const seeded = await fetch(`${origin}/seed-aba`, { method: "POST" });
    expect(seeded.status).toBe(200);
    const before = (await seeded.json()) as AbaSnapshot;
    expect(before.oldId).not.toBe(before.successorId);
    expect(before.oldDestroyed).toBe(false);
    expect(before.successorDestroyed).toBe(false);

    const deadline = Date.now() + 10_000;
    let after: AbaSnapshot | null = null;
    while (Date.now() < deadline) {
      const response = await fetch(`${origin}/aba-snapshot`);
      const current = (await response.json()) as AbaSnapshot;
      if (current.completed) {
        after = current;
        break;
      }
      await pause(50);
    }
    expect(after).not.toBeNull();
    expect(after).toMatchObject({
      debts: 0,
      completed: true,
      oldDestroyed: true,
      successorDestroyed: false,
    });
  }, 30_000);
});
