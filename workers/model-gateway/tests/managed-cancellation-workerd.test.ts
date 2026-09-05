import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateWorkerdInspectorPort } from "../../cloud-builder/tests/helpers/workerd-test-port.js";

const packageRoot = new URL("..", import.meta.url);
const port = randomInt(28_000, 29_000);
const origin = `http://127.0.0.1:${port}`;
const pause = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type Report = {
  outcome: string;
  stats: {
    authenticated: boolean;
    providerStarted: boolean;
    headersReceived: boolean;
    upstreamAborted: boolean;
  };
};

describe("managed cancellation private RPC in real Workerd", () => {
  let persistencePath = "";
  let workerd: ChildProcess | null = null;
  let output = "";

  beforeAll(async () => {
    persistencePath = await mkdtemp(join(tmpdir(), "stella-managed-cancel-workerd-"));
    const inspectorPort = await allocateWorkerdInspectorPort();
    const child = spawn(process.execPath, ["x", "wrangler", "dev", "--config",
      "tests/fixtures/managed-cancellation-workerd.wrangler.jsonc", "--ip", "127.0.0.1",
      "--port", String(port), "--local", "--persist-to", persistencePath,
      "--inspector-port", String(inspectorPort), "--show-interactive-dev-session=false"],
    { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
    workerd = child;
    const observe = (chunk: unknown): void => { output += String(chunk); };
    child.stdout?.on("data", observe); child.stderr?.on("data", observe);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`wrangler exited:\n${output}`);
      try { if ((await fetch(origin)).ok) return; } catch { /* starting */ }
      await pause(50);
    }
    throw new Error(`workerd did not become ready:\n${output}`);
  }, 30_000);

  afterAll(async () => {
    const child = workerd; workerd = null;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), pause(5_000)]);
      if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    }
    if (persistencePath.includes("stella-managed-cancel-workerd-")) {
      await rm(persistencePath, { recursive: true, force: true });
    }
  }, 30_000);

  const run = async (phase: string): Promise<Report> => {
    const response = await fetch(`${origin}/${phase}`);
    if (!response.ok) throw new Error(`fixture ${response.status}: ${await response.text()}\n${output}`);
    return await response.json() as Report;
  };

  test("pre-arrival cancellation prevents provider creation", async () => {
    expect(await run("prearrival")).toEqual({
      outcome: "canceled-before-provider",
      stats: { authenticated: true, providerStarted: false, headersReceived: false, upstreamAborted: false },
    });
  });

  test("cancellation after authentication aborts the upstream", async () => {
    const report = await run("afterauth");
    expect(report.outcome).toBe("upstream-aborted");
    expect(report.stats).toMatchObject({ authenticated: true, providerStarted: true, upstreamAborted: true });
  });

  test("cancellation after headers still aborts the upstream body", async () => {
    const report = await run("postheaders");
    expect(report.outcome).toBe("upstream-aborted");
    expect(report.stats).toEqual({ authenticated: true, providerStarted: true, headersReceived: true, upstreamAborted: true });
  });
});
