import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTHORITY, TEST_KEK, uuid } from "./fixtures.js";

type RunningWorker = {
  process: ReturnType<typeof Bun.spawn>;
  output: Promise<string>;
};

const running: RunningWorker[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  for (const worker of running.splice(0)) {
    worker.process.kill();
    await worker.process.exited.catch(() => undefined);
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const freePort = (): number => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("probe") });
  const port = server.port;
  server.stop(true);
  return port;
};

const startWorker = async (
  port: number,
  persistenceRoot: string,
  envFile: string,
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
      "--env-file",
      envFile,
      "--config",
      "./tests/fixtures/browser-profile-session-workerd.wrangler.jsonc",
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
  running.push(worker);
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      await Promise.race([
        process.exited.then(() => true),
        Bun.sleep(0).then(() => false),
      ])
    ) {
      throw new Error(`Workerd exited before readiness.\n${await output}`);
    }
    try {
      await fetch(`${origin}/not-found`);
      return worker;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Workerd did not become ready.\n${await output}`);
};

const post = async (origin: string, path: string, body: unknown) => {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(`Fixture request failed with ${response.status}.`);
  }
  return value as any;
};

describe("BrowserProfileSession in real workerd", () => {
  test("persists the exact reset receipt across a real Workerd restart", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "stella-browser-gateway-workerd-"),
    );
    tempRoots.push(root);
    const persistenceRoot = join(root, "state");
    const envFile = join(root, ".dev.vars");
    await Bun.write(envFile, `BROWSER_PROFILE_KEK_V1=${TEST_KEK}\n`);
    const port = freePort();
    const origin = `http://127.0.0.1:${port}`;
    let worker = await startWorker(port, persistenceRoot, envFile);

    const resetRequest = {
      schemaVersion: 1,
      authority: {
        ownerId: AUTHORITY.ownerId,
        ownerGeneration: AUTHORITY.ownerGeneration,
      },
      requestId: uuid(700),
      profileId: "default",
    };
    const beforeRestart = await post(
      origin,
      "/internal/owners/profile/reset",
      resetRequest,
    );
    expect(beforeRestart).toEqual({
      schemaVersion: 1,
      requestId: uuid(700),
      profileId: "default",
      profileEpoch: 2,
      reset: true,
    });

    worker.process.kill();
    await worker.process.exited;
    running.splice(running.indexOf(worker), 1);
    await worker.output;
    worker = await startWorker(port, persistenceRoot, envFile);

    const afterRestart = await post(
      origin,
      "/internal/owners/profile/reset",
      resetRequest,
    );
    expect(afterRestart).toEqual(beforeRestart);
    const removedApprovalRoute = await fetch(
      `${origin}/internal/fixtures/device-code/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(removedApprovalRoute.status).toBe(404);
    const serialized = JSON.stringify({ beforeRestart, afterRestart });
    expect(serialized).not.toContain(TEST_KEK);
  }, 120_000);
});
