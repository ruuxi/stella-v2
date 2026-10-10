/**
 * Launch preparation: the shell executable and arguments for a command, the
 * environment it runs with, the working directory and credential drop a tool
 * call may use, and the diagnostics when a spawn fails.
 */

import path from "path";
import os from "os";
import { existsSync, realpathSync } from "fs";
import { toolStateEnvironment } from "@stella/contracts/cloud-tool-home";
import type { ToolContext, ToolProcessIdentity } from "../types.js";
import { purgeExpiredDeferredDeletes } from "../deferred-delete.js";
import { resolveToolFallbackCwd } from "../cwd.js";
import { getStellaComputerSessionId } from "../stella-computer-session.js";
import { stellaAgentShellEnvironment } from "../stella-agent-env.js";
import type { ShellState } from "./sessions.js";

const DEFERRED_DELETE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export const buildShellCommand = (
  command: string,
  _state: ShellState,
  _platform: NodeJS.Platform = process.platform,
  _shell?: string,
): string => command;

const resolveStellaDataDirFromState = (
  state: ShellState,
): string | undefined => {
  const stateRoot = path.resolve(state.secretStateRoot);
  if (path.basename(stateRoot) === "state") {
    return path.dirname(stateRoot);
  }
  return stateRoot;
};

export const maybeSweepDeferredDeletes = (state: ShellState) => {
  const now = Date.now();
  if (
    state.lastDeferredDeleteSweepAt > 0 &&
    now - state.lastDeferredDeleteSweepAt < DEFERRED_DELETE_SWEEP_INTERVAL_MS
  ) {
    return;
  }
  state.lastDeferredDeleteSweepAt = now;
  void purgeExpiredDeferredDeletes({
    stellaDataDir: resolveStellaDataDirFromState(state),
    now,
  }).catch(() => undefined);
};

export const resolveShellNodeBinary = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const explicit = env.STELLA_NODE_BIN?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // The detached Stella runtime itself runs under Bun. Electron's host
  // executable is passed into that worker specifically so child processes can
  // launch its bundled Node runtime with ELECTRON_RUN_AS_NODE=1.
  const hostExecutable = env.STELLA_HOST_EXECUTABLE_PATH?.trim();
  if (hostExecutable && existsSync(hostExecutable)) return hostExecutable;

  // Non-Electron embeddings commonly run the kernel under Node.
  return process.execPath;
};

