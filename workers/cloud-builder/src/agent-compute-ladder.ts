/**
 * The compute ladder for one general-agent turn.
 *
 * A resident turn starts with no container. The first tool that needs a real
 * process or the world filesystem attaches one, and it stays attached for the
 * rest of the turn. Everything about that transition that has to survive an
 * isolate loss is written down before it happens: the record naming the
 * sandbox is durable *before* the instance is created, so a Stop arriving mid
 * boot destroys the exact instance rather than leaking it.
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
import type { FileChangeRecord } from "@stella/contracts/file-changes";
import type { TurnComputeUse } from "./general-agent-turn.js";
import type { TurnExecutionContext } from "./turn-cancellation.js";

export type AgentComputePhase =
  | "resident"
  | "attaching"
  | "attached"
  | "quiesced";

export type AttachReason =
  | "process_tool"
  | "filesystem_tool"
  | "interior_build";

export type AgentWorldLeasePhase =
  | "registering"
  | "registered"
  | "unregister_pending";

/**
 * The durable world lease owned by this exact compute attempt.
 *
 * `registering` is written before the cross-DO acquire begins, so a lost
 * response still leaves an exact lease id that recovery can reconcile.
 * `unregister_pending` is written before retirement, for the same reason.
 */
export type PersistedAgentWorldLease = Readonly<{
  leaseId: string;
  phase: AgentWorldLeasePhase;
  generation?: string;
  expiresAt?: number;
}>;

/**
 * The durable fact about where this turn's work is happening.
 *
 * `sandboxId` appears from `attaching` onward and never changes afterwards for
 * a given attempt, because it is what both cancellation sweeps destroy. A
 * `resident` record has none, which is exactly what makes a Stop on a chat-only
 * turn a true no-op instead of a lookup that boots a container to kill it.
 */
type PersistedAgentComputeBase = Readonly<{
  turnId: string;
  attemptGeneration: number;
  phase: AgentComputePhase;
  instanceSize: "small" | "large";
  sandboxId?: string;
  attachReason?: AttachReason;
  attachedAt?: number;
  coldStartMs?: number;
  restoreMs?: number;
}>;

export type PersistedAgentCompute =
  | (PersistedAgentComputeBase &
      Readonly<{
        /** Legacy records remain readable during the rolling upgrade. */
        schemaVersion: 1;
        worldLease?: never;
      }>)
  | (PersistedAgentComputeBase &
      Readonly<{
        schemaVersion: 2;
        worldLease?: PersistedAgentWorldLease;
      }>);

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

const WORLD_LEASE_PHASES: ReadonlySet<string> = new Set([
  "registering",
  "registered",
  "unregister_pending",
]);

const isOptionalFiniteNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

const isPersistedAgentWorldLease = (
  value: unknown,
): value is PersistedAgentWorldLease => {
  if (!isRecord(value)) return false;
  return (
    typeof value.leaseId === "string" &&
    value.leaseId.length > 0 &&
    typeof value.phase === "string" &&
    WORLD_LEASE_PHASES.has(value.phase) &&
    (value.generation === undefined ||
      (typeof value.generation === "string" && value.generation.length > 0)) &&
    isOptionalFiniteNumber(value.expiresAt)
  );
};

/**
 * Read back a compute record for this exact attempt. A record left by another
 * attempt names a container this attempt never reserved, and both destroying
 * it and trusting it would be wrong, so it does not parse.
 */
export const parsePersistedAgentCompute = (
  value: unknown,
  identity: Readonly<{ turnId: string; attemptGeneration: number }>,
): PersistedAgentCompute | null => {
  if (!isRecord(value)) return null;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.turnId !== identity.turnId ||
    value.attemptGeneration !== identity.attemptGeneration ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase) ||
    (value.instanceSize !== "small" && value.instanceSize !== "large")
  ) {
    return null;
  }
  if (value.phase !== "resident" && typeof value.sandboxId !== "string") {
    return null;
  }
  if (value.schemaVersion === 1 && value.worldLease !== undefined) return null;
  if (
    value.schemaVersion === 2 &&
    value.worldLease !== undefined &&
    !isPersistedAgentWorldLease(value.worldLease)
  ) {
    return null;
  }
  // A resident-only turn has never attached, so it cannot own the world.
  if (value.phase === "resident" && value.worldLease !== undefined) return null;
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
  }): Promise<AttachedToolControlResponse>;
  destroy(sandboxId: string): Promise<void>;
}>;

export type AgentWorldLeaseIdentity = Readonly<{
  leaseId: string;
  role: "world";
  turnId: string;
  attemptGeneration: number;
  sandboxId: string;
  attachReason: AttachReason;
}>;

