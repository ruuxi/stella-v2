import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createSkyClient,
  createSkyClientForCliDiagnostics,
  type AppState,
} from "../../runtime/kernel/computer-use/client.ts";
import { runComputerCommandSubprocess } from "../../runtime/kernel/computer-use/command-runner.ts";
import {
  createMacComputerUseSession,
  shutdownMacStellaComputerSession,
} from "../../runtime/kernel/computer-use/stella-computer-executor.ts";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cliPath = path.join(
  repoRoot,
  "packages/desktop/dist-electron/runtime/kernel/cli/stella-computer.js",
);
const nativeHelperPath = path.join(
  repoRoot,
  "packages/native/out/darwin/desktop_automation",
);
const nodeExecutable = process.env.STELLA_NODE_EXECUTABLE?.trim() || "node";
const calculator = "Calculator";
const calculatorBundleId = "com.apple.calculator";
const typedSessionId = `live-computer-acceptance-${process.pid}`;
const diagnosticsSessionId = `${typedSessionId}-diagnostics`;
const externalSessionId = `${typedSessionId}-external`;
const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "stella-computer-acceptance-"),
);

if (process.platform !== "darwin") {
  throw new Error("Live Computer Use acceptance requires macOS.");
}
if (!existsSync(cliPath)) {
  throw new Error(
    `Generated stella-computer CLI is missing at ${cliPath}. Run node packages/desktop/scripts/dev-electron-build.mjs --once first.`,
  );
}
if (!existsSync(nativeHelperPath)) {
  throw new Error(
    `Built desktop_automation helper is missing at ${nativeHelperPath}. Run bun run native:build first.`,
  );
}

