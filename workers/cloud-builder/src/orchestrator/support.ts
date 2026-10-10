import type { DevicesResponse } from "@stella/contracts/turn-plane/placement";
import { resolveManagedModelDescriptor } from "@stella/model-catalog/gateway-resolution";
import {
  createExecutionContextSnapshot,
  type ExecutionContextSnapshot,
  mediaAccessForAudience,
} from "@stella/contracts/execution-context";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import type { AgentActivityEntry } from "@stella/contracts/conversation-agent-activity";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import {
  type MintedTurnCapability,
  mintTurnCapability,
} from "../capability-signer.js";
import { TOOL_ARGS_PREVIEW_MAX } from "../conversation-types.js";
import { JournalContextIntegrityError } from "../journal.js";
import type {
  Env,
  ChatTurnRequest,
  ChatTurnAdmissionReceipt,
  LocalTurnLease,
  AgentsView,
  HarnessExecution,
  CloudContextComponent,
} from "./types.js";
import { TERMINAL_NOTICE } from "./constants.js";

export class OwnerPurgeFenceError extends Error {}
export class OwnerFenceLeaseConflictError extends Error {}
export class OwnerFenceRegistrationUncertainError extends Error {}

/**
 * How a pi agent's report (`[Agent completed]` / `[Task failed]`) ended, and
 * its result or error, for the agent's lifecycle card.
 */
export const piReportOutcome = (
  text: string,
): { kind: "completed" | "failed" | "canceled"; body: string } => {
  const field = (name: string) => {
    const match = new RegExp(
      `(?:^|\\n)${name}: ([\\s\\S]*?)(?=\\n(?:agent_state|routing|presentation):|$)`,
    ).exec(text);
    return match?.[1]?.trim() ?? "";
  };
  if (text.startsWith("[Agent completed]"))
    return { kind: "completed", body: field("result") };
  if (
    text.startsWith("[Task canceled]") ||
    text.startsWith("[Subagent paused]")
  ) {
    return { kind: "canceled", body: field("error") };
  }
  return { kind: "failed", body: field("error") };
};

/** One list, pi's own first where both name an agent, oldest start first. */
export const listedAgents = (
  view: AgentsView,
  limit: number,
): AgentActivityEntry[] => {
  const pi = new Set(view.pi.map((agent) => agent.agentId));
  return [...view.pi, ...view.owner.filter((agent) => !pi.has(agent.agentId))]
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(0, limit);
};

/**
 * The model capability for a turn this object's own loop runs. Never called
 * for an `anthropic` execution: a Claude subscription is spent only by the
 * Claude Code CLI, whose capability its BuildSession mints.
 */
export const mintOrchestratorTurnCapability = (
  env: Env,
  turn: ChatTurnRequest,
  execution: HarnessExecution,
): Promise<MintedTurnCapability> =>
  mintTurnCapability(env, {
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    conversationId: turn.conversationId,
    execution,
    audience: turn.audience,
    budgetMicroCents: turn.budgetMicroCents,
    agentTypes: ["orchestrator"],
  });

/**
 * A Claude Code turn the BuildSession reported failed. `userMessage` is the
 * contract's user-safe failure text (e.g. a subscription limit), shown in
 * place of the generic notice; the raw detail stays in logs.
 */
export class CliTurnFailedError extends Error {
  constructor(
    message: string,
    readonly userMessage?: string,
  ) {
    super(message);
    this.name = "CliTurnFailedError";
  }
}

/**
 * The execution context a cloud turn runs under, as a resident block reads
 * it. Provider keys live on the user's devices, so the cloud has only the
 * plan for media.
 */
export const cloudExecutionContext = (
  turn: Pick<ChatTurnRequest, "audience">,
  destinations: DevicesResponse | null,
): ExecutionContextSnapshot =>
  createExecutionContextSnapshot({
    devices: destinations?.devices ?? null,
    destination: { kind: "cloud" },
    media: { stella: mediaAccessForAudience(turn.audience) },
  });

/** A Stella model as pi's `stella` provider serves it, for one agent type and audience. */
export const piModelSpec = (
  agentType: "orchestrator" | "general",
  execution: Extract<CloudExecutionSelection, { engine: "stella" }>,
  audience: ManagedModelAudience,
): import("@stella/agent/provider/stella").StellaModelSpec => {
  const descriptor = resolveManagedModelDescriptor({
    agentType,
    requestedModel: execution.model,
    audience,
  });
  return {
    agentType,
    alias: execution.model,
    protocol: descriptor.protocol,
    reasoning: descriptor.reasoning,
    supportsImages: descriptor.supportsImages,
    ...(descriptor.contextWindow !== undefined
      ? { contextWindow: descriptor.contextWindow }
      : {}),
    ...(descriptor.maxOutputTokens !== undefined
      ? { maxOutputTokens: descriptor.maxOutputTokens }
      : {}),
  };
};

