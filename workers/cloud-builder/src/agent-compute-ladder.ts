/**
 * The compute ladder for one general-agent turn.
 *
 * A resident turn starts with no container. The first tool that needs a real
 * process or the world filesystem attaches one, and it stays attached for the
 * rest of the turn. Everything about that transition that has to survive an
 * isolate loss is written down before it happens: the record naming the
 * sandbox, session, and daemon directory are durable before the session is
 * created, so a Stop arriving mid boot can clean the exact turn resources.
 *
 * The sandbox itself is behind `SandboxAttachment`. This module decides when
 * to boot, when to refuse, when to replay and when to give up; it does not
 * know how a container is made. That is what lets the state machine be tested
 * without a container and keeps the module workerd-safe.
 */

import type {
  AttachedToolControlResponse,
  AttachedToolRequest,
  AttachedToolResponse,
  SerializedAgentToolResult,
} from "@stella/executor-cloud/attached-tool-protocol";
import {
  ATTACHED_TOOL_PROTOCOL_VERSION,
  attachedToolFingerprint,
  isAttachedToolName,
  type AttachedToolName,
} from "@stella/executor-cloud/attached-tool-protocol";
import type { TurnComputeUse } from "./general-agent-turn.js";
import type { TurnExecutionContext } from "./turn-cancellation.js";

export type AgentComputePhase =
  "resident" | "attaching" | "attached" | "quiesced";

export type AttachReason =
  "process_tool" | "filesystem_tool" | "interior_build";

/**
 * The durable fact about where this turn's work is happening.
 *
 * `sandboxId`, `sessionId`, and `daemonDirectory` appear from `attaching`
 * onward and identify exactly what cancellation releases. A `resident` record
 * has none, which makes a Stop on a chat-only turn a true no-op.
 */
type PersistedAgentComputeBase = Readonly<{
  turnId: string;
  attemptGeneration: number;
  phase: AgentComputePhase;
  instanceSize: "small" | "large";
  sandboxId?: string;
  sessionId?: string;
  daemonDirectory?: string;
  attachReason?: AttachReason;
  attachedAt?: number;
  coldStartMs?: number;
  restoreMs?: number;
}>;

export type PersistedAgentCompute = PersistedAgentComputeBase &
  Readonly<{ schemaVersion: 1 }>;

