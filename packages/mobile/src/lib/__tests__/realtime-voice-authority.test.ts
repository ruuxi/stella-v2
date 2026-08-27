import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const harnessPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "realtime-voice-authority.harness.ts",
);

const runHarnessScenario = async (scenario: string) => {
  const child = spawn(process.execPath, [harnessPath, scenario], {
    cwd: dirname(harnessPath),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `Mobile voice authority harness failed (${scenario}):\n${stderr || stdout}`,
    );
  }
  expect(JSON.parse(stdout)).toEqual({ scenario, passed: true });
};

describe("mobile realtime voice authority", () => {
  test("routes SDP through Stella with the exact physical-attempt tuple", () =>
    runHarnessScenario("sdp-exact-tuple"));

  test("rejects a managed Stella session that omits its authority tuple", () =>
    runHarnessScenario("requires-authority"));

  test("heartbeats the exact managed tuple and adopts its renewed expiry", () =>
    runHarnessScenario("exact-heartbeat"));

  test("closes WebRTC before exact cancel ack and suppresses stale terminal events", () =>
    runHarnessScenario("cancel-close-before-ack"));

  test("replays a response after restart with the identical physical-attempt tuple", () =>
    runHarnessScenario("usage-replay-exact-tuple"));

  test("marks failed usage unresolved but still reports the terminal event", () =>
    runHarnessScenario("usage-failure-terminal"));

  test("uses conservative unresolved settlement for a response without usage", () =>
    runHarnessScenario("ambiguous-usage-terminal"));

  test("fails closed on an invalid null directive without tuple adoption", () =>
    runHarnessScenario("invalid-null"));

  test("fails closed immediately on a malformed heartbeat response", () =>
    runHarnessScenario("malformed-response"));

  test("fails closed without adopting a future cancel epoch", () =>
    runHarnessScenario("future-cancel-epoch"));

  test("closes and reports the exact tuple when offline authority expires", () =>
    runHarnessScenario("offline-expiry"));
});
