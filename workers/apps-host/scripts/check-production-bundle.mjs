#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rmdir,
  rm,
  stat,
} from "node:fs/promises";
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
const configPath = path.join(workerRoot, "wrangler.jsonc");
const projectWranglerDirectory = path.join(workerRoot, ".wrangler");

const REQUIRED_CONFIG_VALUES = [
  '"name": "stella-v2-apps-host-dev"',
  '"STELLA_DEPLOYMENT_IDENTITY": "dev:impartial-crab-34"',
  '"CONVEX_SITE_URL": "https://impartial-crab-34.convex.site"',
  '"CONVEX_CLOUD_URL": "https://impartial-crab-34.convex.cloud"',
  '"APPS_HOST_ORIGIN": "https://stella-v2-apps-host-dev.lolruuxi.workers.dev"',
  '"CLOUD_BUILDER_ORIGIN": "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev"',
];
const RETIRED_DEPLOYMENTS = /flexible-panther-999|benevolent-minnow-586/i;

const pathExists = async (candidate) => {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

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
  if (exitCode !== 0) {
    throw new Error(`Wrangler production bundle dry-run exited ${exitCode}.`);
  }
  return `${stdout}\n${stderr}`;
};

const outputDirectory = await mkdtemp(
  path.join(os.tmpdir(), "stella-apps-host-bundle-"),
);
const projectWranglerDirectoryExisted = await pathExists(
  projectWranglerDirectory,
);

try {
  await access(wrangler);
  const configText = await readFile(configPath, "utf8");
  const configuredEntry = configText.match(/"main"\s*:\s*"([^"]+)"/u)?.[1];
  if (configuredEntry !== "src/index.ts") {
    throw new Error(
      `Production Worker entry changed unexpectedly: ${configuredEntry ?? "missing"}.`,
    );
  }
  if (RETIRED_DEPLOYMENTS.test(configText)) {
    throw new Error("Apps host config retained a retired deployment target.");
  }
  for (const expected of REQUIRED_CONFIG_VALUES) {
    if (!configText.includes(expected)) {
      throw new Error(
        `Apps host config is missing its explicit dev gate: ${expected}`,
      );
    }
  }
  const output = await run(wrangler, [
    "deploy",
    "--dry-run",
    "--outdir",
    outputDirectory,
    "--config",
    "wrangler.jsonc",
  ]);
  if (!output.includes("--dry-run: exiting now.")) {
    throw new Error("Wrangler did not report a dry-run exit.");
  }

  const bundlePath = path.join(outputDirectory, "index.js");
  const bundle = await stat(bundlePath);
  if (!bundle.isFile() || bundle.size === 0) {
    throw new Error("Wrangler did not emit the Apps host bundle.");
  }
  const bundleText = await readFile(bundlePath, "utf8");
  if (RETIRED_DEPLOYMENTS.test(bundleText)) {
    throw new Error("Apps host bundle retained a retired deployment target.");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      entry: configuredEntry,
      config: "wrangler.jsonc",
      deployment: "dev:impartial-crab-34",
      deployed: false,
      bundleBytes: bundle.size,
    })}\n`,
  );
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
  if (!projectWranglerDirectoryExisted) {
    for (const generatedDirectory of [
      path.join(projectWranglerDirectory, "tmp", "email"),
      path.join(projectWranglerDirectory, "tmp"),
      projectWranglerDirectory,
    ]) {
      await rmdir(generatedDirectory).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}