export const buildShellEnv = (
  envOverrides?: Record<string, string>,
  options?: {
    secretStateRoot?: string;
    stellaBrowserBinPath?: string;
    stellaOfficeBinPath?: string;
    stellaComputerCliPath?: string;
    stellaMediaCliPath?: string;
    stellaXApiCliPath?: string;
    nodeShimDir?: string;
    windowsCliShimDir?: string;
    cliBridgeSocketPath?: string;
  },
  tty = false,
) => {
  const deterministicPipeEnv: NodeJS.ProcessEnv = tty
    ? {}
    : {
        NO_COLOR: "1",
        CLICOLOR: "0",
        FORCE_COLOR: "0",
        TERM: "dumb",
        COLORTERM: "",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_CTYPE: "C.UTF-8",
        PAGER: "cat",
        GIT_PAGER: "cat",
        GH_PAGER: "cat",
      };
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...deterministicPipeEnv,
    ...(envOverrides ?? {}),
    STELLA_NODE_BIN: resolveShellNodeBinary(
      envOverrides ? { ...process.env, ...envOverrides } : process.env,
    ),
    // Source-tree CLIs run under Bun (see the CLI shims).
    STELLA_BUN_PATH:
      process.env.STELLA_BUN_PATH?.trim() ||
      (process.versions.bun ? process.execPath : "bun"),
    STELLA_RUNTIME_WORKER_PID: String(process.pid),
    ...(options?.secretStateRoot
      ? { STELLA_DATA_DIR: options.secretStateRoot }
      : {}),
    ...(options?.stellaOfficeBinPath
      ? { STELLA_OFFICE_BIN: options.stellaOfficeBinPath }
      : {}),
    ...(options?.stellaComputerCliPath
      ? { STELLA_COMPUTER_CLI: options.stellaComputerCliPath }
      : {}),
    ...(options?.stellaMediaCliPath
      ? { STELLA_MEDIA_CLI: options.stellaMediaCliPath }
      : {}),
    ...(options?.stellaXApiCliPath
      ? { STELLA_X_API_CLI: options.stellaXApiCliPath }
      : {}),
    ...(options?.cliBridgeSocketPath
      ? { STELLA_CLI_BRIDGE_SOCK: options.cliBridgeSocketPath }
      : {}),
  };
  // Connector actions authenticate through the worker broker. Never inherit
  // legacy raw Stella bearer variables into shell or agent processes.
  delete mergedEnv.STELLA_SITE_AUTH_TOKEN;
  delete mergedEnv.STELLA_NATIVE_OAUTH_BACKEND_AUTH_TOKEN;
  delete mergedEnv.STELLA_LLM_PROXY_TOKEN;
  delete mergedEnv.STELLA_AUTH_TOKEN;

  const shellShimDirs = [options?.nodeShimDir, options?.windowsCliShimDir]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  if (shellShimDirs.length > 0) {
    const pathKey =
      Object.keys(mergedEnv).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    const existingPath =
      typeof mergedEnv[pathKey] === "string" ? mergedEnv[pathKey] : "";
    if (process.platform !== "win32" && options?.nodeShimDir) {
      const configuredGit = mergedEnv.STELLA_GIT_BIN?.trim();
      const validConfiguredGit =
        configuredGit && existsSync(configuredGit) ? configuredGit : undefined;
      const realGit =
        validConfiguredGit ??
        findOnPath("git", process.platform, mergedEnv, existsSync) ??
        "";
      if (!validConfiguredGit) delete mergedEnv.STELLA_GIT_BIN;
      if (realGit) mergedEnv.STELLA_REAL_GIT_BIN = realGit;
    }
    mergedEnv[pathKey] = [...shellShimDirs, existingPath]
      .filter(Boolean)
      .join(path.delimiter);
    if (options?.nodeShimDir) {
      mergedEnv.STELLA_NODE_SHIM_DIR = options.nodeShimDir;
    }
    if (options?.windowsCliShimDir) {
      mergedEnv.STELLA_WINDOWS_CLI_SHIM_DIR = options.windowsCliShimDir;
    }
  }

  return mergedEnv;
};

type DetectedShellKind = "zsh" | "bash" | "sh" | "powershell" | "cmd";

export type ShellDetectionOptions = {
  /** Unix login shell from the system account database. Null disables it. */
  userShell?: string | null;
  /** Test seam for platform-specific executable discovery. */
  executableExists?: (candidate: string) => boolean;
};

const resolveUserLoginShell = (): string | null => {
  try {
    return os.userInfo().shell?.trim() || null;
  } catch {
    return null;
  }
};

const shellKind = (
  shell: string,
  platform: NodeJS.Platform,
): DetectedShellKind | undefined => {
  const basename =
    platform === "win32"
      ? path.win32.basename(shell.trim()).toLowerCase()
      : path.posix.basename(shell.trim()).toLowerCase();
  switch (basename.replace(/\.exe$/u, "")) {
    case "zsh":
      return "zsh";
    case "bash":
      return "bash";
    case "sh":
      return "sh";
    case "pwsh":
    case "powershell":
      return "powershell";
    case "cmd":
      return "cmd";
    default:
      return undefined;
  }
};

const pathEnvironmentValue = (
  environment: NodeJS.ProcessEnv,
): string | undefined =>
  Object.entries(environment).find(
    ([key]) => key.toLowerCase() === "path",
  )?.[1];

