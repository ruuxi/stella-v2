/**
 * The container side of the compute ladder.
 *
 * `agent-compute-ladder.ts` decides when a resident turn needs a container;
 * this is what actually makes one. It brings the world up on the instance the
 * ladder already reserved, hands the daemon its broker capability through the
 * same root-owned file the container executor uses, starts the daemon, and
 * then relays one tool call at a time through a request file, a one-shot
 * client process, and a result file.
 *
 * Nothing here decides policy. It boots what it is told to boot and reports
 * what the daemon answered, which is what keeps the phase machine testable
 * without a container and keeps the failure of a container from becoming a
 * decision this module gets to make.
 */

import type { ExecutionSession, Process } from "@cloudflare/sandbox";
import { Effect } from "effect";
import { runToolEffect } from "@stella/runtime/kernel/tools/effect-runtime.js";
import {
  ATTACHED_TOOL_PROTOCOL_VERSION,
  ATTACHED_TOOL_RESPONSE_MAX_BYTES,
  attachedToolPathsForDirectory,
  decodeAttachedToolFrame,
  encodeAttachedToolFrame,
  parseAttachedToolControlResponse,
  parseAttachedToolResponse,
  type AttachedToolControlRequest,
  type AttachedToolControlResponse,
  type AttachedToolRequest,
  type AttachedToolResponse,
} from "@stella/executor-cloud/attached-tool-protocol";
import type { AttachBoot, SandboxAttachment } from "./agent-compute-ladder.js";
import type { TurnExecutionContext } from "./turn-cancellation.js";

const DAEMON_ARGV = [
  "bun",
  "packages/executor-cloud/src/cli.ts",
  "--attached-tool-host",
] as const;

const CLIENT_ARGV = [
  "bun",
  "packages/executor-cloud/src/cli.ts",
  "--attached-tool-client",
] as const;

/**
 * Where the executor package lives in the image, and therefore the only
 * directory the relative `DAEMON_ARGV`/`CLIENT_ARGV` resolve from. The eager
 * container path passes the same directory explicitly; the Sandbox SDK applies
 * no session working directory to a background process, so without this the
 * daemon died on "Module not found" before it could listen and every bridged
 * tool call surfaced only the readiness probe's exit status.
 */
const EXECUTOR_ROOT = "/opt/stella";

/** Bounded because a daemon that never listens must fail, not hang the turn. */
const READINESS_POLL_MS = 250;
const READINESS_ATTEMPTS = 240;

/**
 * The readiness probe runs in the session's persistent shell, which earlier
 * boundary scripts may have left with `errexit` on. A probe that exits
 * non-zero while the socket is still absent would therefore take the whole
 * shell down (the SDK reports it as "shell exited (exit code: 1)") and the
 * attach could never succeed. So the probe always exits zero and answers on
 * stdout instead.
 */
const READINESS_READY_MARKER = "stella-attached-tool-host-ready";
const readinessProbe = (socketPath: string): string =>
  `if test -S ${quoted([socketPath])}; then echo ${READINESS_READY_MARKER}; fi`;

/** Enough of the daemon's stderr to name the failure, never a log dump. */
const DAEMON_STDERR_EXCERPT_CHARS = 400;

const DAEMON_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "killed",
  "error",
]);

/**
 * An SDK process call that never settles must not wedge the attach: the
 * readiness loop and the failure report only need a best-effort answer.
 */
const DAEMON_RPC_DEADLINE_MS = 5_000;
const bounded = async <T>(
  work: Promise<T> | undefined,
  fallback: T,
): Promise<T> => {
  if (!work) return fallback;
  // The SDK call keeps running after the deadline; only this wait is bounded.
  const settled = work.then(
    (value) => value,
    () => fallback,
  );
  return await runToolEffect(
    Effect.raceFirst(
      Effect.tryPromise({ try: () => settled, catch: () => fallback }),
      Effect.sleep(DAEMON_RPC_DEADLINE_MS).pipe(Effect.map(() => fallback)),
    ),
  );
};

