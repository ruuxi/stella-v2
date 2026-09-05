import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = 22_000 + Math.floor(Math.random() * 1_000);
const origin = `http://127.0.0.1:${port}`;

type JsonResponse = { status: number; body: Record<string, unknown> };

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const requestJson = async (
  path: string,
  body?: Record<string, unknown>,
): Promise<JsonResponse> => {
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
    body: (await response.json()) as Record<string, unknown>,
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
  if (!accept(latest))
    throw new Error(`condition not reached: ${JSON.stringify(latest)}`);
  return latest;
};

const turn = (suffix: string) => ({
  ownerId: `owner-${suffix}`,
  ownerGeneration: "owner-generation-1",
  conversationId: `conversation-${suffix}`,
  turnId: `turn-${suffix}`,
  leaseId: `lease-${suffix}`,
});

const grantFrom = (response: JsonResponse): Record<string, unknown> => {
  if (response.status !== 200) {
    throw new Error(`issue failed: ${JSON.stringify(response)}`);
  }
  const grant = response.body.grant;
  expect(grant).toBeTruthy();
  return grant as Record<string, unknown>;
};

describe("owner model grant protocol in real Workerd", () => {
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
        "tests/fixtures/owner-model-grants-workerd.wrangler.jsonc",
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
      join(tmpdir(), "stella-owner-model-grants-workerd-"),
    );
    await startWorkerd();
  }, 30_000);

  afterAll(async () => {
    try {
      await stopWorkerd();
    } finally {
      if (persistencePath.includes("stella-owner-model-grants-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("owner change freezes a reader grant without deadlocking and the old grant is unusable", async () => {
    const input = turn("normal-change");
    const grant = grantFrom(await requestJson("/issue", input));
    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: true },
    });

    expect(
      await requestJson("/change", { ...input, requestId: "change-normal" }),
    ).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: false },
    });
    const snapshot = await requestJson("/snapshot", input);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.policy).toMatchObject({
      memoryEnabled: false,
      revision: 1,
    });
  }, 60_000);

  test("lost freeze response persists pending change, denies new grants, and replay completes", async () => {
    const input = turn("lost-freeze");
    const grant = grantFrom(await requestJson("/issue", input));
    const lost = await requestJson("/change", {
      ...input,
      requestId: "change-lost",
      lostOnce: true,
    });
    expect(lost.status).toBe(503);
    expect(String(lost.body.error)).toContain("REVOKE_INCOMPLETE");

    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: false },
    });
    const denied = await requestJson("/issue", {
      ...input,
      turnId: "turn-new",
      leaseId: "lease-new",
    });
    expect(denied.status).toBe(503);
    expect(String(denied.body.error)).toContain("MEMORY_POLICY_CHANGING");

    expect(await requestJson("/retry-change", input)).toEqual({
      status: 200,
      body: { ok: true },
    });
    const snapshot = await requestJson("/snapshot", input);
    expect(snapshot.body.policy).toMatchObject({
      memoryEnabled: false,
      revision: 1,
    });
  }, 60_000);

  test("pre-arrival revocation makes a returned grant unusable before first local use", async () => {
    const input = turn("prearrival");
    const grant = grantFrom(await requestJson("/issue", input));
    expect(
      await requestJson("/change", {
        ...input,
        requestId: "change-prearrival",
      }),
    ).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: false },
    });
  }, 60_000);

  test("reader restart nonce makes an old grant unusable and stale-reader freeze ack is safe", async () => {
    const input = turn("restart");
    const grant = grantFrom(await requestJson("/issue", input));
    const beforeUse = await requestJson("/use", { ...input, grant });
    expect(beforeUse).toMatchObject({ status: 200, body: { ok: true } });
    const oldReaderId = String(beforeUse.body.readerId);

    await requestJson("/abort-reader", input).catch(() => ({
      status: 503,
      body: {},
    }));
    const restarted = await eventually(
      () => requestJson("/use", { ...input, grant }),
      (value) => value.status === 200 && value.body.readerId !== oldReaderId,
    );
    expect(restarted.body.ok).toBe(false);

    const staleAck = await requestJson("/freeze-stale-reader", {
      ...input,
      readerId: oldReaderId,
      grantId: String(grant.grantId),
    });
    expect(staleAck.status).toBe(200);
    expect(staleAck.body.currentReaderId).not.toBe(oldReaderId);
  }, 60_000);

  test("owner fence begin commits only after the grant freeze barrier revokes readers", async () => {
    const input = turn("fence");
    const grant = grantFrom(await requestJson("/issue", input));
    const begun = await requestJson("/begin-fence", input);
    expect(begun.status).toBe(200);
    expect(begun.body).toMatchObject({ status: 200 });
    expect(begun.body.fence).toMatchObject({ state: "blocked" });
    expect(await requestJson("/use", { ...input, grant })).toMatchObject({
      status: 200,
      body: { ok: false },
    });
    const snapshot = await requestJson("/snapshot", input);
    expect(snapshot.body.barrier).toBeUndefined();
  }, 60_000);
});