const findOnPath = (
  binary: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  executableExists: (candidate: string) => boolean,
): string | undefined => {
  const pathValue = pathEnvironmentValue(environment);
  if (!pathValue) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names =
    platform === "win32" && !path.win32.extname(binary)
      ? [binary, `${binary}.exe`]
      : [binary];
  for (const directory of pathValue.split(pathApi.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
};

const resolveUnixShellKind = (
  kind: "zsh" | "bash" | "sh" | "powershell",
  preferredPath: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  executableExists: (candidate: string) => boolean,
): string | undefined => {
  if (preferredPath && executableExists(preferredPath)) return preferredPath;
  const binary = kind === "powershell" ? "pwsh" : kind;
  const fromPath = findOnPath(binary, platform, environment, executableExists);
  if (fromPath) return fromPath;
  const fallbacks =
    kind === "zsh"
      ? ["/bin/zsh"]
      : kind === "bash"
        ? ["/bin/bash", "/usr/bin/bash"]
        : kind === "sh"
          ? ["/bin/sh"]
          : ["/usr/local/bin/pwsh"];
  return fallbacks.find(executableExists);
};

export const resolveDefaultShell = (
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  detection: ShellDetectionOptions = {},
): string => {
  const executableExists = detection.executableExists ?? existsSync;
  if (platform === "win32") {
    const programFiles =
      environment.ProgramFiles?.trim() || "C:\\Program Files";
    const systemRoot = environment.SystemRoot?.trim() || "C:\\Windows";
    const pwsh =
      findOnPath("pwsh", platform, environment, executableExists) ??
      [path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe")].find(
        executableExists,
      );
    if (pwsh) return pwsh;
    const windowsPowerShell =
      findOnPath("powershell", platform, environment, executableExists) ??
      [
        path.win32.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
      ].find(executableExists);
    return windowsPowerShell ?? "cmd.exe";
  }

  const hasInjectedUserShell = Object.prototype.hasOwnProperty.call(
    detection,
    "userShell",
  );
  const userShell = hasInjectedUserShell
    ? detection.userShell?.trim() || null
    : resolveUserLoginShell();
  const userKind = userShell ? shellKind(userShell, platform) : undefined;
  if (userKind && userKind !== "cmd") {
    const resolved = resolveUnixShellKind(
      userKind,
      userShell ?? undefined,
      platform,
      environment,
      executableExists,
    );
    if (resolved) return resolved;
  }

  const fallbackKinds: Array<"zsh" | "bash"> =
    platform === "darwin" ? ["zsh", "bash"] : ["bash", "zsh"];
  for (const kind of fallbackKinds) {
    const resolved = resolveUnixShellKind(
      kind,
      undefined,
      platform,
      environment,
      executableExists,
    );
    if (resolved) return resolved;
  }
  return "/bin/sh";
};

export type ShellLaunchOptions = {
  /** Explicit executable requested by Bash. */
  shell?: string;
  /** Login-shell semantics are the default for compatibility with prior runs. */
  login?: boolean;
  /** Allocate a real Unix PTY or Windows ConPTY for this command. */
  tty?: boolean;
};

export type ResolvedShellLaunch = {
  shell: string;
  args: string[];
  /**
   * `cmd.exe` parses the raw Windows command line itself instead of using the
   * C runtime argv decoder. Letting Node quote its final command argument turns
   * embedded `"` delimiters into literal `\"` text, breaking executable paths
   * that contain spaces.
   */
  windowsVerbatimArguments?: boolean;
};

const windowsShellName = (shell: string): string =>
  path.win32.basename(shell.trim()).toLowerCase();

const isWindowsCmdShell = (shell: string): boolean =>
  ["cmd", "cmd.exe"].includes(windowsShellName(shell));

const isPowerShell = (shell: string): boolean =>
  ["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(
    windowsShellName(shell),
  );

const encodePowerShellCommand = (command: string): string =>
  Buffer.from(command, "utf16le").toString("base64");

const withPowerShellExitPropagation = (command: string): string =>
  [
    // `pwsh -EncodedCommand` otherwise normalizes some native failures to a
    // generic process status. Capture the command's own success bit and native
    // status immediately, before the epilogue itself can overwrite `$?`.
    "$global:LASTEXITCODE = 0",
    command,
    "$__stella_command_succeeded = $?",
    "$__stella_native_exit = $global:LASTEXITCODE",
    "if ($__stella_command_succeeded) { exit 0 }",
    "if ($__stella_native_exit -ne 0) { exit $__stella_native_exit }",
    "exit 1",
  ].join("\n");

export const resolveShellLaunch = (
  command: string,
  options: ShellLaunchOptions = {},
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  detection: ShellDetectionOptions = {},
): ResolvedShellLaunch | { error: string } => {
  if (platform !== "win32") {
    const requestedShell = options.shell?.trim();
    const shell =
      requestedShell || resolveDefaultShell(platform, environment, detection);
    if (!isPowerShell(shell)) {
      return {
        shell,
        args: [options.login === false ? "-c" : "-lc", command],
      };
    }
    return {
      shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        ...(options.tty ? [] : ["-NonInteractive"]),
        "-EncodedCommand",
        encodePowerShellCommand(withPowerShellExitPropagation(command)),
      ],
    };
  }

  const shell =
    options.shell?.trim() ||
    resolveDefaultShell(platform, environment, detection);
  if (isPowerShell(shell)) {
    // `-EncodedCommand` avoids routing PowerShell source through the native
    // Windows argv quoting rules at all. PowerShell requires UTF-16LE here.
    return {
      shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        ...(options.tty ? [] : ["-NonInteractive"]),
        "-EncodedCommand",
        encodePowerShellCommand(withPowerShellExitPropagation(command)),
      ],
    };
  }

  if (!isWindowsCmdShell(shell)) {
    // Git Bash and other Unix-style shells available on Windows use the same
    // command flags as their Unix counterparts, not cmd.exe's `/d /s /c`.
    return {
      shell,
      args: [options.login === false ? "-c" : "-lc", command],
    };
  }

  return {
    shell,
    // Match Node's own `shell: true` cmd.exe contract: `/s` expects the whole
    // source string to have one outer quote pair, while verbatim arguments
    // preserve every quote inside that source for cmd's parser.
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  };
};