const describeDaemon = async (
  daemon: Process | undefined,
  daemonStderrPath: string | undefined,
  session?: ExecutionSession,
): Promise<{ status: string; stderr: string }> => {
  if (!daemon) return { status: "unknown", stderr: "" };
  const status = await bounded(daemon.getStatus?.(), "unknown");
  const logs = await bounded(daemon.getLogs?.(), null);
  let stderr = (logs?.stderr ?? "").replace(/\s+/gu, " ").trim();
  if (!stderr && session && daemonStderrPath) {
    const persisted = await session
      .exec(
        `tail -c ${DAEMON_STDERR_EXCERPT_CHARS} ${quoted([daemonStderrPath])}`,
      )
      .catch(() => null);
    if (persisted?.success) {
      stderr = persisted.stdout.replace(/\s+/gu, " ").trim();
    }
  }
  return { status, stderr: stderr.slice(-DAEMON_STDERR_EXCERPT_CHARS) };
};

export class AttachedToolHostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachedToolHostUnavailableError";
  }
}

/**
 * What the daemon needs to know about the turn it is serving. Deliberately not
 * the executor's `turn-input.json`: the daemon runs no agent loop, so it gets
 * the drive-hydration inputs and its broker capability and nothing else.
 */
export type AttachedToolHostHandoff = Readonly<{
  turnId: string;
  attemptGeneration: number;
  threadId: string;
  prompt: string;
  workspaceRestored: boolean;
  turnBroker: Readonly<{ credentialsPath: string }>;
  world: Readonly<{ origin: string; name: string; capability: string }>;
}>;

export type AgentSandboxAttachmentDeps = Readonly<{
  context: TurnExecutionContext;
  /**
   * Create the container's command session with this owner's world on disk.
   * Shared with the eager container path so a mid-turn attach lands on exactly
   * the disk an eager boot would have produced.
   */
  attachWorld(args: {
    sandboxId: string;
    instanceSize: "small" | "large";
    sessionId: string;
  }): Promise<
    Readonly<{
      session: ExecutionSession;
      coldContainerStartMs: number;
      restoreMs: number;
    }>
  >;
  /**
   * Write the broker credential file and return the daemon's handoff record.
   * Issuance stays with the caller because only it holds the storage the
   * broker record has to be durable in before the container can present it.
   */
  prepareBrokerHandoff(args: {
    session: ExecutionSession;
  }): Promise<AttachedToolHostHandoff>;
  /**
   * Start the daemon as a sessionless background process, the way the eager
   * container path starts its executor. A process started through an
   * `ExecutionSession` belongs to that session's persistent shell and dies
   * with it, and that shell also runs the readiness probe, the one-shot
   * client and every boundary script. Starting the daemon outside any session
   * means no shell exit can take the bridge down. Falls back to the session
   * when absent so the phase machine stays testable with one fake.
   */
  startDaemon?: (
    command: string,
    options: Readonly<{ cwd: string; processId: string }>,
  ) => Promise<Process>;
  /** Release one turn without stopping the shared container. */
  release(args: {
    sandboxId: string;
    instanceSize: "small" | "large";
    sessionId: string;
    daemonDirectory: string;
  }): Promise<void>;
  /** Destroy the shared container only for OOM escalation or retirement. */
  destroy(args: {
    sandboxId: string;
    instanceSize: "small" | "large";
  }): Promise<void>;
  emitEvent?: (kind: string, payload: unknown) => void;
}>;

/**
 * The SDK's persistent shell exited underneath a call. It reports this as a
 * session-terminated error, and every later call on the same session id gets
 * a fresh, empty shell. Recognised by name and by the message the SDK writes,
 * so a wrapped or re-thrown copy is still classified.
 */
const SESSION_TERMINATED_MESSAGE = /shell exited|session .* ended/iu;
export const isSessionTerminatedError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "SessionTerminatedError" ||
    SESSION_TERMINATED_MESSAGE.test(error.message));

