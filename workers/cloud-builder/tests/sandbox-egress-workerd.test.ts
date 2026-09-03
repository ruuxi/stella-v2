import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateWorkerdInspectorPort } from "./helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const packageRootPath = fileURLToPath(packageRoot);
const port = 23_000 + Math.floor(Math.random() * 500);
const origin = `http://127.0.0.1:${port}`;
const FIXTURE_CONTAINER_NAME_PREFIX =
  "workerd-stella-sandbox-egress-workerd-acceptance-";

const ensurePreparedSandboxImage = (): void => {
  const marker = join(packageRootPath, ".image", "package.json");
  if (existsSync(marker)) return;
  const result = spawnSync(process.execPath, ["scripts/prepare-image.mjs"], {
    cwd: packageRootPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Sandbox image prepare failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
};

const pause = async (delayMs: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const stopChild = async (child: ChildProcess | null): Promise<void> => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), pause(10_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
};

const fixtureContainerIds = async (): Promise<Set<string>> => {
  const process = Bun.spawn(
    ["docker", "ps", "-a", "--format", "{{.ID}}\t{{.Names}}"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not enumerate fixture containers: ${stderr.trim()}`);
  }
  return new Set(
    stdout
      .split("\n")
      .map((line) => line.trim().split("\t", 2))
      .filter(
        (entry) =>
          entry[0] && entry[1]?.startsWith(FIXTURE_CONTAINER_NAME_PREFIX),
      )
      .map(([id]) => id!),
  );
};

const removeFixtureContainers = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  const process = Bun.spawn(["docker", "rm", "-f", ...ids], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not remove fixture containers: ${stderr.trim()}`);
  }
};

describe("sandbox egress policy in real Workerd + Sandbox SDK containers", () => {
  let workerd: ChildProcess | null = null;
  let output = "";
  let persistencePath = "";
  let initialFixtureContainers = new Set<string>();

  beforeAll(async () => {
    ensurePreparedSandboxImage();
    initialFixtureContainers = await fixtureContainerIds();
    persistencePath = await mkdtemp(join(tmpdir(), "stella-egress-workerd-"));
    const inspectorPort = await allocateWorkerdInspectorPort();
    workerd = spawn(
      process.execPath,
      [
        "x",
        "wrangler",
        "dev",
        "--config",
        "tests/fixtures/sandbox-egress-workerd.wrangler.jsonc",
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
      { cwd: packageRootPath, stdio: ["ignore", "pipe", "pipe"] },
    );
    const observe = (chunk: unknown) => {
      output += String(chunk);
    };
    workerd.stdout?.on("data", observe);
    workerd.stderr?.on("data", observe);

    const deadline = Date.now() + 330_000;
    while (Date.now() < deadline) {
      if (workerd.exitCode !== null) {
        throw new Error(`wrangler exited before readiness:\n${output}`);
      }
      try {
        const response = await fetch(`${origin}/`);
        if (response.ok) return;
      } catch {
        // Workerd or the local container image is still starting.
      }
      await pause(100);
    }
    throw new Error(`workerd did not become ready:\n${output}`);
  }, 360_000);

  afterAll(async () => {
    try {
      await stopChild(workerd);
    } finally {
      workerd = null;
      const remainingFixtureContainers = await fixtureContainerIds();
      await removeFixtureContainers(
        [...remainingFixtureContainers].filter(
          (id) => !initialFixtureContainers.has(id),
        ),
      );
      if (persistencePath.includes("stella-egress-workerd-")) {
        await rm(persistencePath, { recursive: true, force: true });
      }
    }
  });

  test("keeps agents broad while a baked app build remains permanently sealed", async () => {
    const response = await fetch(`${origin}/proof`, { method: "POST" });
    const rawBody = await response.text();
    let body: {
      runtime: string;
      general: { success: boolean; status: string };
      appBuild: {
        executorOk: boolean;
        previewStatus: number;
        previewHasRoot: boolean;
        distIndex: boolean;
        distAssets: boolean;
        publishableFileCount: number;
        sealedHttpEgress: { success: boolean; status: string };
        sealedHttpsEgress: { success: boolean; status: string };
      };
    };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      throw new Error(
        `Workerd proof returned ${response.status}: ${rawBody.slice(0, 1_000)}\n${output}`,
      );
    }

    expect(response.status).toBe(200);
    expect(body.runtime).toBe("workerd+sandbox-sdk");
    expect(body.general).toMatchObject({ success: true, status: "200" });
    expect(body.appBuild).toMatchObject({
      executorOk: true,
      previewStatus: 200,
      previewHasRoot: true,
      distIndex: true,
      distAssets: true,
      sealedHttpEgress: { success: true, status: "403" },
      sealedHttpsEgress: { success: false, status: "000" },
    });
    expect(body.appBuild.publishableFileCount).toBeGreaterThanOrEqual(3);

    const telemetryLines = output
      .split("\n")
      .filter((line) => line.includes('"sandbox_egress_destination"'));
    expect(telemetryLines.length).toBeGreaterThanOrEqual(2);
    expect(
      telemetryLines.some(
        (line) =>
          line.includes('"workload":"agent"') &&
          line.includes('"decision":"allow"'),
      ),
    ).toBe(true);
    expect(
      telemetryLines.some(
        (line) =>
          line.includes('"workload":"app-build"') &&
          line.includes('"phase":"sealed"') &&
          line.includes('"decision":"deny"'),
      ),
    ).toBe(true);
    expect(telemetryLines.join("\n")).not.toContain(
      "never-log-this-query-value",
    );
  }, 360_000);
});
