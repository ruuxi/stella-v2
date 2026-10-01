/**
 * Caller-side view of one sandbox Durable Object (`src/sandbox-container.ts`).
 *
 * The turn code was written against the 0.12 SDK's sandbox, session, and
 * process objects. These wrappers keep those call shapes over plain RPC:
 * a session is a stored cwd/env/timeout that each call carries to the
 * object, and a process is an id the object resolves against its process
 * directory. Nothing here holds a live connection to the container.
 */
import type {
  Sandbox,
  SandboxBoot,
  SandboxExecResult,
  SandboxProcessInfo,
  SandboxProcessStatus,
  SandboxSessionConfig,
  SandboxState,
} from "./sandbox-container.js";

export type ExecResult = SandboxExecResult;

export type ExecOptions = {
  /** Accepted for 0.12 call compatibility; every command is internal now. */
  origin?: "internal" | "user";
  timeout?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export type ProcessOptions = {
  processId?: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Accepted for 0.12 call compatibility; process directories persist. */
  autoCleanup?: boolean;
};

export type ReadFileResult =
  | { success: true; encoding: "base64" | "utf-8"; content: string; size: number }
  | { success: true; encoding: "none"; content: ReadableStream; size: number };

export interface Process {
  readonly id: string;
  readonly status: SandboxProcessStatus;
  readonly exitCode?: number;
  getStatus(): Promise<SandboxProcessStatus>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
  waitForExit(timeoutMs?: number): Promise<{ exitCode: number }>;
  kill(signal?: string): Promise<void>;
}

export interface ExecutionSession {
  readonly id: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string, options: { encoding: "none" }): Promise<
    Extract<ReadFileResult, { encoding: "none" }>
  >;
  readFile(
    path: string,
    options?: { encoding?: "base64" | "utf-8" },
  ): Promise<Extract<ReadFileResult, { encoding: "base64" | "utf-8" }>>;
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: "base64" | "utf-8" },
  ): Promise<{ success: boolean }>;
  deleteFile(path: string): Promise<{ success: boolean }>;
  mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<{ success: boolean }>;
  exists(path: string): Promise<{ exists: boolean }>;
  startProcess(command: string, options?: ProcessOptions): Promise<Process>;
  getProcess(id: string): Promise<Process | null>;
  killProcess(id: string, signal?: string): Promise<void>;
}

export interface SandboxHandle extends Omit<ExecutionSession, "id"> {
  createSession(options: {
    id: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
    commandTimeoutMs?: number;
  }): Promise<ExecutionSession>;
  getSession(id: string): Promise<ExecutionSession>;
  deleteSession(id: string): Promise<void>;
  getState(): Promise<SandboxState>;
  destroy(options?: { keepSnapshot?: boolean }): Promise<void>;
  /** Snapshot the filesystem shortly, for the next cold start of this world. */
  requestSnapshot(): Promise<void>;
}

type Stub = DurableObjectStub<Sandbox>;

const wrapProcess = (stub: Stub, info: SandboxProcessInfo): Process => ({
  id: info.id,
  status: info.status,
  ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
  getStatus: async () => (await stub.getProcess(info.id))?.status ?? "error",
  getLogs: async () => await stub.processLogs(info.id),
  waitForExit: async (timeoutMs = 15 * 60_000) =>
    await stub.waitForExit(info.id, timeoutMs),
  kill: async (signal = "SIGTERM") => {
    await stub.killProcess(info.id, signal);
  },
});

const scoped = (
  stub: Stub,
  boot: SandboxBoot,
  session: SandboxSessionConfig | undefined,
): Omit<ExecutionSession, "id"> => {
  const env = (extra?: Record<string, string | undefined>) =>
    session?.env || extra ? { ...session?.env, ...extra } : undefined;
  return {
    exec: async (command, options = {}) =>
      await stub.exec(boot, {
        command,
        cwd: options.cwd ?? session?.cwd,
        env: env(options.env),
        timeoutMs: options.timeout ?? session?.commandTimeoutMs,
      }),
    readFile: (async (
      path: string,
      options: { encoding?: "base64" | "utf-8" | "none" } = {},
    ) =>
      await stub.readFile(
        boot,
        path,
        options.encoding ?? "utf-8",
      )) as ExecutionSession["readFile"],
    writeFile: async (path, content, options = {}) =>
      await stub.writeFile(boot, path, content, options.encoding ?? "utf-8"),
    deleteFile: async (path) => await stub.deleteFile(boot, path),
    mkdir: async (path, options = {}) =>
      await stub.mkdir(boot, path, options.recursive === true),
    exists: async (path) => ({ exists: await stub.exists(boot, path) }),
    startProcess: async (command, options = {}) =>
      wrapProcess(
        stub,
        await stub.startProcess(boot, {
          command,
          processId:
            options.processId?.trim() || `stella-process-${crypto.randomUUID()}`,
          cwd: options.cwd ?? session?.cwd,
          env: env(options.env),
          timeoutMs: options.timeout,
        }),
      ),
    getProcess: async (id) => {
      const info = await stub.getProcess(id);
      return info ? wrapProcess(stub, info) : null;
    },
    killProcess: async (id, signal) => {
      await stub.killProcess(id, signal);
    },
  };
};

export const sandboxClient = (
  namespace: DurableObjectNamespace<Sandbox>,
  sandboxId: string,
  boot: SandboxBoot,
): SandboxHandle => {
  const stub = namespace.getByName(sandboxId.toLowerCase());
  const session = (config: SandboxSessionConfig): ExecutionSession => ({
    id: config.id,
    ...scoped(stub, boot, config),
  });
  return {
    ...scoped(stub, boot, undefined),
    createSession: async (options) => {
      const config: SandboxSessionConfig = {
        id: options.id,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.commandTimeoutMs
          ? { commandTimeoutMs: options.commandTimeoutMs }
          : {}),
      };
      await stub.ensure(boot);
      await stub.putSession(config);
      return session(config);
    },
    getSession: async (id) => {
      const config = await stub.getSession(id);
      if (!config) throw new Error(`Sandbox session ${id} does not exist.`);
      return session(config);
    },
    deleteSession: async (id) => {
      await stub.deleteSession(id);
    },
    getState: async () => await stub.state(),
    destroy: async (options) => {
      await stub.destroy(options);
    },
    requestSnapshot: async () => {
      await stub.requestSnapshot();
    },
  };
};

/** A 0.12 SDK backup descriptor, still read from old checkpoint records. */
export type LegacyDirectoryBackup = {
  readonly id: string;
  readonly dir: string;
  readonly localBucket?: boolean;
};