const quoted = (argv: readonly string[]): string =>
  argv
    .map((token) => {
      if (token.includes("\0")) {
        throw new Error("Attached tool argv contains a NUL byte.");
      }
      return `'${token.replace(/'/gu, `'"'"'`)}'`;
    })
    .join(" ");

/**
 * Reject an oversized frame before it is read into the isolate. The protocol
 * bound exists to keep a runaway tool result from taking the DO down with it,
 * so checking it after decoding would defeat the point.
 */
const readBoundedFrame = async (
  session: ExecutionSession,
  path: string,
): Promise<unknown> => {
  const size = await session.exec(`wc -c < ${quoted([path])}`);
  if (!size.success) {
    throw new AttachedToolHostUnavailableError(
      "The workspace did not return a result for that call.",
    );
  }
  const bytes = Number.parseInt(size.stdout.trim(), 10);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new AttachedToolHostUnavailableError(
      "The workspace returned an unreadable result for that call.",
    );
  }
  if (bytes > ATTACHED_TOOL_RESPONSE_MAX_BYTES) {
    throw new AttachedToolHostUnavailableError(
      "That call produced more output than the workspace bridge can carry.",
    );
  }
  const read = await session.readFile(path, { encoding: "base64" });
  return decodeAttachedToolFrame(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(atob(read.content), (character) =>
        character.charCodeAt(0),
      ),
    ),
    ATTACHED_TOOL_RESPONSE_MAX_BYTES,
  );
};

/** A client failure that means the daemon itself was not there to answer. */
const DAEMON_UNREACHABLE =
  /ECONNREFUSED|ENOENT|EPIPE|ECONNRESET|unreachable|socket closed/iu;

