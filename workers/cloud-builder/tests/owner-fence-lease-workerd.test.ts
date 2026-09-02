import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = 20_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const requestJson = async (
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> => {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
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

const turn = (ownerId: string, turnId: string, leaseId: string) => ({
  ownerId,
  ownerGeneration: `generation:${ownerId}`,
  turnId,
  leaseId,
});

describe("owner-fence leases in real Workerd", () => {
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
        "tests/fixtures/owner-fence-lease-workerd.wrangler.jsonc",
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
      join(tmpdir(), "stella-owner-fence-lease-workerd-"),
    );
    await startWorkerd();
  }, 30_000);

  afterAll(async () => {
    try {
      await stopWorkerd();
    } finally {
      if (persistencePath.includes("stella-owner-fence-lease-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("a lost register response replays one exact lease across restart", async () => {
    const input = turn(
      "owner-lost-register",
      "turn-lost-register",
      "lease-lost-register",
    );
    const lost = await requestJson(
      "/client/lost-register/__test/simulate-lost-register",
      input,
    );
    expect(lost.status).toBe(503);
    let fence = await requestJson(
      `/owner/${encodeURIComponent(input.ownerId)}/__test/fence-snapshot`,
    );
    expect(fence.body.active).toHaveLength(1);
    expect(fence.body.active[0].leaseId).toBe(input.leaseId);

    await restartWorkerd();
    const replay = await requestJson(
      "/client/lost-register/__test/replay-register",
      input,
    );
    expect(replay.status).toBe(200);
    expect(replay.body.leaseId).toBe(input.leaseId);
    fence = await requestJson(
      `/owner/${encodeURIComponent(input.ownerId)}/__test/fence-snapshot`,
    );
    expect(fence.body.active).toHaveLength(1);
    expect(fence.body.active[0].leaseId).toBe(input.leaseId);
  }, 60_000);

  test("lost unregister response debt survives restart and clears by alarm", async () => {
    const input = turn(
      "owner-lost-unregister",
      "turn-lost-unregister",
      "lease-lost-unregister",
    );
    const lost = await requestJson(
      "/client/lost-unregister/__test/simulate-lost-unregister",
      input,
    );
    expect(lost.status).toBe(503);
    const pending = await requestJson(
      "/client/lost-unregister/__test/client-snapshot",
    );
    expect(pending.body.receipts).toHaveLength(1);
    expect(pending.body.receipts[0]).toMatchObject({
      leaseId: input.leaseId,
      phase: "unregister_pending",
    });

    await restartWorkerd();
    const cleared = await eventually(
      () => requestJson("/client/lost-unregister/__test/client-snapshot"),
      (snapshot) => snapshot.body.receipts.length === 0,
    );
    expect(cleared.body.receipts).toEqual([]);
    const fence = await requestJson(
      `/owner/${encodeURIComponent(input.ownerId)}/__test/fence-snapshot`,
    );
    expect(fence.body.active).toEqual([]);
  }, 60_000);

  test("concurrent worlds admit exactly one owner attachment", async () => {
    const ownerId = "owner-concurrent-world";
    const [first, second] = await Promise.all([
      requestJson(
        "/client/world-a/__test/register-world",
        turn(ownerId, "turn-world-a", "world-a"),
      ),
      requestJson(
        "/client/world-b/__test/register-world",
        turn(ownerId, "turn-world-b", "world-b"),
      ),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const fence = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/__test/fence-snapshot`,
    );
    expect(fence.body.active).toHaveLength(1);
    expect(fence.body.active[0].role).toBe("world");
  }, 30_000);

  test("the production owner alarm retires an expired SQL lease", async () => {
    const ownerId = "owner-expiry-alarm";
    const registered = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/owner-fence/register`,
      {
        ownerId,
        ownerGeneration: "generation-expiry",
        leaseId: "lease-expiry",
        sessionId: "session-expiry",
        turnId: "turn-expiry",
        role: "activity",
        namespace: "activity",
        expiresAt: Date.now() + 1_000,
      },
    );
    expect(registered.status).toBe(200);
    const expired = await eventually(
      () =>
        requestJson(
          `/owner/${encodeURIComponent(ownerId)}/__test/fence-snapshot`,
        ),
      (snapshot) => Object.keys(snapshot.body.fence?.active ?? {}).length === 0,
    );
    expect(expired.body.active).toEqual([]);
  }, 30_000);

  test("the gate registers a lease in the same call that serves the snapshot", async () => {
    const ownerId = "owner-snapshot-lease";
    const lease = {
      ownerId,
      leaseId: "lease-snapshot-1",
      sessionId: "session:conversation-1",
      turnId: "desktop:device-1:turn-1",
      ownerGeneration: `generation:${ownerId}`,
      namespace: "orchestrator",
      role: "orchestrator",
    };
    const combined = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/__test/snapshot-with-lease`,
      lease,
    );
    expect(combined.status).toBe(200);
    expect(combined.body.snapshot).toMatchObject({
      ownerId,
      ownerGeneration: lease.ownerGeneration,
      writable: true,
    });
    expect(combined.body.lease.status).toBe("registered");
    const generation = combined.body.lease.generation as string;
    expect(typeof generation).toBe("string");
    expect(typeof combined.body.lease.expiresAt).toBe("number");

    // It is the production fence's own lease: the fence observes it, and the
    // `assert` and `unregister` routes accept it.
    const observed = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/__test/fence-snapshot`,
    );
    expect(observed.body.fence.generation).toBe(generation);
    expect(
      observed.body.active.map((entry: { leaseId: string }) => entry.leaseId),
    ).toEqual([lease.leaseId]);
    const asserted = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/owner-fence/assert`,
      {
        ownerId,
        ownerGeneration: lease.ownerGeneration,
        generation,
        leaseId: lease.leaseId,
      },
    );
    expect(asserted.status).toBe(200);

    // A caller behind the snapshot's generation gets the snapshot and no lease.
    const stale = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/__test/snapshot-with-lease`,
      {
        ...lease,
        leaseId: "lease-snapshot-stale",
        ownerGeneration: "generation:previous",
      },
    );
    expect(stale.status).toBe(200);
    expect(stale.body.lease).toEqual({
      status: "skipped",
      reason: "generation_stale",
    });
    const afterStale = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/__test/fence-snapshot`,
    );
    expect(afterStale.body.active).toHaveLength(1);

    const unregistered = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/owner-fence/unregister`,
      {
        ownerId,
        ownerGeneration: lease.ownerGeneration,
        generation,
        leaseId: lease.leaseId,
        sessionId: lease.sessionId,
        turnId: lease.turnId,
      },
    );
    expect(unregistered.status).toBe(200);
    const released = await requestJson(
      `/owner/${encodeURIComponent(ownerId)}/__test/fence-snapshot`,
    );
    expect(released.body.active).toEqual([]);
  }, 30_000);

  test("the OwnerGate alarm preserves fence and gate deadlines in both orders", async () => {
    const register = async (
      ownerId: string,
      leaseId: string,
      expiresAt: number,
    ) => {
      const response = await requestJson(
        `/owner/${encodeURIComponent(ownerId)}/owner-fence/register`,
        {
          ownerId,
          ownerGeneration: `generation:${ownerId}`,
          leaseId,
          sessionId: `session:${ownerId}`,
          turnId: `turn:${ownerId}`,
          role: "activity",
          namespace: "activity",
          expiresAt,
        },
      );
      expect(response.status).toBe(200);
      return response;
    };
    const snapshot = (ownerId: string) =>
      requestJson(
        `/owner/${encodeURIComponent(ownerId)}/__test/fence-snapshot`,
      );

    const fenceFirstOwner = "owner-multiplex-fence-first";
    await register(
      fenceFirstOwner,
      "lease-multiplex-fence-first",
      Date.now() + 800,
    );
    await requestJson(
      `/owner/${encodeURIComponent(fenceFirstOwner)}/__test/seed-gate-alarm`,
      { dispatchId: "gate-after-fence", delayMs: 2_500 },
    );
    const fenceExpired = await eventually(
      () => snapshot(fenceFirstOwner),
      (value) => Object.keys(value.body.fence?.active ?? {}).length === 0,
    );
    expect(fenceExpired.body.gateDeadlines).toContainEqual(
      expect.objectContaining({
        dispatch_id: "gate-after-fence",
        payload_json: "{}",
      }),
    );
    expect(fenceExpired.body.alarmAt).toBeGreaterThan(Date.now());

    const gateFirstOwner = "owner-multiplex-gate-first";
    await register(
      gateFirstOwner,
      "lease-multiplex-gate-first",
      Date.now() + 2_500,
    );
    await requestJson(
      `/owner/${encodeURIComponent(gateFirstOwner)}/__test/seed-gate-alarm`,
      { dispatchId: "gate-before-fence", delayMs: 800 },
    );
    const gateExpired = await eventually(
      () => snapshot(gateFirstOwner),
      (value) =>
        value.body.gateDeadlines.some(
          (deadline: Record<string, unknown>) =>
            deadline.dispatch_id === "gate-before-fence" &&
            deadline.payload_json === null,
        ),
    );
    expect(Object.keys(gateExpired.body.fence.active)).toHaveLength(1);
    expect(gateExpired.body.alarmAt).toBeGreaterThan(Date.now());
    const bothExpired = await eventually(
      () => snapshot(gateFirstOwner),
      (value) => Object.keys(value.body.fence?.active ?? {}).length === 0,
    );
    expect(bothExpired.body.active).toEqual([]);
  }, 30_000);

  test("restart recovery clears an orphaned attach, failed destroy debt, and world slot", async () => {
    const input = {
      ...turn("owner-orphaned-attach", "turn-orphaned-attach", "world-orphan"),
      sandboxId: "sandbox-orphan-attempt-1",
    };
    const seeded = await requestJson(
      "/client/orphaned-attach/__test/seed-orphaned-attach",
      input,
    );
    expect(seeded.status).toBe(200);
    await restartWorkerd();

    const failedBoundary = await eventually(
      () => requestJson("/client/orphaned-attach/__test/client-snapshot"),
      (snapshot) => snapshot.body.failureObservations.length === 1,
    );
    const observed = failedBoundary.body.failureObservations[0];
    expect(observed.compute).toHaveLength(1);
    expect(observed.destroyDebts).toHaveLength(1);
    expect(observed.retirements).toContainEqual(
      expect.objectContaining({
        phase: "destroy_pending",
        leaseId: input.leaseId,
      }),
    );
    expect(observed.receipts).toContainEqual(
      expect.objectContaining({
        leaseId: input.leaseId,
        phase: "registering",
      }),
    );

    const cleared = await eventually(
      () => requestJson("/client/orphaned-attach/__test/client-snapshot"),
      (snapshot) =>
        snapshot.body.compute.length === 0 &&
        snapshot.body.destroyDebts.length === 0 &&
        snapshot.body.retirements.length === 0 &&
        snapshot.body.receipts.every(
          (receipt: Record<string, unknown>) =>
            receipt.leaseId !== input.leaseId,
        ) &&
        snapshot.body.sandboxes.some(
          ([key, active]: [string, boolean]) =>
            key === `__test:sandboxActive:${input.sandboxId}` && !active,
        ),
      15_000,
    );
    expect(cleared.body.compute).toEqual([]);
    const fence = await requestJson(
      `/owner/${encodeURIComponent(input.ownerId)}/__test/fence-snapshot`,
    );
    expect(
      fence.body.active.some(
        (lease: Record<string, unknown>) => lease.leaseId === input.leaseId,
      ),
    ).toBe(false);
    const successor = await requestJson(
      "/client/orphaned-successor/__test/register-world",
      turn(input.ownerId, "turn-orphaned-successor", "world-successor"),
    );
    expect(successor.status).toBe(200);
  }, 60_000);

  test("a live attached compute renews before expiry and keeps a competitor world_busy", async () => {
    const input = {
      ...turn("owner-live-renewal", "turn-live-renewal", "world-live-renewal"),
      sandboxId: "sandbox-live-renewal",
    };
    const seeded = await requestJson(
      "/client/live-renewal/__test/seed-live-renewal",
      input,
    );
    expect(seeded.status).toBe(200);
    const initialExpiresAt = seeded.body.initialExpiresAt as number;
    const renewed = await eventually(
      () => requestJson("/client/live-renewal/__test/client-snapshot"),
      (snapshot) =>
        Number(snapshot.body.compute[0]?.worldLease?.expiresAt) >
        initialExpiresAt + 60_000,
    );
    expect(renewed.body.compute[0].worldLease.phase).toBe("registered");
    await pause(Math.max(0, initialExpiresAt - Date.now() + 250));
    const competitor = await requestJson(
      "/client/live-renewal-competitor/__test/register-world",
      turn(input.ownerId, "turn-live-renewal-competitor", "world-competitor"),
    );
    expect(competitor.status).toBe(409);
    const fence = await requestJson(
      `/owner/${encodeURIComponent(input.ownerId)}/__test/fence-snapshot`,
    );
    expect(fence.body.active).toContainEqual(
      expect.objectContaining({ leaseId: input.leaseId, role: "world" }),
    );
  }, 30_000);

  test("normal teardown failure keeps the world slot until destroy-debt alarm confirmation", async () => {
    const input = {
      ...turn("owner-normal-destroy", "turn-normal-destroy", "world-normal"),
      sandboxId: "sandbox-normal-destroy",
    };
    const failed = await requestJson(
      "/client/normal-destroy/__test/simulate-normal-destroy-failure",
      input,
    );
    expect(failed.status).toBe(503);
    expect(failed.body.destroyDebts).toHaveLength(1);
    expect(failed.body.retirements).toContainEqual(
      expect.objectContaining({
        phase: "destroy_pending",
        leaseId: input.leaseId,
      }),
    );
    expect(failed.body.worldStillActive).toBe(true);

    await eventually(
      () => requestJson("/client/normal-destroy/__test/client-snapshot"),
      (snapshot) =>
        snapshot.body.destroyDebts.length === 0 &&
        snapshot.body.retirements.length === 0 &&
        snapshot.body.sandboxes.some(
          ([key, active]: [string, boolean]) =>
            key === `__test:sandboxActive:${input.sandboxId}` && !active,
        ),
    );
    const fence = await requestJson(
      `/owner/${encodeURIComponent(input.ownerId)}/__test/fence-snapshot`,
    );
    expect(
      fence.body.active.some(
        (lease: Record<string, unknown>) => lease.leaseId === input.leaseId,
      ),
    ).toBe(false);
  }, 30_000);
});
