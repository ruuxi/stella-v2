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
  if (configuredEntry !== ".wrangler/worker-build/index.js") {
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

  const manifest = JSON.parse(
    await readFile(
      path.join(workerRoot, ".wrangler/worker-build/build-manifest.json"),
      "utf8",
    ),
  );
  const moduleNames = new Set(manifest.modules.map((module) => module.file));
  if (
    !moduleNames.has("index.js") ||
    manifest.modules.length < 2 ||
    !manifest.modules.some((module) =>
      module.imports.some((dependency) => dependency.dynamic),
    )
  ) {
    throw new Error("Worker build lost its lazy module boundaries.");
  }
  let bundleBytes = 0;
  for (const module of manifest.modules) {
    const bundle = await stat(path.join(outputDirectory, module.file));
    if (!bundle.isFile() || bundle.size !== module.bytes) {
      throw new Error(
        `Wrangler did not emit the complete Worker module: ${module.file}.`,
      );
    }
    bundleBytes += bundle.size;
    for (const dependency of module.imports) {
      if (!moduleNames.has(dependency.file))
        throw new Error(`Worker module is missing: ${dependency.file}.`);
    }
    // Source maps remain beside every chunk for upload/debugging. They are
    // build artifacts, not executable modules matched by Wrangler's rules.
    await access(
      path.join(workerRoot, ".wrangler/worker-build", `${module.file}.map`),
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      entry: configuredEntry,
      config: "wrangler.jsonc#production",
      deployed: false,
      bundleBytes,
      moduleCount: manifest.modules.length,
      eagerBytes: manifest.eagerBytes,
    })}\n`,
  );
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
