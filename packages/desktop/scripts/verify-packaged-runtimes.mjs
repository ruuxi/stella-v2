import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const requestedAppPath = valueFor("--app");
const platform = valueFor("--platform");
if (
  !requestedAppPath ||
  !platform ||
  !["darwin-arm64", "darwin-x64", "win-x64", "linux-x64"].includes(platform)
) {
  throw new Error(
    "Usage: verify-packaged-runtimes.mjs --app <Stella.app|win-unpacked|linux-unpacked> --platform <darwin-arm64|darwin-x64|win-x64|linux-x64>",
  );
}

const appPath = path.resolve(requestedAppPath);

const isWindows = platform === "win-x64";
const isLinux = platform === "linux-x64";
const resources = platform.startsWith("darwin-")
  ? path.join(appPath, "Contents", "Resources")
  : path.join(appPath, "resources");
const executable = (unixPath, windowsPath) =>
  path.join(resources, ...(isWindows ? windowsPath : unixPath));

const binaries = {
  bun: executable(["bin", "bun"], ["bin", "bun.exe"]),
  git: executable(
    ["runtimes", "git", "bin", "git"],
    ["runtimes", "git", "cmd", "git.exe"],
  ),
  node: executable(
    ["runtimes", "node", "bin", "node"],
    ["runtimes", "node", "node.exe"],
  ),
  python: executable(
    ["runtimes", "python", "bin", "python3"],
    ["runtimes", "python", "python.exe"],
  ),
  rg: executable(["bin", "rg"], ["bin", "rg.exe"]),
  uv: executable(["bin", "uv"], ["bin", "uv.exe"]),
};

const gitRoot = path.join(resources, "runtimes", "git");
const runtimePath = [
  path.join(resources, "bin"),
  path.dirname(binaries.node),
  path.dirname(binaries.python),
  ...(isWindows
    ? [
        path.join(gitRoot, "cmd"),
        path.join(gitRoot, "mingw64", "bin"),
        path.join(gitRoot, "usr", "bin"),
      ]
    : isLinux
      ? []
      : [path.join(gitRoot, "bin")]),
  process.env.PATH ?? "",
].join(path.delimiter);
const env = {
  ...process.env,
  PATH: runtimePath,
  PIP_USER: "1",
  PYTHONDONTWRITEBYTECODE: "1",

  ...(isLinux
    ? {}
    : {
        LOCAL_GIT_DIRECTORY: gitRoot,
        GIT_EXEC_PATH: isWindows
          ? path.join(gitRoot, "mingw64", "libexec", "git-core")
          : path.join(gitRoot, "libexec", "git-core"),
      }),
  ...(isWindows || isLinux
    ? {}
    : {
        GIT_CONFIG_SYSTEM: path.join(gitRoot, "etc", "gitconfig"),
        GIT_TEMPLATE_DIR: path.join(gitRoot, "share", "git-core", "templates"),
      }),
};

const run = (name, command, commandArgs, expected) => {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(
      `${name} failed: ${result.error?.message ?? output ?? result.status}`,
    );
  }
  if (expected && !expected.test(output)) {
    throw new Error(`${name} returned an unexpected result: ${output}`);
  }
  console.log(`[packaging] ${name}: ${output.split(/\r?\n/u)[0]}`);
};

const expectedArch = platform.endsWith("arm64") ? "arm64" : "x64";
run("Bun", binaries.bun, ["--version"], /^1\.4\.0\b/mu);
run(
  "Bun architecture",
  binaries.bun,
  ["-e", "console.log(process.arch)"],
  new RegExp(`^${expectedArch}$`, "mu"),
);
run("ripgrep", binaries.rg, ["--version"], /^ripgrep 15\.1\.0\b/mu);
run("uv", binaries.uv, ["--version"], /^uv 0\.11\.32\b/mu);
run("Node", binaries.node, ["--version"], /^v24\.14\.1\b/mu);
run(
  "Node architecture",
  binaries.node,
  ["-p", "process.arch"],
  new RegExp(`^${expectedArch}$`, "mu"),
);

const npmCli = path.join(
  resources,
  "runtimes",
  "node",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const windowsNpmCli = path.join(
  resources,
  "runtimes",
  "node",
  "npm-dist",
  "bin",
  "npm-cli.js",
);
run(
  "npm",
  binaries.node,
  [isWindows ? windowsNpmCli : npmCli, "--version"],
  /^11\./mu,
);
run(
  "Python",
  binaries.python,
  ["-c", "import platform, sqlite3, ssl; print(platform.machine())"],
  isWindows
    ? /^AMD64$/mu
    : platform.endsWith("arm64")
      ? /^arm64$/mu
      : /^x86_64$/mu,
);
run("pip", binaries.python, ["-m", "pip", "--version"], /^pip\b/mu);

if (isLinux) {

  if (existsSync(binaries.git)) {
    throw new Error(
      `Unexpected bundled git at ${binaries.git}; Linux builds must rely on system git.`,
    );
  }
  const gitProbe = mkdtempSync(path.join(os.tmpdir(), "stella-git-probe-"));
  try {
    run("System git", "git", ["--version"], /^git version \d/mu);
    run("System git init", "git", ["init", "--quiet", gitProbe]);
  } finally {
    rmSync(gitProbe, { recursive: true, force: true });
  }
} else {
  const gitProbe = mkdtempSync(path.join(os.tmpdir(), "stella-git-probe-"));
  try {
    run("Git", binaries.git, ["--version"], /^git version 2\.53\./mu);
    run("Git init", binaries.git, ["init", "--quiet", gitProbe]);
    run("Git worktree", binaries.git, [
      "-C",
      gitProbe,
      "status",
      "--porcelain",
    ]);
  } finally {
    rmSync(gitProbe, { recursive: true, force: true });
  }
}

console.log(`[packaging] All managed runtimes passed for ${platform}.`);
