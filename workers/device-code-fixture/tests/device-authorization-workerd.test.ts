import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RunningWorker = {
  process: ReturnType<typeof Bun.spawn>;
  output: Promise<string>;
};

type Authorization = {
  schemaVersion: 1;
  deviceCode: string;
  userCode: string;
  expiresAt: number;
};

const requestId = "00000000-0000-4000-8000-000000000218";
const consumerId = "00000000-0000-4000-8000-000000000219";
const otherConsumerId = "00000000-0000-4000-8000-000000000220";

const freePort = (): number => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port;
  server.stop(true);
  return port;
};

const post = async <T>(
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(
      `Workerd fixture request failed (${response.status}): ${JSON.stringify(value)}`,
    );
  }
  return value as T;
};

const stopWorker = async (worker: RunningWorker | undefined): Promise<void> => {
  if (worker === undefined) return;
  worker.process.kill("SIGTERM");
  await Promise.race([
    worker.process.exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (worker.process.exitCode === null) worker.process.kill("SIGKILL");
  await worker.process.exited.catch(() => undefined);
  await worker.output;
};

const startWorker = async (
  port: number,
  persistenceRoot: string,
): Promise<RunningWorker> => {
  const process = Bun.spawn(
    [
      "./node_modules/.bin/wrangler",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persistenceRoot,
      "--config",
      "./tests/fixtures/device-code-fixture-workerd.wrangler.jsonc",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: import.meta.dir.replace(/\/tests$/u, ""),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]).then((parts) => parts.join("\n").slice(-40_000));
  const worker = { process, output };
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Workerd exited before readiness.\n${await output}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return worker;
    } catch {
      // Workerd is still starting.
    }
    await Bun.sleep(50);
  }
  await stopWorker(worker);
  throw new Error(`Workerd did not become ready.\n${await output}`);
};

describe("device authorization lifecycle in real Workerd", () => {
  let persistenceRoot = "";
  let worker: RunningWorker | undefined;
  let port = 0;
  let origin = "";

  beforeAll(async () => {
    persistenceRoot = await mkdtemp(
      join(tmpdir(), "stella-device-fixture-workerd-"),
    );
    port = freePort();
    origin = `http://127.0.0.1:${port}`;
    worker = await startWorker(port, persistenceRoot);
  });

  afterAll(async () => {
    await stopWorker(worker);
    worker = undefined;
    if (persistenceRoot.includes("stella-device-fixture-workerd-")) {
      await rm(persistenceRoot, { recursive: true, force: true });
    }
  });

  test("keeps decisions, exact consume semantics, and an alarm across restart", async () => {
    const approved = await post<Authorization>(origin, "/authorize", {
      schemaVersion: 1,
      requestId,
    });
    const approvedGrant = {
      schemaVersion: 1,
      userCode: approved.userCode,
      deviceCode: approved.deviceCode,
    } as const;
    expect(await post(origin, "/status", approvedGrant)).toEqual({
      schemaVersion: 1,
      status: "authorization_pending",
    });
    expect(
      await post(origin, "/decision", {
        userCode: approved.userCode,
        decision: "approve",
      }),
    ).toEqual({ outcome: "approved" });
    expect(
      await post(origin, "/consume", { ...approvedGrant, consumerId }),
    ).toEqual({ schemaVersion: 1, outcome: "approved" });

    const denied = await post<Authorization>(origin, "/authorize", {
      schemaVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000221",
    });
    const deniedGrant = {
      schemaVersion: 1,
      userCode: denied.userCode,
      deviceCode: denied.deviceCode,
    } as const;
    expect(
      await post(origin, "/decision", {
        userCode: denied.userCode,
        decision: "deny",
      }),
    ).toEqual({ outcome: "denied" });
    expect(await post(origin, "/status", deniedGrant)).toEqual({
      schemaVersion: 1,
      status: "access_denied",
    });

    const alarmUserCode = "BCDF-2345";
    const alarmDeviceCode = "A".repeat(43);
    const expiresAt = Date.now() + 1_500;
    expect(
      await post(origin, "/direct-create", {
        userCode: alarmUserCode,
        deviceCode: alarmDeviceCode,
        expiresAt,
      }),
    ).toEqual({ created: true });
    const beforeRestart = await post<{
      alarm: number | null;
      state: { status: string } | null;
    }>(origin, "/inspect", { userCode: alarmUserCode });
    expect(beforeRestart.state?.status).toBe("pending");
    expect(beforeRestart.alarm).toBe(expiresAt);

    await stopWorker(worker);
    worker = undefined;
    worker = await startWorker(port, persistenceRoot);

    expect(
      await post(origin, "/consume", { ...approvedGrant, consumerId }),
    ).toEqual({ schemaVersion: 1, outcome: "approved" });
    expect(
      await post(origin, "/consume", {
        ...approvedGrant,
        consumerId: otherConsumerId,
      }),
    ).toEqual({ schemaVersion: 1, outcome: "already_consumed" });
    expect(await post(origin, "/status", deniedGrant)).toEqual({
      schemaVersion: 1,
      status: "access_denied",
    });

    const deadline = Date.now() + 8_000;
    let afterAlarm: {
      alarm: number | null;
      state: { status: string; cleanupAt?: number } | null;
    } | null = null;
    while (Date.now() < deadline) {
      afterAlarm = await post(origin, "/inspect", {
        userCode: alarmUserCode,
      });
      if (afterAlarm.state?.status === "expired") break;
      await Bun.sleep(50);
    }
    expect(afterAlarm?.state?.status).toBe("expired");
    expect(afterAlarm?.state?.cleanupAt).toBe(expiresAt + 5 * 60_000);
    expect(afterAlarm?.alarm).toBe(expiresAt + 5 * 60_000);
    expect(
      await post(origin, "/status", {
        schemaVersion: 1,
        userCode: alarmUserCode,
        deviceCode: alarmDeviceCode,
      }),
    ).toEqual({ schemaVersion: 1, status: "expired_token" });
  }, 120_000);
});
