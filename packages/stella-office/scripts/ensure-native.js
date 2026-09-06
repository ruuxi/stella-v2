#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { getBundledBinaryPath } from "./shared.js";

if (process.env.STELLA_SKIP_OFFICE_HYDRATE === "1") {
  process.exit(0);
}

const args = new Set(process.argv.slice(2));
const bestEffort = args.has("--best-effort");
const downloadScript = path.join(import.meta.dirname, "download-native.js");
const result = spawnSync(
  process.execPath,
  [downloadScript, ...(bestEffort ? ["--best-effort"] : [])],
  { encoding: "utf8", stdio: "inherit" },
);

if (result.status === 0 && existsSync(getBundledBinaryPath())) {
  process.exit(0);
}

if (bestEffort) {
  process.exit(0);
}

process.exit(result.status ?? 1);
