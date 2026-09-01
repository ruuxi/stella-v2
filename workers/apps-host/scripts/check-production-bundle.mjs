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
const projectWranglerDirectory = path.join(workerRoot, ".wrangler");

const DEPLOY_TARGETS = [
  {
    label: "untrusted-dev",
    config: "wrangler.jsonc",
    env: "",
    role: "untrusted",
    deployment: "dev:outgoing-bulldog-865",
    worker: "stella-v2-apps-host-dev",
    appsOrigin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
    trustedOrigin: "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
  },
  {
    label: "trusted-dev",
    config: "wrangler.auth.jsonc",
    env: "",
    role: "trusted",
    deployment: "dev:outgoing-bulldog-865",
    worker: "stella-v2-apps-auth-dev",
    appsOrigin: "https://stella-v2-apps-host-dev.lolruuxi.workers.dev",
    trustedOrigin: "https://stella-v2-apps-auth-dev.lolruuxi.workers.dev",
  },
  {
    label: "untrusted-bn118",
    config: "wrangler.jsonc",
    env: "bn118",
    role: "untrusted",
    deployment: "preview:basic-nightingale-118",
    worker: "stella-v2-apps-host-basic-nightingale-118",
    appsOrigin:
      "https://stella-v2-apps-host-basic-nightingale-118.lolruuxi.workers.dev",
    trustedOrigin:
      "https://stella-v2-apps-auth-basic-nightingale-118.lolruuxi.workers.dev",
  },
  {
    label: "trusted-bn118",
    config: "wrangler.auth.jsonc",
    env: "bn118",
    role: "trusted",
    deployment: "preview:basic-nightingale-118",
    worker: "stella-v2-apps-auth-basic-nightingale-118",
    appsOrigin:
      "https://stella-v2-apps-host-basic-nightingale-118.lolruuxi.workers.dev",
    trustedOrigin:
      "https://stella-v2-apps-auth-basic-nightingale-118.lolruuxi.workers.dev",
  },
  {
    label: "untrusted-production",
    config: "wrangler.jsonc",
    env: "production",
    role: "untrusted",
    deployment: "prod:intent-jackal-330",
    worker: "stella-v2-apps-host-prod",
    appsOrigin: "https://stella-v2-apps-host-prod.lolruuxi.workers.dev",
    trustedOrigin: "https://stella-v2-apps-auth-prod.lolruuxi.workers.dev",
  },
  {
    label: "trusted-production",
    config: "wrangler.auth.jsonc",
    env: "production",
    role: "trusted",
    deployment: "prod:intent-jackal-330",
    worker: "stella-v2-apps-auth-prod",
    appsOrigin: "https://stella-v2-apps-host-prod.lolruuxi.workers.dev",
    trustedOrigin: "https://stella-v2-apps-auth-prod.lolruuxi.workers.dev",
  },
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
  for (const target of DEPLOY_TARGETS) {
    const configText = await readFile(
      path.join(workerRoot, target.config),
      "utf8",
    );
    const configuredEntry = configText.match(/"main"\s*:\s*"([^"]+)"/u)?.[1];
    if (configuredEntry !== "src/index.ts") {
      throw new Error(
        `${target.label} Worker entry changed unexpectedly: ${configuredEntry ?? "missing"}.`,
      );
    }
    if (RETIRED_DEPLOYMENTS.test(configText)) {
      throw new Error(
        `${target.label} config retained a retired deployment target.`,
      );
    }
    for (const expected of [
      `"name": "${target.worker}"`,
      `"STELLA_DEPLOYMENT_IDENTITY": "${target.deployment}"`,
      `"HOST_ROLE": "${target.role}"`,
      `"APPS_HOST_ORIGIN": "${target.appsOrigin}"`,
      `"TRUSTED_APPS_HOST_ORIGIN": "${target.trustedOrigin}"`,
    ]) {
      if (!configText.includes(expected)) {
        throw new Error(
          `${target.label} config is missing its explicit deploy gate: ${expected}`,
        );
      }
    }

    const targetOutputDirectory = path.join(outputDirectory, target.label);
    const output = await run(wrangler, [
      "deploy",
      "--dry-run",
      "--outdir",
      targetOutputDirectory,
      "--config",
      target.config,
      "--env",
      target.env,
      "--strict",
    ]);
    if (!output.includes("--dry-run: exiting now.")) {
      throw new Error(
        `${target.label} did not report a Wrangler dry-run exit.`,
      );
    }

    const bundlePath = path.join(targetOutputDirectory, "index.js");
    const bundle = await stat(bundlePath);
    if (!bundle.isFile() || bundle.size === 0) {
      throw new Error(`Wrangler did not emit the ${target.label} bundle.`);
    }
    const bundleText = await readFile(bundlePath, "utf8");
    if (RETIRED_DEPLOYMENTS.test(bundleText)) {
      throw new Error(
        `${target.label} bundle retained a retired deployment target.`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        entry: configuredEntry,
        config: target.config,
        environment: target.env || "default",
        role: target.role,
        worker: target.worker,
        deployment: target.deployment,
        deployed: false,
        bundleBytes: bundle.size,
      })}\n`,
    );
  }
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
