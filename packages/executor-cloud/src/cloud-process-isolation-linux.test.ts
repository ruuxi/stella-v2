import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateToolProcessLaunch } from "@stella/runtime/kernel/tools/process-isolation.js";
import {
  assertStrictLinuxProcessStatus,
  CLOUD_TOOL_PROCESS_IDENTITY,
} from "./cloud-process-isolation.js";

const realLinuxRoot =
  process.platform === "linux" && process.getuid?.() === 0
    ? test
    : test.skip;

const runStrict = async (
  command: string,
  args: string[],
  options: { cwd: string; home: string; env?: Record<string, string> },
) => {
  const launch = isolateToolProcessLaunch({
    command,
    commandArgs: args,
    identity: { ...CLOUD_TOOL_PROCESS_IDENTITY, home: options.home },
  });
  return await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: options.cwd,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: options.home,
        USER: CLOUD_TOOL_PROCESS_IDENTITY.user,
        LOGNAME: CLOUD_TOOL_PROCESS_IDENTITY.user,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
};

describe("real Linux cloud process isolation", () => {
  realLinuxRoot("applies the strict boundary to a descendant", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-process-boundary-"));
    const workspace = path.join(root, "workspace");
    try {
      await chmod(root, 0o755);
      await mkdir(workspace, { mode: 0o750 });
      await chown(
        workspace,
        CLOUD_TOOL_PROCESS_IDENTITY.uid,
        CLOUD_TOOL_PROCESS_IDENTITY.gid,
      );
      const result = await runStrict(
        "/bin/sh",
        [
          "-lc",
          "cat /proc/self/status; printf '\n--DESCENDANT--\n'; /bin/sh -c 'cat /proc/self/status'",
        ],
        { cwd: workspace, home: workspace },
      );
      expect(result.code).toBe(0);
      const [parent, descendant] = result.stdout.split("--DESCENDANT--");
      assertStrictLinuxProcessStatus(parent ?? "");
      assertStrictLinuxProcessStatus(descendant ?? "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  realLinuxRoot(
    "keeps a Tailwind @plugin descendant unprivileged and outside native state",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "stella-tailwind-boundary-"));
      const workspace = path.join(root, "workspace");
      const privateState = path.join(root, "native-state");
      const secret = path.join(privateState, "session.jsonl");
      const statusPath = path.join(workspace, "plugin-status.txt");
      const outcomePath = path.join(workspace, "plugin-outcome.txt");
      try {
        await chmod(root, 0o755);
        await mkdir(workspace, { mode: 0o750 });
        await chown(
          workspace,
          CLOUD_TOOL_PROCESS_IDENTITY.uid,
          CLOUD_TOOL_PROCESS_IDENTITY.gid,
        );
        await mkdir(privateState, { mode: 0o700 });
        await writeFile(secret, "private-resume-authority\n", { mode: 0o600 });
        await writeFile(
          path.join(workspace, "index.html"),
          '<!doctype html><div class="probe"></div><script type="module" src="/src.js"></script>',
        );
        await writeFile(path.join(workspace, "src.js"), 'import "./style.css";');
        await writeFile(
          path.join(workspace, "style.css"),
          '@import "tailwindcss";\n@plugin "./probe.cjs";\n',
        );
        await writeFile(
          path.join(workspace, "probe.cjs"),
          `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(statusPath)},fs.readFileSync("/proc/self/status","utf8"));try{fs.readFileSync(${JSON.stringify(secret)});fs.writeFileSync(${JSON.stringify(outcomePath)},"leaked")}catch{fs.writeFileSync(${JSON.stringify(outcomePath)},"denied")}module.exports=function(){};`,
        );
        const tailwindUrl = import.meta.resolve("@tailwindcss/vite");
        const viteUrl = import.meta.resolve("vite");
        await writeFile(
          path.join(workspace, "vite.config.mjs"),
          `import {defineConfig} from ${JSON.stringify(viteUrl)};import tailwind from ${JSON.stringify(tailwindUrl)};export default defineConfig({plugins:[tailwind()],build:{outDir:"dist"}});`,
        );
        const vite = existsSync("/usr/local/bin/vite")
          ? "/usr/local/bin/vite"
          : path.resolve(fileURLToPath(new URL("../../../node_modules/.bin/vite", import.meta.url)));
        const result = await runStrict(
          vite,
          ["build", "--config", path.join(workspace, "vite.config.mjs")],
          { cwd: workspace, home: workspace },
        );
        expect(result.code, result.stderr).toBe(0);
        assertStrictLinuxProcessStatus(await readFile(statusPath, "utf8"));
        expect(await readFile(outcomePath, "utf8")).toBe("denied");
        expect(await readFile(secret, "utf8")).toBe(
          "private-resume-authority\n",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
