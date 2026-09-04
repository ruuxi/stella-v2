#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.bun) {
  throw new Error("Runtime Bun tests must be launched with Bun.");
}

const runtimeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const testFilePattern = /\.test\.[cm]?[jt]sx?$/u;

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
};

const files = (
  await Promise.all(
    ["host", "kernel", "worker", "discovery"].map((directory) =>
      walk(path.join(runtimeRoot, directory)),
    ),
  )
)
  .flat()
  .sort()
  .map((absolutePath) => path.relative(runtimeRoot, absolutePath));

if (files.length === 0) {
  throw new Error("No scattered Runtime Bun tests were discovered.");
}

for (const file of files) {
  const source = await readFile(path.join(runtimeRoot, file), "utf8");
  if (!/from\s+["']bun:test["']/u.test(source)) {
    throw new Error(
      `${file} is outside packages/runtime/tests but does not use bun:test. ` +
        "Move Vitest files into packages/runtime/tests so the runners stay disjoint.",
    );
  }
}

const child = spawn(
  process.execPath,
  [
    "test",
    "--preload",
    path.join(runtimeRoot, "tests", "setup", "model-registry.ts"),
    ...files,
  ],
  {
    cwd: runtimeRoot,
    env: process.env,
    stdio: "inherit",
  },
);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Runtime Bun tests were terminated by ${signal}.`));
      return;
    }
    resolve(code ?? 1);
  });
});
process.exitCode = exitCode;