export const createAgentSandboxAttachment = (
  deps: AgentSandboxAttachmentDeps,
): SandboxAttachment => {
  let attached: ExecutionSession | undefined;
  let daemon: Process | undefined;
  let daemonDirectory: string | undefined;
  let daemonLossReported = false;
  let sessionTerminationReported = false;

  const requireSession = (): ExecutionSession => {
    if (!attached) {
      throw new AttachedToolHostUnavailableError(
        "This turn has no workspace attached.",
      );
    }
    return attached;
  };

  const writeProtected = async (
    session: ExecutionSession,
    path: string,
    contents: string,
  ): Promise<void> => {
    await session.writeFile(path, contents);
    const protectedFile = await session.exec(`chmod 600 ${quoted([path])}`);
    if (!protectedFile.success) {
      throw new AttachedToolHostUnavailableError(
        "The workspace bridge handoff could not be protected.",
      );
    }
  };

  /**
   * A shell that exited under a bridge call is reported once, with the SDK's
   * own exit reason, and surfaces as a tool error rather than being swallowed
   * into a generic "could not run that call". This is the signal that a
   * boundary script leaked `set -e` into the session, which is otherwise
   * invisible: the daemon dies with an empty stderr and the next call simply
   * finds nothing listening.
   */
  const sessionTerminated = (
    error: unknown,
  ): AttachedToolHostUnavailableError => {
    const message = error instanceof Error ? error.message : String(error);
    if (!sessionTerminationReported) {
      sessionTerminationReported = true;
      deps.emitEvent?.("attached_session_terminated", {
        reason: "The workspace shell exited under a bridge call",
        error: message.slice(0, 400),
      });
    }
    return new AttachedToolHostUnavailableError(
      `The workspace shell exited under that call: ${message.slice(0, 400)}`,
    );
  };

  const roundTrip = async (
    frame: AttachedToolRequest | AttachedToolControlRequest,
  ): Promise<unknown> => {
    const session = requireSession();
    if (!daemonDirectory) {
      throw new AttachedToolHostUnavailableError(
        "This turn has no workspace bridge directory.",
      );
    }
    const paths = attachedToolPathsForDirectory(daemonDirectory);
    deps.context.assertActive();
    try {
      // The stale result may simply not exist yet; only a dead shell is news.
      await session.deleteFile(paths.result).catch((error) => {
        if (isSessionTerminatedError(error)) throw error;
      });
      await writeProtected(
        session,
        paths.request,
        encodeAttachedToolFrame(frame),
      );
      deps.context.assertActive();
      const call = await session.exec(
        quoted([
          ...CLIENT_ARGV,
          "--socket",
          paths.socket,
          "--request",
          paths.request,
          "--result",
          paths.result,
        ]),
        {
          cwd: EXECUTOR_ROOT,
        },
      );
      if (!call.success) {
        throw new AttachedToolHostUnavailableError(
          "The workspace could not run that call.",
        );
      }
      deps.context.assertActive();
      return await readBoundedFrame(session, paths.result);
    } catch (error) {
      if (isSessionTerminatedError(error)) throw sessionTerminated(error);
      throw error;
    }
  };

  /**
   * The daemon reported ready and then stopped answering. The client's
   * failure frame only says the socket refused; the daemon's own status and
   * stderr say why it died, and this is the one place they can still be read.
   * Reported once per attach so a turn's remaining calls do not repeat it.
   */
  const reportDaemonLoss = async (
    response: AttachedToolResponse | AttachedToolControlResponse,
  ): Promise<void> => {
    if (
      daemonLossReported ||
      response.status !== "failed" ||
      !DAEMON_UNREACHABLE.test(response.error)
    ) {
      return;
    }
    daemonLossReported = true;
    const paths = daemonDirectory
      ? attachedToolPathsForDirectory(daemonDirectory)
      : undefined;
    const described = await describeDaemon(
      daemon,
      paths?.daemonStderr,
      attached,
    );
    // What the container itself can still say about the bridge: the socket
    // directory and the process table, bounded, so a dead daemon can be
    // told apart from one that never listened or was replaced.
    const inspect = async (command: string): Promise<string> => {
      const result = await attached?.exec(command).catch(() => null);
      return (result?.success ? result.stdout : (result?.stderr ?? ""))
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 1_500);
    };
    deps.emitEvent?.("attached_daemon_failed", {
      reason: "The workspace bridge stopped answering",
      status: described.status,
      stderr: described.stderr,
      error: response.error,
      socketDir: await inspect(
        paths
          ? `ls -la --time-style=full-iso ${quoted([paths.directory])}`
          : "true",
      ),
      processes: await inspect("ps -eo pid,ppid,stat,etime,args"),
      memory: await inspect("free -m 2>&1 | head -2"),
      processRecords: await inspect(
        'for f in /tmp/sandbox-processes/*.json; do echo "== $f"; head -c 700 "$f"; echo; done 2>&1 | tail -c 1400',
      ),
      exitCode: String(
        (daemon as { exitCode?: unknown } | undefined)?.exitCode ?? "",
      ),
    });
  };

  const daemonFailure = async (
    daemon: Process | undefined,
    reason: string,
  ): Promise<AttachedToolHostUnavailableError> => {
    const described = await describeDaemon(
      daemon,
      daemonDirectory
        ? attachedToolPathsForDirectory(daemonDirectory).daemonStderr
        : undefined,
      attached,
    );
    deps.emitEvent?.("attached_daemon_failed", {
      reason,
      status: described.status,
      stderr: described.stderr,
    });
    return new AttachedToolHostUnavailableError(
      described.stderr
        ? `${reason} (${described.status}): ${described.stderr}`
        : `${reason} (${described.status}).`,
    );
  };

  const waitForDaemon = async (
    session: ExecutionSession,
    daemon: Process | undefined,
    socketPath: string,
  ): Promise<void> => {
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      deps.context.assertActive();
      const listening = await session.exec(readinessProbe(socketPath));
      if (
        listening.success &&
        listening.stdout.includes(READINESS_READY_MARKER)
      ) {
        return;
      }
      // A daemon that already exited will never listen; say why now rather
      // than after the whole readiness window.
      const status = await bounded(daemon?.getStatus?.(), "running");
      if (DAEMON_TERMINAL_STATUSES.has(status)) {
        throw await daemonFailure(
          daemon,
          "The workspace bridge exited before it could listen",
        );
      }
      await deps.context.cancellation.sleep(READINESS_POLL_MS);
    }
    throw await daemonFailure(
      daemon,
      "The workspace did not finish starting up",
    );
  };

  return {
    boot: async (args): Promise<AttachBoot> => {
      deps.context.assertActive();
      const world = await deps.attachWorld(args);
      attached = world.session;
      daemonDirectory = args.daemonDirectory;
      const paths = attachedToolPathsForDirectory(args.daemonDirectory);
      deps.context.assertActive();
      const directory = await world.session.exec(
        `mkdir -p ${quoted([paths.directory])} && chown 0:0 ${quoted([
          paths.directory,
        ])} && chmod 0700 ${quoted([paths.directory])}`,
      );
      if (!directory.success) {
        throw new AttachedToolHostUnavailableError(
          "The workspace bridge directory could not be prepared.",
        );
      }
      deps.context.assertActive();
      const handoff = await deps.prepareBrokerHandoff({
        session: world.session,
      });
      deps.context.assertActive();
      await writeProtected(
        world.session,
        paths.hostInput,
        JSON.stringify(handoff),
      );
      deps.context.assertActive();
      // The daemon is trusted root code: it holds the broker capability and
      // serves a root-only socket, so it must not be dropped to the tool
      // account the way a model-controlled command is.
      // stderr also lands in a file: the SDK keeps nothing for a process
      // that died abruptly, and that file is how a dead bridge explains itself.
      // Started outside the session shell when the caller can: a session
      // process is a child of that persistent shell, and the shell has just
      // run the restore scripts and will run every bridged call next.
      const daemonCommand = `${quoted([
        ...DAEMON_ARGV,
        "--dir",
        paths.directory,
      ])} 2>>${quoted([paths.daemonStderr])}`;
      const processId = `attached-daemon-${args.sessionId}`.slice(0, 64);
      daemon = deps.startDaemon
        ? await deps.startDaemon(daemonCommand, {
            cwd: EXECUTOR_ROOT,
            processId,
          })
        : await world.session.startProcess(daemonCommand, {
            cwd: EXECUTOR_ROOT,
            processId,
          });
      daemonLossReported = false;
      sessionTerminationReported = false;
      await waitForDaemon(world.session, daemon, paths.socket);
      return {
        coldStartMs: world.coldContainerStartMs,
        restoreMs: world.restoreMs,
      };
    },

    callTool: async (args): Promise<AttachedToolResponse> => {
      const response = parseAttachedToolResponse(await roundTrip(args.request));
      await reportDaemonLoss(response);
      return response;
    },

    control: async (args): Promise<AttachedToolControlResponse> => {
      const response = parseAttachedToolControlResponse(
        await roundTrip(
          args.control === "quiesce"
            ? {
                version: ATTACHED_TOOL_PROTOCOL_VERSION,
                turnId: args.turnId,
                attemptGeneration: args.attemptGeneration,
                control: "quiesce",
                linkedPaths: args.linkedPaths ?? [],
              }
            : {
                version: ATTACHED_TOOL_PROTOCOL_VERSION,
                turnId: args.turnId,
                attemptGeneration: args.attemptGeneration,
                control: "boot_report",
              },
        ),
      );
      // The ladder tolerates a failed control call (a quiesce that failed
      // simply delivers no files), so this event is the only record of why
      // the daemon could not answer it.
      if (response.status === "failed") {
        deps.emitEvent?.("attached_control_failed", {
          control: args.control,
          error: response.error,
        });
      }
      await reportDaemonLoss(response);
      return response;
    },

    release: async (args): Promise<void> => {
      const status = await bounded(daemon?.getStatus?.(), "completed");
      if (daemon && !DAEMON_TERMINAL_STATUSES.has(status)) {
        await bounded(daemon.kill("SIGKILL"), undefined);
      }
      attached = undefined;
      daemon = undefined;
      daemonDirectory = undefined;
      await deps.release(args);
    },

    destroy: async (args): Promise<void> => {
      attached = undefined;
      daemon = undefined;
      daemonDirectory = undefined;
      await deps.destroy(args);
    },
  };
};