export type AgentWorldLeaseHooks = Readonly<{
  /** Stable for this exact attempt. Acquisition must be idempotent by this id. */
  leaseId: string;
  acquire(
    identity: AgentWorldLeaseIdentity,
  ): Promise<Readonly<{ generation: string; expiresAt: number }>>;
  renew(
    identity: AgentWorldLeaseIdentity &
      Readonly<{ generation: string; expiresAt: number }>,
  ): Promise<Readonly<{ expiresAt: number }>>;
  /** Must be exact and idempotent, including for a lost acquire response. */
  retire(
    identity: AgentWorldLeaseIdentity &
      Readonly<{
        generation?: string;
        expiresAt?: number;
      }>,
  ): Promise<void>;
}>;

export type AgentComputeLadderInput = Readonly<{
  turnId: string;
  attemptGeneration: number;
  /** Reserved at admission and never re-minted, so a sweep has one target. */
  sandboxId: string;
  initialInstanceSize: "small" | "large";
  store: AgentComputeStore;
  attachment: SandboxAttachment;
  /** Optional until BuildSession wires the owner-world fence during rollout. */
  worldLease?: AgentWorldLeaseHooks;
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
  /** Current durable lease fact, if this turn has begun attaching. */
  worldLease(): PersistedAgentWorldLease | null;
  /** Renew the exact registered lease. Intended for the owning DO alarm. */
  renewWorldLease(): Promise<PersistedAgentWorldLease | null>;
  /** Join the daemon and collect what the turn delivered. Idempotent. */
  quiesce(): Promise<
    Readonly<{
      producedFiles: readonly FileChangeRecord[];
      producedFilesOmitted: Readonly<{ count: number; limit: number }> | null;
    }>
  >;
  /**
   * Attach after the loop for a resident turn that asked for the interior
   * build. Constraint 3: the build is squashfs work inside the container, so a
   * resident turn that recorded the request has to attach or the deploy tool
   * would be silently useless.
   */
  attachForInteriorBuild(): Promise<void>;
  /** Destroy whatever was reserved. A no-op for a record that never attached. */
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
    schemaVersion: 2,
    ...identity,
    phase: "resident",
    instanceSize: input.initialInstanceSize,
  };
  let attaching: Promise<void> | null = null;
  let bootNoticePending: string | null = null;
  let interiorBuild = false;
  let admitted = false;
  let quiesceResult: Awaited<ReturnType<AgentComputeLadder["quiesce"]>> | null =
    null;

  const persist = async (next: PersistedAgentCompute): Promise<void> => {
    record = next;
    await input.store.write(next);
  };

  const leaseIdentity = (
    lease: PersistedAgentWorldLease,
  ): AgentWorldLeaseIdentity &
    Readonly<{ generation?: string; expiresAt?: number }> => ({
    leaseId: lease.leaseId,
    role: "world",
    ...identity,
    sandboxId: input.sandboxId,
    attachReason: record.attachReason ?? "process_tool",
    ...(lease.generation === undefined ? {} : { generation: lease.generation }),
    ...(lease.expiresAt === undefined ? {} : { expiresAt: lease.expiresAt }),
  });

  const assertLeaseGrant = (
    value: Readonly<{ generation: string; expiresAt: number }>,
  ): void => {
    if (
      typeof value.generation !== "string" ||
      value.generation.length === 0 ||
      !Number.isFinite(value.expiresAt)
    ) {
      throw new AgentComputeUnavailableError(
        "The owner-world lease returned an invalid grant.",
      );
    }
  };

  const withoutWorldLease = (
    current: PersistedAgentCompute,
  ): PersistedAgentCompute => {
    const { worldLease: _omitted, ...rest } = current;
    return { ...rest, schemaVersion: 2 };
  };

  const acquireWorldLease = async (): Promise<void> => {
    if (!input.worldLease || !record.worldLease) return;
    const lease = record.worldLease;
    const grant = await input.worldLease.acquire(leaseIdentity(lease));
    assertLeaseGrant(grant);
    await persist({
      ...record,
      schemaVersion: 2,
      worldLease: {
        leaseId: lease.leaseId,
        phase: "registered",
        generation: grant.generation,
        expiresAt: grant.expiresAt,
      },
    });
  };

  const retireWorldLease = async (): Promise<void> => {
    if (!input.worldLease || !record.worldLease) return;
    if (record.worldLease.phase !== "unregister_pending") {
      await persist({
        ...record,
        schemaVersion: 2,
        worldLease: {
          ...record.worldLease,
          phase: "unregister_pending",
        },
      });
    }
    const lease = record.worldLease;
    await input.worldLease.retire(leaseIdentity(lease));
    await persist(withoutWorldLease(record));
  };

  const boot = async (reason: AttachReason): Promise<void> => {
    input.context.assertActive();
    // Durable before the instance exists. A sweep that arrives between this
    // write and the boot returning still knows the id to destroy.
    await persist({
      ...record,
      schemaVersion: 2,
      phase: "attaching",
      sandboxId: input.sandboxId,
      attachReason: reason,
      ...(input.worldLease
        ? {
            worldLease: {
              leaseId: input.worldLease.leaseId,
              phase: "registering" as const,
            },
          }
        : {}),
    });
    await acquireWorldLease();
    input.context.assertActive();
    const started = now();
    const result = await input.attachment.boot({
      sandboxId: input.sandboxId,
      instanceSize: record.instanceSize,
    });
    await persist({
      ...record,
      phase: "attached",
      sandboxId: input.sandboxId,
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
    if (record.phase === "attached") {
      const lease = record.worldLease;
      if (
        input.worldLease &&
        lease?.phase === "registered" &&
        typeof lease.generation === "string" &&
        typeof lease.expiresAt === "number"
      ) {
        const renewed = await input.worldLease.renew({
          ...leaseIdentity(lease),
          generation: lease.generation,
          expiresAt: lease.expiresAt,
        });
        if (!Number.isFinite(renewed.expiresAt)) {
          throw new AgentComputeUnavailableError(
            "The owner-world lease returned an invalid renewal.",
          );
        }
        await persist({
          ...record,
          schemaVersion: 2,
          worldLease: { ...lease, expiresAt: renewed.expiresAt },
        });
      }
      return;
    }
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
        fileChanges: [],
        producedFiles: [],
        producedFilesOmitted: null,
      };
    }
    return {
      outcome: { kind: "error", message: response.error },
      details: null,
      authorizedImages: [],
      fileChanges: [],
      producedFiles: [],
      producedFilesOmitted: null,
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
    // The durable compute record owns the keep-alive lease. Close that lease
    // before asking the attachment boundary to destroy the instance, so an
    // isolate loss during teardown can only recover by retrying destruction.
    await persist({ ...record, phase: "quiesced" });
    await input.attachment.destroy(input.sandboxId);
    await retireWorldLease();
    if (admitted) {
      await persist({ ...record, instanceSize: "large" });
      throw error;
    }
    await persist({
      schemaVersion: 2,
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

    worldLease() {
      return record.worldLease ?? null;
    },

    async renewWorldLease() {
      if (!input.worldLease || record.worldLease?.phase !== "registered") {
        return record.worldLease ?? null;
      }
      const lease = record.worldLease;
      if (
        typeof lease.generation !== "string" ||
        typeof lease.expiresAt !== "number"
      ) {
        throw new AgentComputeUnavailableError(
          "The owner-world lease is not renewable.",
        );
      }
      const renewed = await input.worldLease.renew({
        ...leaseIdentity(lease),
        generation: lease.generation,
        expiresAt: lease.expiresAt,
      });
      if (!Number.isFinite(renewed.expiresAt)) {
        throw new AgentComputeUnavailableError(
          "The owner-world lease returned an invalid renewal.",
        );
      }
      await persist({
        ...record,
        schemaVersion: 2,
        worldLease: { ...lease, expiresAt: renewed.expiresAt },
      });
      return record.worldLease ?? null;
    },

    async quiesce() {
      if (quiesceResult) return quiesceResult;
      if (record.phase !== "attached") {
        quiesceResult = { producedFiles: [], producedFilesOmitted: null };
        return quiesceResult;
      }
      const response = await input.attachment.control({
        sandboxId: input.sandboxId,
        control: "quiesce",
        ...identity,
      });
      await persist({ ...record, phase: "quiesced" });
      quiesceResult =
        response.status === "quiesced"
          ? {
              producedFiles: response.producedFiles,
              producedFilesOmitted: response.producedFilesOmitted,
            }
          : { producedFiles: [], producedFilesOmitted: null };
      return quiesceResult;
    },

    async attachForInteriorBuild() {
      if (!interiorBuild) return;
      await ensureAttached("interior_build");
    },

    async teardown() {
      // A turn that never reserved a container has nothing to destroy, and
      // asking for one here would boot the very instance the sweep exists to
      // avoid.
      if (record.phase === "resident") return;
      if (record.phase !== "quiesced") {
        await persist({ ...record, phase: "quiesced" });
      }
      await input.attachment.destroy(input.sandboxId);
      await retireWorldLease();
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
