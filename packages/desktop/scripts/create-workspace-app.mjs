#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const scaffold = path.resolve(
  import.meta.dirname,
  "../../home-seed/skills/create-stella-app/scripts/program.ts",
);
const bunExecutable = process.env.STELLA_BUN_PATH?.trim() || "bun";
const result = spawnSync(bunExecutable, [scaffold, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(
    `Failed to launch Stella app scaffold: ${result.error.message}`,
  );
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
