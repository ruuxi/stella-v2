#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { rawConfig } = experimental_readRawConfig({ config: path.join(workerRoot, "wrangler.jsonc") });
const sourceEntry = path.join(workerRoot, "src/index.ts");
// Type RPC methods against their TypeScript definitions, not the generated JS.
// Derive every binding and environment from the deployment configuration so
// the checked declaration file cannot drift behind a second hand-written config.
const sourceConfig = (config) => {
  const { build, rules, base_dir, no_bundle, find_additional_modules, ...rest } = config;
  return {
    ...rest, main: sourceEntry,
    // The derived config lives below .wrangler; resolve local image paths
    // against the original config directory. Registry image names stay intact.
    ...(config.containers ? { containers: config.containers.map(container => ({
      ...container,
      image: typeof container.image === "string" && container.image.startsWith(".")
        ? path.resolve(workerRoot, container.image) : container.image,
    })) } : {}),
  };
};
const typeConfig = sourceConfig(rawConfig);
if (rawConfig.env) {
  typeConfig.env = Object.fromEntries(Object.entries(rawConfig.env).map(([name, config]) => [name, sourceConfig(config)]));
}
const configDirectory = path.join(workerRoot, ".wrangler/types");
await mkdir(configDirectory, { recursive: true });
await writeFile(path.join(configDirectory, "wrangler.json"), `${JSON.stringify(typeConfig, null, 2)}\n`);

const args = process.argv.slice(2);
if (args.some(value => value !== "--check")) throw new Error("Expected only the optional --check argument.");
const child = spawn(path.join(workerRoot, "node_modules/.bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler"), [
  "types", "worker-configuration.d.ts", "--config", ".wrangler/types/wrangler.json",
  "--include-runtime", "false", "--env=", ...args,
], { cwd: workerRoot, stdio: "inherit" });
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => signal ? reject(new Error(`Worker type generation stopped by ${signal}.`)) : resolve(code ?? 1));
});
process.exitCode = exitCode;
