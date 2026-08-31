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

import type { ExecutionSession } from "@cloudflare/sandbox";
import {
  ATTACHED_TOOL_HOST_INPUT_PATH,
  ATTACHED_TOOL_PROTOCOL_VERSION,
  ATTACHED_TOOL_REQUEST_PATH,
  ATTACHED_TOOL_RESPONSE_MAX_BYTES,
  ATTACHED_TOOL_RESULT_PATH,
  ATTACHED_TOOL_SOCKET_PATH,
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

/** Bounded because a daemon that never listens must fail, not hang the turn. */
const READINESS_POLL_MS = 250;
const READINESS_ATTEMPTS = 240;

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
  /** The exact teardown the cancellation sweeps perform. */
  destroy(sandboxId: string): Promise<void>;
  emitEvent?: (kind: string, payload: unknown) => void;
}>;

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

export const createAgentSandboxAttachment = (
  deps: AgentSandboxAttachmentDeps,
): SandboxAttachment => {
  let attached: ExecutionSession | undefined;

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
   * One round trip. The stale result is removed first so a lost predecessor's
   * answer can never be read as this call's, and the client's own failure
   * frame is what surfaces a transport problem as a tool error.
   */
  const roundTrip = async (
    frame: AttachedToolRequest | AttachedToolControlRequest,
  ): Promise<unknown> => {
    const session = requireSession();
    deps.context.assertActive();
    await session.deleteFile(ATTACHED_TOOL_RESULT_PATH).catch(() => undefined);
    await writeProtected(
      session,
      ATTACHED_TOOL_REQUEST_PATH,
      encodeAttachedToolFrame(frame),
    );
    deps.context.assertActive();
    const call = await session.exec(quoted(CLIENT_ARGV));
    if (!call.success) {
      throw new AttachedToolHostUnavailableError(
        "The workspace could not run that call.",
      );
    }
    deps.context.assertActive();
    return await readBoundedFrame(session, ATTACHED_TOOL_RESULT_PATH);
  };

  const waitForDaemon = async (session: ExecutionSession): Promise<void> => {
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      deps.context.assertActive();
      const listening = await session.exec(
        `test -S ${quoted([ATTACHED_TOOL_SOCKET_PATH])}`,
      );
      if (listening.success) return;
      await deps.context.cancellation.sleep(READINESS_POLL_MS);
    }
    throw new AttachedToolHostUnavailableError(
      "The workspace did not finish starting up.",
    );
  };

  return {
    boot: async (args): Promise<AttachBoot> => {
      deps.context.assertActive();
      const world = await deps.attachWorld(args);
      attached = world.session;
      deps.context.assertActive();
      const handoff = await deps.prepareBrokerHandoff({
        session: world.session,
      });
      deps.context.assertActive();
      await writeProtected(
        world.session,
        ATTACHED_TOOL_HOST_INPUT_PATH,
        JSON.stringify(handoff),
      );
      deps.context.assertActive();
      // The daemon is trusted root code: it holds the broker capability and
      // serves a root-only socket, so it must not be dropped to the tool
      // account the way a model-controlled command is.
      await world.session.startProcess(quoted(DAEMON_ARGV));
      await waitForDaemon(world.session);
      return {
        coldStartMs: world.coldContainerStartMs,
        restoreMs: world.restoreMs,
      };
    },

    callTool: async (args): Promise<AttachedToolResponse> =>
      parseAttachedToolResponse(await roundTrip(args.request)),

    control: async (args): Promise<AttachedToolControlResponse> =>
      parseAttachedToolControlResponse(
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
      ),

    destroy: async (sandboxId): Promise<void> => {
      attached = undefined;
      await deps.destroy(sandboxId);
    },
  };
};