export const resolveStateShellLaunch = (
  command: string,
  state: ShellState,
  options: ShellLaunchOptions,
): ResolvedShellLaunch | { error: string } => {
  const selectedShell =
    options.shell?.trim() || resolveDefaultShell(process.platform, process.env);
  const shellCommand = buildShellCommand(
    command,
    state,
    process.platform,
    selectedShell,
  );
  return resolveShellLaunch(shellCommand, {
    ...options,
    shell: selectedShell,
  });
};

export const describeShellSpawnFailure = (
  error: Error,
  launch: ResolvedShellLaunch,
  cwd: string,
  options: ShellLaunchOptions,
  runner = "node:child_process.spawn",
): string => {
  const requestedShell = options.shell?.trim() || "platform-default";
  const login = options.login !== false;
  return [
    "Failed to start Bash shell.",
    `runner=${runner} namespace=runtime-worker platform=${process.platform} runtime_pid=${process.pid}`,
    `executable=${JSON.stringify(launch.shell)} requested_shell=${JSON.stringify(requestedShell)} login=${login} tty=${options.tty === true}`,
    `cwd=${JSON.stringify(cwd)}`,
    `cause=${error.name}: ${error.message}`,
  ].join("\n");
};

const shouldUseStellaComputer = (command: string): boolean =>
  /\bstella-computer\b/.test(command);

const shouldUseStellaMedia = (command: string): boolean =>
  /\bstella-media\b/.test(command);

const shouldUseStellaXApi = (command: string): boolean =>
  /\bstella-x-api\b/.test(command);

const pathInside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

/** Validate the trusted host's child credential drop before any spawn. */
export const resolveToolProcessIdentity = (
  context?: ToolContext,
  platform: NodeJS.Platform = process.platform,
): ToolProcessIdentity | undefined => {
  const identity = context?.toolProcessIdentity;
  if (!identity) return undefined;
  if (platform === "win32") {
    throw new Error("Tool process identity is available only on POSIX hosts.");
  }
  if (
    !Number.isSafeInteger(identity.uid) ||
    identity.uid <= 0 ||
    identity.uid > 2_147_483_647 ||
    !Number.isSafeInteger(identity.gid) ||
    identity.gid <= 0 ||
    identity.gid > 2_147_483_647 ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(identity.user)
  ) {
    throw new Error("Tool process identity is invalid or privileged.");
  }
  const workspaceRoot = context?.toolWorkspaceRoot?.trim();
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    throw new Error(
      "Tool process identity requires an absolute workspace boundary.",
    );
  }
  const home = path.resolve(identity.home);
  const roots = [workspaceRoot, context?.stellaDataDir, context?.toolStateRoot]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .filter((candidate) => path.isAbsolute(candidate))
    .map((candidate) => path.resolve(candidate));
  if (
    !path.isAbsolute(identity.home) ||
    !roots.some((root) => pathInside(home, root))
  ) {
    throw new Error(
      "Tool process home must stay inside the workspace or its trusted tool-state directory.",
    );
  }
  return { ...identity, home };
};

