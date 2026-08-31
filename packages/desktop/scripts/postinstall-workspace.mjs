import { spawnSync } from "node:child_process";

const skipDesktopSetup =
  Boolean(process.env.VERCEL) ||
  process.env.STELLA_SKIP_DESKTOP_POSTINSTALL === "1";

if (skipDesktopSetup) {
  console.log("Skipping desktop dependency setup for this workspace install.");
  process.exit(0);
}

const steps = [
  ["packages/desktop/scripts/postinstall-dist-electron.mjs"],
  [
    "packages/desktop/scripts/ensure-stella-browser.mjs",
    "--allow-build-fallback",
    "--best-effort",
  ],
  ["packages/stella-office/scripts/ensure-native.js", "--best-effort"],
];

for (const [script, ...args] of steps) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
