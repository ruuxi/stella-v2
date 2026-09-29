import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = fileURLToPath(new URL("../", import.meta.url));
const revision = "b57ba6ef8198c65499c2f92b1845cc2412dd6e8c";
const patch = fileURLToPath(new URL("emscripten-snippets.patch", import.meta.url));
const cache = path.join(workerDir, ".toolchain");
const checkout = path.join(cache, "workers-rs");
const install = path.join(cache, "tools");
const stamp = path.join(cache, "build-version");
const version = `${revision}:${createHash("sha256").update(readFileSync(patch)).digest("hex")}`;

function run(command, args, cwd = workerDir) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const executable = process.env.STELLA_WORKER_BUILD ?? path.join(install, "bin", process.platform === "win32" ? "worker-build.exe" : "worker-build");
if (!process.env.STELLA_WORKER_BUILD && (!existsSync(executable) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== version)) {
  mkdirSync(cache, { recursive: true });
  if (!existsSync(path.join(checkout, ".git"))) run("git", ["clone", "--no-checkout", "--filter=blob:none", "https://github.com/cloudflare/workers-rs.git", checkout]);
  // This checkout is build-owned and contains no user source changes.
  run("git", ["fetch", "--depth=1", "origin", revision], checkout);
  run("git", ["checkout", "--force", "--detach", revision], checkout);
  run("git", ["apply", "--check", patch], checkout);
  run("git", ["apply", patch], checkout);
  run("cargo", ["install", "--path", "worker-build", "--locked", "--root", install, "--force"], checkout);
  writeFileSync(stamp, version);
}
run(executable, ["--emscripten", "--release", "--locked"]);
