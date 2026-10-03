#!/usr/bin/env node
// Fetches the native assets a source install needs beyond `bun install`:
// the native helpers (computer use, capture), the stella-browser service and
// the office preview binary. The native launchers run this after `bun install`
// on install, after a relaunch request and after a rollback; each step skips
// work that is already done.
//
// Every asset is an optional feature, so a failed step is reported and the
// rest still run. Exits 1 when any step failed, so the launcher tries again
// on the next launch.
//
// Usage: bun packages/desktop/scripts/prepare-install.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

const steps = [
  ["native helpers", "packages/desktop/scripts/download-native-helpers.mjs"],
  [
    "stella-browser",
    "packages/desktop/scripts/ensure-stella-browser.mjs",
    "--best-effort",
  ],
  [
    "office previews",
    "packages/stella-office/scripts/ensure-native.js",
    "--best-effort",
  ],
];

// The launcher's `bun install` skips the postinstall downloads with these;
// this script is where they happen.
const env = { ...process.env };
delete env.STELLA_SKIP_BROWSER_HYDRATE;
delete env.STELLA_SKIP_OFFICE_HYDRATE;

const failed = [];
for (const [name, script, ...args] of steps) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (result.error || result.status !== 0) {
    failed.push(name);
    console.error(
      `[prepare-install] ${name} failed after ${seconds}s: ${result.error?.message ?? `exit ${result.status}`}`,
    );
  } else {
    console.log(`[prepare-install] ${name} ready (${seconds}s)`);
  }
}

if (failed.length > 0) {
  console.error(`[prepare-install] incomplete: ${failed.join(", ")}`);
  process.exit(1);
}
