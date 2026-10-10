/**
 * Shell shims: the `node`, `git`, Python/pip and Stella CLI wrappers written
 * into the state directory and put first on every shell's PATH.
 */

import path from "path";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";

export type ShellStateOptions = {
  enableShellShims?: boolean;
  stellaBrowserBinPath?: string;
  stellaOfficeBinPath?: string;
  stellaComputerCliPath?: string;
  stellaMediaCliPath?: string;
  stellaXApiCliPath?: string;
  getStellaSiteAuth?: () => { baseUrl: string; authToken: string } | null;
  getCloudBackendAuth?: () => { baseUrl: string; authToken: string } | null;
  cliBridgeSocketPath?: string;
};

const WINDOWS_CLI_SHIMS = [
  {
    command: "stella-office",
    optionKey: "stellaOfficeBinPath",
    envVar: "STELLA_OFFICE_BIN",
  },
  {
    command: "stella-computer",
    optionKey: "stellaComputerCliPath",
    envVar: "STELLA_COMPUTER_CLI",
  },
  {
    command: "stella-media",
    optionKey: "stellaMediaCliPath",
    envVar: "STELLA_MEDIA_CLI",
  },
  {
    command: "stella-x-api",
    optionKey: "stellaXApiCliPath",
    envVar: "STELLA_X_API_CLI",
  },
] as const;

// A CLI resolved to its TypeScript source (a source tree) runs under Bun, the
// runtime's own executable; a bundled one runs under the host's Node.
const buildWindowsCliShimScript = (envVar: string): string =>
  [
    "@echo off",
    `if /I "%${envVar}:~-3%"==".ts" (`,
    `  "%STELLA_BUN_PATH%" "%${envVar}%" %*`,
    "  exit /b %ERRORLEVEL%",
    ")",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"%STELLA_NODE_BIN%" "%${envVar}%" %*`,
    "",
  ].join("\r\n");

const buildWindowsNodeShimScript = (): string =>
  [
    "@echo off",
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%STELLA_NODE_BIN%" %*',
    "",
  ].join("\r\n");

const buildWindowsPythonShimScript = (): string =>
  ["@echo off", '"%STELLA_PYTHON_BIN%" %*', ""].join("\r\n");

const buildWindowsPipShimScript = (): string =>
  ["@echo off", '"%STELLA_PYTHON_BIN%" -m pip %*', ""].join("\r\n");

const buildUnixNodeShimScript = (): string =>
  ["#!/bin/sh", 'ELECTRON_RUN_AS_NODE=1 exec "$STELLA_NODE_BIN" "$@"', ""].join(
    "\n",
  );

const buildUnixCliShimScript = (envVar: string): string =>
  [
    "#!/bin/sh",
    `case "$${envVar}" in *.ts) exec "\${STELLA_BUN_PATH:-bun}" "$${envVar}" "$@" ;; esac`,
    `ELECTRON_RUN_AS_NODE=1 exec "$STELLA_NODE_BIN" "$${envVar}" "$@"`,
    "",
  ].join("\n");

const buildUnixGitShimScript = (): string =>
  [
    "#!/bin/sh",
    'if [ -n "$STELLA_GIT_BIN" ]; then',
    '  __stella_git_bin="$STELLA_GIT_BIN"',
    "else",
    '  __stella_git_bin="$STELLA_REAL_GIT_BIN"',
    "fi",
    'if [ -z "$__stella_git_bin" ]; then',
    '  echo "git executable not found" >&2',
    "  exit 127",
    "fi",
    'if [ "$1" = "commit" ]; then',
    "  __stella_has_feature_tag=0",
    '  for __stella_arg in "$@"; do',
    '    case "$__stella_arg" in',
    '      *"[feature:"*) __stella_has_feature_tag=1 ;;',
    "    esac",
    "  done",
    '  if [ "$__stella_has_feature_tag" -eq 1 ]; then',
    '    __stella_repo_root="$("$__stella_git_bin" rev-parse --show-toplevel 2>/dev/null || true)"',
    '    if [ -n "$__stella_repo_root" ]; then',
    "      for __stella_dep_name in package.json bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock npm-shrinkwrap.json; do",
    '        __stella_dep_file="$__stella_repo_root/$__stella_dep_name"',
    '        if [ -f "$__stella_dep_file" ]; then',
    '          "$__stella_git_bin" add -- "$__stella_dep_file" >/dev/null 2>&1 || true',
    "        fi",
    "      done",
    "    fi",
    "  fi",
    "fi",
    'exec "$__stella_git_bin" "$@"',
    "",
  ].join("\n");

export const ensureNodeShim = (
  secretStateRoot: string,
  options?: ShellStateOptions,
): string | undefined => {
  const shimDir = path.join(secretStateRoot, "shell-shims");
  const shimPath = path.join(
    shimDir,
    process.platform === "win32" ? "node.cmd" : "node",
  );
  try {
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      shimPath,
      process.platform === "win32"
        ? buildWindowsNodeShimScript()
        : buildUnixNodeShimScript(),
      "utf-8",
    );
    if (process.platform === "win32" && process.env.STELLA_PYTHON_BIN?.trim()) {
      for (const command of ["python", "python3", "py"]) {
        writeFileSync(
          path.join(shimDir, `${command}.cmd`),
          buildWindowsPythonShimScript(),
          "utf-8",
        );
      }
      for (const command of ["pip", "pip3"]) {
        writeFileSync(
          path.join(shimDir, `${command}.cmd`),
          buildWindowsPipShimScript(),
          "utf-8",
        );
      }
    }
    if (process.platform !== "win32") {
      const unixShimPaths = [shimPath];
      const gitShimPath = path.join(shimDir, "git");
      writeFileSync(gitShimPath, buildUnixGitShimScript(), "utf-8");
      unixShimPaths.push(gitShimPath);
      for (const shim of WINDOWS_CLI_SHIMS) {
        const cliPath = options?.[shim.optionKey];
        if (typeof cliPath !== "string" || !existsSync(cliPath)) continue;
        const cliShimPath = path.join(shimDir, shim.command);
        writeFileSync(
          cliShimPath,
          buildUnixCliShimScript(shim.envVar),
          "utf-8",
        );
        unixShimPaths.push(cliShimPath);
      }
      for (const unixShimPath of unixShimPaths) {
        chmodSync(unixShimPath, 0o700);
      }
    }
    return shimDir;
  } catch {
    return undefined;
  }
};

export const ensureWindowsCliShims = (
  secretStateRoot: string,
  options?: ShellStateOptions,
): string | undefined => {
  const requested = WINDOWS_CLI_SHIMS.filter(
    (shim) => typeof options?.[shim.optionKey] === "string",
  );
  if (requested.length === 0) {
    return undefined;
  }

  const shimDir = path.join(secretStateRoot, "shell-shims");
  try {
    mkdirSync(shimDir, { recursive: true });
    for (const shim of requested) {
      writeFileSync(
        path.join(shimDir, `${shim.command}.cmd`),
        buildWindowsCliShimScript(shim.envVar),
        "utf-8",
      );
    }
    return shimDir;
  } catch {
    return undefined;
  }
};
