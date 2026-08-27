#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.bun) {
  throw new Error("Convex helper tests must be launched with Bun.");
}

const backendRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const helperTestPattern = /(?<!\.convex)\.test\.[cm]?[jt]sx?$/u;

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (entry.isFile() && helperTestPattern.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
};

const byRunner = { bun: [], vitest: [] };
for (const absolutePath of (
  await walk(path.join(backendRoot, "convex"))
).sort()) {
  const source = await readFile(absolutePath, "utf8");
  const usesNodeTest = /from\s+["']node:test["']/u.test(source);
  const usesVitest = /from\s+["']vitest["']/u.test(source);
  const relativePath = path.relative(backendRoot, absolutePath);
  if (usesNodeTest === usesVitest) {
    throw new Error(
      `${relativePath} must import exactly one of node:test or vitest so the helper-test runners stay disjoint.`,
    );
  }
  byRunner[usesNodeTest ? "bun" : "vitest"].push(relativePath);
}

if (byRunner.bun.length + byRunner.vitest.length === 0) {
  throw new Error("No Convex helper tests were discovered.");
}

const run = async (args) => {
  const child = spawn(process.execPath, args, {
    cwd: backendRoot,
    env: process.env,
    stdio: "inherit",
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Convex helper tests were terminated by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
};

let failed = false;
if (byRunner.bun.length > 0) {
  failed = (await run(["test", ...byRunner.bun])) !== 0 || failed;
}
if (byRunner.vitest.length > 0) {
  const vitest = path.join(backendRoot, "node_modules", "vitest", "vitest.mjs");
  failed =
    (await run([
      vitest,
      "run",
      "--config",
      "vitest.lib.config.mts",
      ...byRunner.vitest,
    ])) !== 0 || failed;
}

process.exitCode = failed ? 1 : 0;
