import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const scriptDir = import.meta.dirname;
const outputDir = path.resolve(scriptDir, "..", "resources", "bun", "current");

const commandPath = (command) => {
  const locator = process.platform === "win32" ? "where.exe" : "/usr/bin/which";
  try {
    const output = execFileSync(locator, [command], { encoding: "utf8" });
    return output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return null;
  }
};

const copyExecutable = ({ source, name, required }) => {
  if (!source || !existsSync(source)) {
    if (required) {
      throw new Error(`Could not locate required ${name} executable.`);
    }
    return null;
  }
  const destination = path.join(outputDir, name);
  copyFileSync(source, destination);
  if (process.platform !== "win32") {
    chmodSync(destination, 0o755);
  }
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", destination]);
  }
  return destination;
};

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const bunName = process.platform === "win32" ? "bun.exe" : "bun";
const rgName = process.platform === "win32" ? "rg.exe" : "rg";
const bunSource =
  process.env.STELLA_BUN_SOURCE?.trim() ||
  process.env.BUN_PATH?.trim() ||
  commandPath("bun");
const rgSource = process.env.STELLA_RG_SOURCE?.trim() || commandPath("rg");

const bundledBun = copyExecutable({
  source: bunSource,
  name: bunName,
  required: true,
});
const bundledRipgrep = copyExecutable({
  source: rgSource,
  name: rgName,
  required: true,
});

console.log(`[packaging] Bundled Bun: ${bundledBun}`);
console.log(`[packaging] Bundled ripgrep: ${bundledRipgrep}`);