export const resolveManagedShellCommand = (
  state: ShellState,
  args: Record<string, unknown>,
  context?: ToolContext,
): {
  command: string;
  cwd: string;
  envOverrides: Record<string, string>;
  launchOptions: ShellLaunchOptions;
  processIdentity?: ToolProcessIdentity;
} => {
  const command = String(args.cmd ?? args.command ?? "");
  const explicitCwd = args.workdir ?? args.working_directory;
  let cwd =
    explicitCwd !== undefined && explicitCwd !== null
      ? String(explicitCwd)
      : resolveToolFallbackCwd(
          context?.toolWorkspaceRoot ?? context?.stellaAppDir,
        );
  if (context?.executionHost === "sandbox") {
    const workspaceRoot = context.toolWorkspaceRoot?.trim();
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new Error("Sandbox shell commands require a workspace boundary.");
    }
    const lexicalRoot = path.resolve(workspaceRoot);
    const lexicalCwd = path.resolve(cwd);
    if (!pathInside(lexicalCwd, lexicalRoot)) {
      throw new Error("Sandbox shell workdir must stay inside the workspace.");
    }
    let canonicalRoot: string;
    let canonicalCwd: string;
    try {
      canonicalRoot = realpathSync.native(lexicalRoot);
      canonicalCwd = realpathSync.native(lexicalCwd);
    } catch {
      throw new Error(
        "Sandbox shell workdir must be an existing real directory.",
      );
    }
    if (
      canonicalRoot !== lexicalRoot ||
      canonicalCwd !== lexicalCwd ||
      !pathInside(canonicalCwd, canonicalRoot)
    ) {
      throw new Error(
        "Sandbox shell workdir must be canonical and contain no symbolic links.",
      );
    }
    cwd = canonicalCwd;
  }
  const envOverrides: Record<string, string> = {};
  const processIdentity = resolveToolProcessIdentity(context);
  if (processIdentity) {
    envOverrides.HOME = processIdentity.home;
    envOverrides.USER = processIdentity.user;
    envOverrides.LOGNAME = processIdentity.user;
    const stateRoot = context?.toolStateRoot?.trim();
    Object.assign(
      envOverrides,
      toolStateEnvironment(
        stateRoot && path.isAbsolute(stateRoot)
          ? path.resolve(stateRoot)
          : processIdentity.home,
      ),
    );
  }
  if (context && context.executionHost !== "sandbox") {
    Object.assign(envOverrides, stellaAgentShellEnvironment(context));
  }
  const stellaComputerSessionId = getStellaComputerSessionId(context);
  const localBinPaths = [
    ...(context?.stellaDataDir
      ? [path.join(path.resolve(context.stellaDataDir), "bin")]
      : []),
    path.join(path.resolve(cwd), "node_modules", ".bin"),
    ...(context?.stellaAppDir
      ? [path.join(path.resolve(context.stellaAppDir), "node_modules", ".bin")]
      : []),
  ].filter(
    (entry, index, entries) =>
      existsSync(entry) && entries.indexOf(entry) === index,
  );

  if (localBinPaths.length > 0) {
    envOverrides.PATH = [...localBinPaths, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter);
  }

  if (shouldUseStellaComputer(command) && stellaComputerSessionId) {
    envOverrides.STELLA_COMPUTER_SESSION = stellaComputerSessionId;
  }

  if (shouldUseStellaMedia(command)) {
    const backendAuth = state.getCloudBackendAuth?.();
    if (backendAuth) {
      envOverrides.STELLA_MEDIA_BASE_URL = backendAuth.baseUrl;
      envOverrides.STELLA_MEDIA_AUTH_TOKEN = backendAuth.authToken;
    }
    if (context?.deviceId) {
      envOverrides.STELLA_DEVICE_ID = context.deviceId;
    }
  }

  if (shouldUseStellaXApi(command)) {
    const backendAuth = state.getCloudBackendAuth?.();
    if (backendAuth) {
      envOverrides.STELLA_X_API_BASE_URL = backendAuth.baseUrl;
      envOverrides.STELLA_X_API_AUTH_TOKEN = backendAuth.authToken;
    }
  }

  const requestedShell =
    typeof args.shell === "string" && args.shell.trim()
      ? args.shell.trim()
      : undefined;
  return {
    command,
    cwd,
    envOverrides,
    ...(processIdentity ? { processIdentity } : {}),
    launchOptions: {
      ...(requestedShell ? { shell: requestedShell } : {}),
      login: args.login !== false,
      tty: args.tty === true,
    },
  };
};
