import type {
  ExecOptions,
  ExecResult,
  ExecutionSession,
  Process,
  ProcessOptions,
} from "@cloudflare/sandbox";

export const CLOUD_MODEL_UID = 42_424;
export const CLOUD_MODEL_GID = 42_424;
export const APP_BUILD_SESSION_ENV = Object.freeze({
  STELLA_CLOUD_WORKSPACE_ROOT: "/workspace/app",
  USER: "stella-tools",
  LOGNAME: "stella-tools",
  HOME: "/workspace/.stella-tool-home",
  XDG_CONFIG_HOME: "/workspace/.stella-tool-home/.config",
  XDG_CACHE_HOME: "/workspace/.stella-tool-home/.cache",
  XDG_STATE_HOME: "/workspace/.stella-tool-home/.local/state",
});

const quoteShellArg = (value: string): string => {
  if (value.includes("\0")) {
    throw new Error("Strict session argv contains a NUL byte.");
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

export const strictSessionCommand = (argv: readonly string[]): string => {
  if (argv.length === 0 || !argv[0]) {
    throw new Error("Strict session execution requires a command.");
  }
  return [
    "exec",
    "/usr/bin/setpriv",
    `--reuid=${CLOUD_MODEL_UID}`,
    `--regid=${CLOUD_MODEL_GID}`,
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    ...argv.map(quoteShellArg),
  ].join(" ");
};

type StrictSession = Pick<ExecutionSession, "exec" | "startProcess">;

export const strictSessionExec = (
  session: StrictSession,
  argv: readonly string[],
  options?: ExecOptions,
): Promise<ExecResult> => session.exec(strictSessionCommand(argv), options);

export const startStrictSessionProcess = (
  session: StrictSession,
  argv: readonly string[],
  options?: ProcessOptions,
): Promise<Process> => session.startProcess(strictSessionCommand(argv), options);
