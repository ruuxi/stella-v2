#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const wrangler = path.join(
  workerRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

const run = async (command, args) => {
  const child = spawn(command, args, {
    cwd: workerRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Wrangler was terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const combinedOutput = `${stdout}\n${stderr}`;
  if (
    /(?:ERROR:\s+failed to solve|UnknownLockfileVersion|failed to (?:build|push) container image)/iu.test(
      combinedOutput,
    )
  ) {
    throw new Error(
      "Wrangler reported a container-image build failure despite its process exit status.",
    );
  }
  if (exitCode !== 0) {
    throw new Error(`Wrangler production bundle dry-run exited ${exitCode}.`);
  }
  return combinedOutput;
};

const outputDirectory = await mkdtemp(
  path.join(os.tmpdir(), "stella-cloud-worker-bundle-"),
);

try {
  await access(wrangler);
  const configText = await readFile(
    path.join(workerRoot, "wrangler.jsonc"),
    "utf8",
  );
  const configuredEntry = configText.match(/"main"\s*:\s*"([^"]+)"/u)?.[1];
  if (configuredEntry !== "src/index.ts") {
    throw new Error(
      `Production Worker entry changed unexpectedly: ${configuredEntry ?? "missing"}.`,
    );
  }
  const output = await run(wrangler, [
    "deploy",
    "--dry-run",
    "--containers-rollout",
    "none",
    "--outdir",
    outputDirectory,
    "--config",
    "wrangler.jsonc",
    "--env",
    "production",
  ]);
  if (!output.includes("--dry-run: exiting now.")) {
    throw new Error("Wrangler did not report a dry-run exit.");
  }

  const bundlePath = path.join(outputDirectory, "index.js");
  const bundle = await stat(bundlePath);
  if (!bundle.isFile() || bundle.size === 0) {
    throw new Error("Wrangler did not emit the production Worker bundle.");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      entry: configuredEntry,
      config: "wrangler.jsonc#production",
      deployed: false,
      bundleBytes: bundle.size,
    })}\n`,
  );
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