/** A resume that cannot rebuild the turn's exact context fails the turn. */
export class ChatTurnNotResumableError extends Error {
  constructor(readonly reason: string) {
    super(`The interrupted turn could not be resumed (${reason}).`);
    this.name = "ChatTurnNotResumableError";
  }
}

/** Time one named step into `timings`, whether it resolves or throws. */
export const measureInto =
  (timings: Record<string, number>) =>
  async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await work();
    } finally {
      timings[name] = Math.round(performance.now() - start);
    }
  };

export const isDurableChatTurnAdmissionIntent = (
  receipt: Partial<ChatTurnAdmissionReceipt>,
): receipt is ChatTurnAdmissionReceipt =>
  receipt.schemaVersion === 2 &&
  typeof receipt.fingerprint === "string" &&
  typeof receipt.ownerId === "string" &&
  typeof receipt.ownerGeneration === "string" &&
  typeof receipt.turnId === "string" &&
  typeof receipt.leaseId === "string" &&
  (receipt.phase === "registering" || receipt.phase === "accepted") &&
  typeof receipt.createdConversation === "boolean" &&
  Number.isFinite(receipt.queuedAt) &&
  Number.isFinite(receipt.createdAt) &&
  Number.isFinite(receipt.updatedAt);

export const localTurnRetirementDeadline = (lease: LocalTurnLease): number => {
  if (!lease.cancelRequested) return lease.expiresAt;
  return Number.isFinite(lease.cancelDeadlineAt) && lease.cancelDeadlineAt! > 0
    ? lease.cancelDeadlineAt!
    : Number.POSITIVE_INFINITY;
};

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const staleOwnerGenerationResponse = (): Response =>
  json(
    {
      code: "OWNER_DATA_GENERATION_STALE",
      message: "This cloud owner generation is no longer current.",
    },
    409,
  );

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

// workerd has no Buffer; chunked so String.fromCharCode never sees an
// argument list long enough to overflow the stack.
export const base64FromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
};

/**
 * Degrades an oversize payload in place. Used only on the synchronous
 * loop-persist path, where an R2 round trip is impossible: the Agent's event
 * sink is fire-and-forget, so an `await` there would silently drop the row.
 * The async append paths spill to R2 instead and keep the full bytes.
 */
export const truncateMessage = (
  message: AgentMessage,
  limit: number,
): AgentMessage => {
  const record = message as { role?: string; content?: unknown };
  if (!Array.isArray(record.content)) return message;
  const budget = Math.max(1_000, Math.floor(limit / 2));
  let used = 0;
  const content: unknown[] = [];
  for (const block of record.content) {
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") {
      // Non-text blocks (images, tool calls) are structural: dropping a
      // toolCall would orphan its result, so they always travel.
      content.push(block);
      continue;
    }
    if (used >= budget) continue;
    const room = budget - used;
    used += text.length;
    content.push(
      text.length <= room
        ? block
        : { ...(block as object), text: `${text.slice(0, room)}\n[truncated]` },
    );
  }
  return { ...(message as object), content } as AgentMessage;
};

export class CloudContextBlockedError extends Error {
  readonly code = "CLOUD_CONTEXT_UNAVAILABLE";

  constructor(
    readonly component: CloudContextComponent,
    readonly reason: string,
  ) {
    super("Required cloud context is unavailable or failed integrity checks.");
    this.name = "CloudContextBlockedError";
  }
}

export const requireCloudContext = async <T>(
  component: CloudContextComponent,
  operation: Promise<T>,
): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof CloudContextBlockedError) throw error;
    throw new CloudContextBlockedError(component, "read_failed");
  }
};

export const cloudContextFailure = (
  error: unknown,
): {
  code: "CLOUD_CONTEXT_UNAVAILABLE";
  component: CloudContextComponent;
  repairSeq?: number;
} | null => {
  if (error instanceof JournalContextIntegrityError) {
    return {
      code: error.code,
      component: error.component,
      repairSeq: error.seq,
    };
  }
  if (error instanceof CloudContextBlockedError) {
    return { code: error.code, component: error.component };
  }
  return null;
};

export const terminalNotice = (kind: string): string =>
  (TERMINAL_NOTICE as Record<string, string>)[kind] ?? TERMINAL_NOTICE.failed;

/** Correlates a committed assistant row with the deltas that preceded it. */
export const newStreamId = (): string =>
  `as_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

export const previewArgs = (args: unknown): string => {
  try {
    return JSON.stringify(args ?? {}).slice(0, TOOL_ARGS_PREVIEW_MAX);
  } catch {
    return "";
  }
};