export const agentComputeKey = (
  turnId: string,
  attemptGeneration: number,
): string => `agentCompute:${turnId}:${attemptGeneration}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const PHASES: ReadonlySet<string> = new Set([
  "resident",
  "attaching",
  "attached",
  "quiesced",
]);

/**
 * Read back a compute record for this exact attempt. A record left by another
 * attempt names a session this attempt never created, and both releasing it
 * and trusting it would be wrong, so it does not parse.
 */
export const parsePersistedAgentCompute = (
  value: unknown,
  identity: Readonly<{ turnId: string; attemptGeneration: number }>,
): PersistedAgentCompute | null => {
  if (!isRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    value.turnId !== identity.turnId ||
    value.attemptGeneration !== identity.attemptGeneration ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase) ||
    (value.instanceSize !== "small" && value.instanceSize !== "large")
  ) {
    return null;
  }
  if (
    value.phase !== "resident" &&
    (typeof value.sandboxId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.daemonDirectory !== "string")
  ) {
    return null;
  }
  return value as unknown as PersistedAgentCompute;
};

export type AgentComputeStore = Readonly<{
  read(): Promise<PersistedAgentCompute | null>;
  write(record: PersistedAgentCompute): Promise<void>;
}>;

export type AttachBoot = Readonly<{
  coldStartMs: number;
  restoreMs: number;
}>;

/**
 * Raised by the attachment port when the container died for want of memory.
 * It is a distinct type because the answer depends entirely on whether a
 * command had already been admitted, and no message string can carry that.
 */
export class SandboxOutOfMemoryError extends Error {
  constructor(message = "The sandbox ran out of memory.") {
    super(message);
    this.name = "SandboxOutOfMemoryError";
  }
}

export type SandboxAttachment = Readonly<{
  /** Boot the instance the record already names. Never mints an id. */
  boot(args: {
    sandboxId: string;
    instanceSize: "small" | "large";
    sessionId: string;
    daemonDirectory: string;
  }): Promise<AttachBoot>;
  callTool(args: {
    sandboxId: string;
    request: AttachedToolRequest;
  }): Promise<AttachedToolResponse>;
  control(args: {
    sandboxId: string;
    control: "boot_report" | "quiesce";
    turnId: string;
    attemptGeneration: number;
    /** Required for `quiesce`: untrusted reply-linked paths to deliver. */
    linkedPaths?: readonly string[];
  }): Promise<AttachedToolControlResponse>;
  release(args: {
    sandboxId: string;
    instanceSize: "small" | "large";
    sessionId: string;
    daemonDirectory: string;
  }): Promise<void>;
  destroy(args: {
    sandboxId: string;
    instanceSize: "small" | "large";
  }): Promise<void>;
}>;

export type AgentComputeLadderInput = Readonly<{
  turnId: string;
  attemptGeneration: number;
  /** Reserved at admission and never re-minted, so a sweep has one target. */
  sandboxId: string;
  sessionId: string;
  daemonDirectory: string;
  initialInstanceSize: "small" | "large";
  selectInstanceSize(initial: "small" | "large"): Promise<"small" | "large">;
  rememberInstanceSize(size: "small" | "large"): Promise<void>;
  store: AgentComputeStore;
  attachment: SandboxAttachment;
  context: TurnExecutionContext;
  emitEvent: (kind: string, payload: unknown) => void;
  now?: () => number;
}>;

export type LadderToolCall = Readonly<{
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
}>;

export class AgentComputeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentComputeUnavailableError";
  }
}

const BOOT_REPORT_PREFIX = "\n\n";

export type AgentComputeLadder = Readonly<{
  /** Run one bridged tool, attaching first if this is the call that needs it. */
  execute(call: LadderToolCall): Promise<SerializedAgentToolResult>;
  /** The turn recorded a request for the post-loop interior build. */
  requestInteriorBuild(): void;
  interiorBuildRequested(): boolean;
  attached(): boolean;
  /**
   * Join the daemon and deliver what the reply linked. Idempotent.
   * `linkedPaths` are the untrusted paths extracted from the turn's final
   * assistant message(s); the daemon authorizes each one before delivery.
   */
  quiesce(
    linkedPaths?: readonly string[],
  ): Promise<Readonly<{ deliveredFiles: readonly string[] }>>;
  /**
   * Attach after the loop for a resident turn that asked for the interior
   * build. Constraint 3: the build is squashfs work inside the container, so a
   * resident turn that recorded the request has to attach or the deploy tool
   * would be silently useless.
   */
  attachForInteriorBuild(): Promise<void>;
  /** Release the exact turn session. A no-op for a turn that never attached. */
  teardown(): Promise<void>;
  compute(): TurnComputeUse;
}>;

const reasonFor = (toolName: AttachedToolName): AttachReason =>
  toolName === "exec_command" || toolName === "write_stdin"
    ? "process_tool"
    : "filesystem_tool";

export const createAgentComputeLadder = (
  input: AgentComputeLadderInput,
): AgentComputeLadder => {
  const now = input.now ?? (() => Date.now());
  const identity = {
    turnId: input.turnId,
    attemptGeneration: input.attemptGeneration,
  } as const;

  let record: PersistedAgentCompute = {
    schemaVersion: 1,
    ...identity,
    phase: "resident",
    instanceSize: input.initialInstanceSize,
  };
  let attaching: Promise<void> | null = null;
  let bootNoticePending: string | null = null;
  let interiorBuild = false;
  let admitted = false;
  let released = false;
  let quiesceResult: Awaited<ReturnType<AgentComputeLadder["quiesce"]>> | null =
    null;

  const persist = async (next: PersistedAgentCompute): Promise<void> => {
    record = next;
    await input.store.write(next);
  };

  const boot = async (reason: AttachReason): Promise<void> => {
    input.context.assertActive();
    const instanceSize = await input.selectInstanceSize(record.instanceSize);
    input.context.assertActive();
    // Durable before the session exists. A sweep that arrives between this
    // write and boot returning still knows the exact resources to release.
    await persist({
      ...record,
      schemaVersion: 1,
      phase: "attaching",
      instanceSize,
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      daemonDirectory: input.daemonDirectory,
      attachReason: reason,
    });
    input.context.assertActive();
    const started = now();
    const result = await input.attachment.boot({
      sandboxId: input.sandboxId,
      instanceSize: record.instanceSize,
      sessionId: input.sessionId,
      daemonDirectory: input.daemonDirectory,
    });
    await persist({
      ...record,
      phase: "attached",
      sandboxId: input.sandboxId,
      sessionId: input.sessionId,
      daemonDirectory: input.daemonDirectory,
      attachReason: reason,
      attachedAt: started,
      coldStartMs: result.coldStartMs,
      restoreMs: result.restoreMs,
    });
    // Only a real attach says the sandbox is ready. A resident turn never
    // emits this, which is what keeps the client from drawing a workspace the
    // turn does not have.
    input.emitEvent("sandbox_ready", {
      attachedMidTurn: true,
      instanceSize: record.instanceSize,
      reason,
    });
    const report = await input.attachment.control({
      sandboxId: input.sandboxId,
      control: "boot_report",
      ...identity,
    });
    bootNoticePending =
      report.status === "boot_report" && report.notices.length > 0
        ? report.notices.join(" ")
        : null;
  };

  /** Single-flight and sticky: concurrent tool calls share one attach. */
  const ensureAttached = async (reason: AttachReason): Promise<void> => {
    if (record.phase === "attached") return;
    if (record.phase === "quiesced") {
      throw new AgentComputeUnavailableError(
        "This turn's workspace has already been closed.",
      );
    }
    if (!attaching) {
      attaching = boot(reason).finally(() => {
        attaching = null;
      });
    }
    await attaching;
  };

  const withBootNotice = (
    result: SerializedAgentToolResult,
  ): SerializedAgentToolResult => {
    if (!bootNoticePending || result.outcome.kind !== "ok") return result;
    const notice = bootNoticePending;
    bootNoticePending = null;
    return {
      ...result,
      outcome: {
        kind: "ok",
        text: `${result.outcome.text}${BOOT_REPORT_PREFIX}${notice}`,
      },
    };
  };

  const send = async (
    request: AttachedToolRequest,
  ): Promise<SerializedAgentToolResult> => {
    const response = await input.attachment.callTool({
      sandboxId: input.sandboxId,
      request,
    });
    if (response.status === "completed") return response.result;
    if (response.status === "pending") {
      // The daemon is still running the call this replays. Nothing here can
      // wait it out without risking a second run, so the model is told.
      return {
        outcome: {
          kind: "error",
          message:
            "That command is still running in the workspace. Wait for it before trying again.",
        },
        details: null,
        authorizedImages: [],
      };
    }
    return {
      outcome: { kind: "error", message: response.error },
      details: null,
      authorizedImages: [],
    };
  };

  /**
   * D8. Whether an out-of-memory kill can be retried turns entirely on whether
   * the command was admitted. Before admission nothing ran, so a bigger
   * instance and one retry is safe. After admission the command may already
   * have sent mail, spent money, or pushed a branch, and no amount of memory
   * makes running it twice correct.
   */
  const recoverFromOom = async (
    error: SandboxOutOfMemoryError,
  ): Promise<void> => {
    await persist({ ...record, phase: "quiesced" });
    await input.attachment.destroy({
      sandboxId: input.sandboxId,
      instanceSize: record.instanceSize,
    });
    await input.rememberInstanceSize("large");
    if (admitted) {
      await persist({ ...record, instanceSize: "large" });
      throw error;
    }
    await persist({
      schemaVersion: 1,
      ...identity,
      phase: "resident",
      instanceSize: "large",
    });
  };

  return {
    async execute(call) {
      if (!isAttachedToolName(call.toolName)) {
        throw new AgentComputeUnavailableError(
          `${call.toolName} is not a tool the workspace can run.`,
        );
      }
      const toolName = call.toolName;
      const fingerprint = await attachedToolFingerprint({
        toolName,
        params: call.params,
      });
      const request: AttachedToolRequest = {
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        ...identity,
        toolCallId: call.toolCallId,
        fingerprint,
        toolName,
        params: call.params,
      };
      const attempt = async (): Promise<SerializedAgentToolResult> => {
        await ensureAttached(reasonFor(toolName));
        input.context.assertActive();
        admitted = true;
        return withBootNotice(await send(request));
      };
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof SandboxOutOfMemoryError)) throw error;
        await recoverFromOom(error);
        // Only reachable when nothing had been admitted; `recoverFromOom`
        // rethrows otherwise, which is what preserves the prior checkpoint.
        return await attempt();
      }
    },

    requestInteriorBuild() {
      interiorBuild = true;
    },

    interiorBuildRequested() {
      return interiorBuild;
    },

    attached() {
      return record.phase === "attached";
    },

    async quiesce(linkedPaths) {
      if (quiesceResult) return quiesceResult;
      if (record.phase !== "attached") {
        quiesceResult = { deliveredFiles: [] };
        return quiesceResult;
      }
      const response = await input.attachment.control({
        sandboxId: input.sandboxId,
        control: "quiesce",
        linkedPaths: linkedPaths ?? [],
        ...identity,
      });
      await persist({ ...record, phase: "quiesced" });
      quiesceResult =
        response.status === "quiesced"
          ? { deliveredFiles: response.deliveredFiles }
          : { deliveredFiles: [] };
      return quiesceResult;
    },

    async attachForInteriorBuild() {
      if (!interiorBuild) return;
      await ensureAttached("interior_build");
    },

    async teardown() {
      if (released) return;
      // A turn that never attached has no session to release.
      if (record.phase === "resident") return;
      if (record.phase !== "quiesced") {
        await persist({ ...record, phase: "quiesced" });
      }
      await input.attachment.release({
        sandboxId: input.sandboxId,
        instanceSize: record.instanceSize,
        sessionId: input.sessionId,
        daemonDirectory: input.daemonDirectory,
      });
      released = true;
    },

    compute() {
      if (record.phase === "resident" || !record.attachReason) {
        return { kind: "resident" };
      }
      return {
        kind: "sandbox",
        reason: record.attachReason,
        instanceSize: record.instanceSize,
        coldStartMs: record.coldStartMs ?? 0,
        restoreMs: record.restoreMs ?? 0,
      };
    },
  };
};
