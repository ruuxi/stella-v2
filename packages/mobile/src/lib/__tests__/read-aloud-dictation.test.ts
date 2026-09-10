import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Native-module mocks are process-wide in Bun. Keep this playback harness
// isolated from other suites' React Native and audio-session mocks.
test("read-aloud playback recovery and dictation cancellation", () => {
  const result = spawnSync(
    process.execPath,
    ["test", resolve(__dirname, "read-aloud-dictation.harness.ts")],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
}, 25_000);
