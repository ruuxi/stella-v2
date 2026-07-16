import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const appPath =
  process.env.STELLA_PACKAGED_APP_PATH?.trim() ||
  path.join(
    repoRoot,
    "packages",
    "desktop",
    "release",
    process.arch === "arm64" ? "mac-arm64" : "mac",
    "Stella.app",
  );
const resourcesPath = path.join(appPath, "Contents", "Resources");
const bunPath = path.join(resourcesPath, "bin", "bun");
const smokePath = path.join(
  resourcesPath,
  "runtime",
  "worker",
  "social-sessions",
  "packaged-smoke.js",
);

for (const requiredPath of [bunPath, smokePath]) {
  if (!existsSync(requiredPath)) {
    throw new Error(
      `Packaged social-session input is missing: ${requiredPath}`,
    );
  }
}

const child = spawn(bunPath, ["run", smokePath], {
  cwd: resourcesPath,
  env: { ...process.env, FORCE_COLOR: "0" },
  stdio: "inherit",
  windowsHide: true,
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Packaged social-session smoke exited via ${signal}.`));
      return;
    }
    resolve(code ?? 1);
  });
});

if (exitCode !== 0) {
  throw new Error(`Packaged social-session smoke exited with ${exitCode}.`);
}