process.env.STELLA_DATA_DIR = tempRoot;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const runCli = async (args: string[]) => {
  const result = await execFile(nodeExecutable, [cliPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

const externalSnapshot = async () =>
  await runCli([
    "--session",
    externalSessionId,
    "get-state",
    "--bundle-id",
    calculatorBundleId,
    "--screenshot-policy",
    "never",
    "--disable-diff",
    "--no-inline-screenshot",
  ]);

const externalClick = async (element: number) =>
  await runCli([
    "--session",
    externalSessionId,
    "click",
    String(element),
    "--bundle-id",
    calculatorBundleId,
    "--defer-observation",
    "--no-screenshot",
    "--no-inline-screenshot",
    "--json",
  ]);

const displayedValue = (state: AppState) => {
  const line = state.text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .split("\n")
    .find((candidate) => /^\s*8 text\s/.test(candidate));
  if (!line) {
    throw new Error(`Calculator result text was not found:\n${state.text}`);
  }
  return line.replace(/^\s*8 text\s*/, "").trim();
};

const session = createMacComputerUseSession({
  sessionId: typedSessionId,
  commandTimeoutMs: 30_000,
});
const sky = createSkyClient({ sessionId: typedSessionId, session });
const diagnosticsSky = createSkyClientForCliDiagnostics({
  sessionId: diagnosticsSessionId,
  cliPath,
  cwd: repoRoot,
  runner: async (request) =>
    await runComputerCommandSubprocess({
      ...request,
      command: nodeExecutable,
    }),
  env: process.env,
  commandTimeoutMs: 30_000,
});

const observe = async (screenshotPolicy: "always" | "never" = "never") =>
  await sky.get_app_state({
    app: calculator,
    screenshot_policy: screenshotPolicy,
    disable_diff: true,
  });

const restoreCalculator = async () => {
  for (let attempts = 0; attempts < 32; attempts += 1) {
    const state = await observe();
    if (displayedValue(state) === "0") return state;
    await sky.click({
      app: calculator,
      element_index: 9,
      state_id: state.state_id,
    });
  }
  throw new Error("Calculator did not return to zero after 32 delete actions.");
};

const report: Record<string, unknown> = {};

try {
  await execFile("open", ["-a", calculator]);
  await delay(500);
  await restoreCalculator();

  const generatedCliSnapshot = await runCli([
    "--session",
    externalSessionId,
    "get-state",
    "--bundle-id",
    calculatorBundleId,
    "--screenshot-policy",
    "always",
    "--no-inline-screenshot",
    "--disable-diff",
  ]);
  assert.match(generatedCliSnapshot.stdout, /App=com\.apple\.calculator/);
  assert.match(generatedCliSnapshot.stdout, /\[stella-attach-image\]/);
  report.generatedCliSnapshot = true;

  const fresh = await diagnosticsSky.get_app_state({
    app: calculator,
    screenshot_policy: "always",
    disable_diff: true,
  });
  assert.match(fresh.state_id, /^state_[a-f0-9]{20}$/);
  assert.match(fresh.observation_id, /^observation_[a-f0-9]{20}$/);
  assert.match(fresh.visual_state_id ?? "", /^visual_[a-f0-9]{20}$/);
  await diagnosticsSky.click({
    app: calculator,
    element_index: 21,
    state_id: fresh.state_id,
  });
  const afterFreshAction = await observe();
  assert.equal(displayedValue(afterFreshAction), "1");
  report.freshAction = {
    stateId: fresh.state_id,
    observationId: fresh.observation_id,
    visualStateId: fresh.visual_state_id,
    resultingStateId: afterFreshAction.state_id,
  };

  await externalSnapshot();
  const wait = sky.wait_for_change({
    app: calculator,
    after_state_id: afterFreshAction.state_id,
    timeout_ms: 15_000,
    screenshot_policy: "never",
  });
  await delay(300);
  await externalClick(22);
  const changed = await wait;
  assert.equal(changed.base_state_id, afterFreshAction.state_id);
  assert.equal(displayedValue(await observe()), "12");
  assert.deepEqual(changed.provenance.wait?.change_kinds, ["semantic"]);
  report.waitForChange = changed.provenance.wait;

  const stale = await observe();
  await externalSnapshot();
  await externalClick(23);
  await assert.rejects(
    sky.click({
      app: calculator,
      element_index: 17,
      state_id: stale.state_id,
    }),
    /Computer state changed after the supplied snapshot/,
  );
  const afterStale = await observe();
  assert.equal(displayedValue(afterStale), "123");
  report.staleActionZeroMutation = true;

  const batchState = await observe();
  const batchReceipts = await sky.batch([
    {
      type: "click",
      app: calculator,
      element_index: 21,
      state_id: batchState.state_id,
    },
    {
      type: "click",
      app: calculator,
      element_index: 22,
      state_id: batchState.state_id,
    },
  ]);
  assert.equal(batchReceipts.length, 2);
  const afterBatch = await observe();
  assert.equal(displayedValue(afterBatch), "12312");
  report.validSameTargetBatch = true;

  await assert.rejects(
    sky.batch([
      {
        type: "click",
        app: calculator,
        element_index: 23,
        state_id: afterBatch.state_id,
      },
      {
        type: "click",
        app: calculator,
        element_index: 17,
        state_id: "state_deliberately_stale",
      },
    ]),
    /Computer state changed after the supplied snapshot/,
  );
  const afterRejectedBatch = await observe();
  assert.equal(displayedValue(afterRejectedBatch), "12312");
  assert.equal(afterRejectedBatch.state_id, afterBatch.state_id);
  report.staleBatchZeroMutation = true;

  await restoreCalculator();
  report.restoredValue = "0";
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await restoreCalculator().catch(() => undefined);
  shutdownMacStellaComputerSession(typedSessionId);
  await Promise.allSettled(
    [diagnosticsSessionId, externalSessionId].map(async (sessionId) => {
      await runCli(["--session", sessionId, "shutdown-session", "--json"]);
    }),
  );
  await rm(tempRoot, { recursive: true, force: true });
}
