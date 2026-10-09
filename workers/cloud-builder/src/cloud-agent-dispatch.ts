import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { CloudBrowserResumeReceipt } from "@stella/contracts/cloud-browser";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import {
  OWNER_EVENT_VERSION,
  type ThreadSpawnedEvent,
} from "@stella/contracts/turn-plane/owner-events";
import {
  TURN_PLANE_PROTOCOL,
  TURN_PROMPT_MAX_CHARS,
  type CloudAgentTurnSource,
  type CloudAgentTurnStartRequest,
  type CloudAgentTurnStartResponse,
} from "@stella/contracts/turn-plane/turn-start";
import type { OwnerGateAdmission } from "./owner-gate.js";
import { snapshotAllowsExecutionEngine } from "./owner-gate.js";
import { HEADER_GATE_ADMITTED } from "./turn-start-request.js";
import { parseCloudExecutionSelection } from "./turn-start-request.js";
import { sha256Hex } from "./hash.js";

export const MAX_CLOUD_AGENT_DEPTH = 2;
export const CLOUD_AGENT_DEPTH_LIMIT_ERROR =
  "Task depth limit reached (2). Complete work in the current task instead of creating another subtask.";

export type CloudAgentControlStatus =
  | "running"
  | "waiting_for_user"
  | "resuming"
  | "completed"
  | "failed"
  | "canceled";

const CLOUD_AGENT_CONTROL_STATUSES: readonly CloudAgentControlStatus[] = [
  "running",
  "waiting_for_user",
  "resuming",
  "completed",
  "failed",
  "canceled",
];

export type CloudAgentControlReceipt = {
  /** Report fixed with the terminal decision, never parsed from the wake prompt. */
  lifecycleReport?: string;
  threadId: string;
  attemptGeneration: number;
  threadUpdatedAt: number;
  status: CloudAgentControlStatus;
  turnId?: string;
  execution?: CloudExecutionSelection;
  description?: string;
  /** Set when the thread runs on one of the owner's devices, not in a BuildSession. */
  executorDeviceId?: string;
};

export type CloudAgentToolKind = "spawn_agent" | "send_message" | "pause_agent";

export type CloudAgentToolOutcome = {
  kind: CloudAgentToolKind;
  fingerprint: string;
  control: CloudAgentControlReceipt;
  disposition?:
    | "paused"
    | "pending"
    | "already_terminal"
    | "steered"
    | "resumed";
};

export type CloudAgentControlStorage = Pick<
  DurableObjectStorage,
  "get" | "put"
>;

const CLOUD_AGENT_CONTROL_PREFIX = "cloudAgentControl:";
const CLOUD_AGENT_TOOL_OUTCOME_PREFIX = "cloudAgentToolOutcome:";
const CLOUD_AGENT_DESCRIPTION_CHARS = 200;

export const cloudAgentControlKey = (threadId: string): string =>
  `${CLOUD_AGENT_CONTROL_PREFIX}${threadId}`;

export const cloudAgentToolOutcomeKey = (
  turnId: string,
  toolCallId: string,
): string => `${CLOUD_AGENT_TOOL_OUTCOME_PREFIX}${turnId}:${toolCallId}`;

export const isCloudAgentControlActive = (
  status: CloudAgentControlStatus,
): boolean => status === "running" || status === "resuming";

export const normalizeCloudAgentControlReceipt = (
  value: unknown,
): CloudAgentControlReceipt | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CloudAgentControlReceipt>;
  const threadId =
    typeof candidate.threadId === "string" ? candidate.threadId.trim() : "";
  if (
    !threadId ||
    threadId.length > 256 ||
    !Number.isSafeInteger(candidate.attemptGeneration) ||
    candidate.attemptGeneration! < 1 ||
    !Number.isSafeInteger(candidate.threadUpdatedAt) ||
    candidate.threadUpdatedAt! < 0 ||
    !CLOUD_AGENT_CONTROL_STATUSES.includes(
      candidate.status as CloudAgentControlStatus,
    )
  ) {
    return null;
  }
  const turnId =
    typeof candidate.turnId === "string" ? candidate.turnId.trim() : "";
  if (candidate.turnId !== undefined && (!turnId || turnId.length > 128)) {
    return null;
  }
  const execution =
    candidate.execution === undefined
      ? undefined
      : parseCloudExecutionSelection(candidate.execution);
  if (candidate.execution !== undefined && !execution) return null;
  const description =
    typeof candidate.description === "string"
      ? candidate.description.trim().slice(0, CLOUD_AGENT_DESCRIPTION_CHARS)
      : "";
  return {
    ...(typeof candidate.lifecycleReport === "string"
      ? { lifecycleReport: candidate.lifecycleReport }
      : {}),
    threadId,
    attemptGeneration: candidate.attemptGeneration!,
    threadUpdatedAt: candidate.threadUpdatedAt!,
    status: candidate.status as CloudAgentControlStatus,
    ...(turnId ? { turnId } : {}),
    ...(execution ? { execution } : {}),
    ...(description ? { description } : {}),
    ...(typeof candidate.executorDeviceId === "string" &&
    candidate.executorDeviceId.trim() &&
    candidate.executorDeviceId.length <= 256
      ? { executorDeviceId: candidate.executorDeviceId.trim() }
      : {}),
  };
};

export const advanceCloudAgentControlReceipt = (
  existing: CloudAgentControlReceipt | null,
  receipt: CloudAgentControlReceipt,
): CloudAgentControlReceipt => {
  if (!existing) return receipt;
  if (receipt.attemptGeneration < existing.attemptGeneration) return existing;
  // Where a thread runs never changes between attempts.
  if (
    receipt.executorDeviceId === undefined &&
    existing.executorDeviceId !== undefined
  ) {
    receipt = { ...receipt, executorDeviceId: existing.executorDeviceId };
  }
  if (receipt.attemptGeneration > existing.attemptGeneration) return receipt;
  const existingTerminal = !isCloudAgentControlActive(existing.status);
  const receiptTerminal = !isCloudAgentControlActive(receipt.status);
  const merged = (
    winner: CloudAgentControlReceipt,
  ): CloudAgentControlReceipt => ({
    ...winner,
    ...(winner.turnId === undefined && existing.turnId !== undefined
      ? { turnId: existing.turnId }
      : {}),
    ...(winner.execution === undefined && existing.execution !== undefined
      ? { execution: existing.execution }
      : {}),
    ...(winner.description === undefined && existing.description !== undefined
      ? { description: existing.description }
      : {}),
    ...(winner.executorDeviceId === undefined &&
    existing.executorDeviceId !== undefined
      ? { executorDeviceId: existing.executorDeviceId }
      : {}),
  });
  if (!existingTerminal && receiptTerminal) return merged(receipt);
  if (existingTerminal && !receiptTerminal) return existing;
  if (existingTerminal && receiptTerminal) {
    if (receipt.status !== existing.status) {
      throw new Error("A terminal cloud agent attempt cannot be rewritten.");
    }
    return receipt.threadUpdatedAt > existing.threadUpdatedAt
      ? merged(receipt)
      : existing;
  }
  return receipt.threadUpdatedAt > existing.threadUpdatedAt
    ? merged(receipt)
    : existing;
};

export const sameCloudAgentControlReceipt = (
  left: CloudAgentControlReceipt,
  right: CloudAgentControlReceipt,
): boolean =>
  left.threadId === right.threadId &&
  left.attemptGeneration === right.attemptGeneration &&
  left.threadUpdatedAt === right.threadUpdatedAt &&
  left.status === right.status;

export const rememberCloudAgentControlReceipt = async (
  storage: CloudAgentControlStorage,
  value: unknown,
): Promise<CloudAgentControlReceipt> => {
  const receipt = normalizeCloudAgentControlReceipt(value);
  if (!receipt)
    throw new Error("Cloud agent returned an invalid control receipt.");
  const key = cloudAgentControlKey(receipt.threadId);
  const rawExisting = await storage.get<unknown>(key);
  const existing = normalizeCloudAgentControlReceipt(rawExisting);
  if (rawExisting !== undefined && !existing) {
    throw new Error("Cloud agent control state is corrupt.");
  }
  const advanced = advanceCloudAgentControlReceipt(existing, receipt);
  if (advanced !== existing) await storage.put(key, advanced);
  return advanced;
};

export const readCloudAgentToolOutcome = async (args: {
  storage: CloudAgentControlStorage;
  parentTurnId: string;
  toolCallId: string;
  kind: CloudAgentToolKind;
  fingerprint: string;
}): Promise<CloudAgentToolOutcome | null> => {
  const raw = await args.storage.get<unknown>(
    cloudAgentToolOutcomeKey(args.parentTurnId, args.toolCallId),
  );
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Cloud agent tool outcome is corrupt.");
  }
  const candidate = raw as Partial<CloudAgentToolOutcome>;
  const control = normalizeCloudAgentControlReceipt(candidate.control);
  const dispositions: readonly NonNullable<
    CloudAgentToolOutcome["disposition"]
  >[] = ["paused", "pending", "already_terminal", "steered", "resumed"];
  if (
    candidate.kind !== args.kind ||
    typeof candidate.fingerprint !== "string" ||
    !candidate.fingerprint ||
    !control ||
    (candidate.disposition !== undefined &&
      !dispositions.includes(candidate.disposition))
  ) {
    throw new Error("Cloud agent tool outcome is corrupt.");
  }
  if (candidate.fingerprint !== args.fingerprint) {
    throw new Error("That cloud agent tool call was replayed differently.");
  }
  await rememberCloudAgentControlReceipt(args.storage, control);
  return {
    kind: args.kind,
    fingerprint: args.fingerprint,
    control,
    ...(candidate.disposition ? { disposition: candidate.disposition } : {}),
  };
};

export const commitCloudAgentToolOutcome = async (args: {
  storage: CloudAgentControlStorage;
  parentTurnId: string;
  toolCallId: string;
  kind: CloudAgentToolKind;
  fingerprint: string;
  value: unknown;
  disposition?: CloudAgentToolOutcome["disposition"];
}): Promise<CloudAgentToolOutcome> => {
  const existingOutcome = await readCloudAgentToolOutcome(args);
  if (existingOutcome) return existingOutcome;
  const receipt = normalizeCloudAgentControlReceipt(args.value);
  if (!receipt)
    throw new Error("Cloud agent returned an invalid control receipt.");
  const controlKey = cloudAgentControlKey(receipt.threadId);
  const rawExisting = await args.storage.get<unknown>(controlKey);
  const existing = normalizeCloudAgentControlReceipt(rawExisting);
  if (rawExisting !== undefined && !existing) {
    throw new Error("Cloud agent control state is corrupt.");
  }
  const control = advanceCloudAgentControlReceipt(existing, receipt);
  const outcome: CloudAgentToolOutcome = {
    kind: args.kind,
    fingerprint: args.fingerprint,
    control: receipt,
    ...(args.disposition ? { disposition: args.disposition } : {}),
  };
  await args.storage.put({
    [controlKey]: control,
    [cloudAgentToolOutcomeKey(args.parentTurnId, args.toolCallId)]: outcome,
  });
  return outcome;
};

export const requireCloudAgentControlReceipt = async (args: {
  storage: CloudAgentControlStorage;
  threadId: string;
}): Promise<CloudAgentControlReceipt> => {
  const threadId = args.threadId.trim();
  if (!threadId || threadId.length > 256) {
    throw new Error("A valid cloud agent thread id is required.");
  }
  const raw = await args.storage.get<unknown>(cloudAgentControlKey(threadId));
  const receipt = normalizeCloudAgentControlReceipt(raw);
  if (!receipt || receipt.threadId !== threadId) {
    throw new Error(
      `No exact control receipt is available for ${threadId}. Wait for its latest lifecycle update and try again.`,
    );
  }
  return receipt;
};

export type CloudAgentDispatchCaller = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  /** Absent for a desktop dispatch: no cloud turn sits above it. */
  parentTurnId?: string;
  parentThreadId?: string;
  agentDepth: number;
}>;

export type CloudAgentDispatchAttempt = Readonly<{
  threadId: string;
  attemptGeneration: number;
  turnId: string;
  clientMsgId: string;
  description: string;
  prompt: string;
  execution: CloudExecutionSelection;
  /** Defaults to `agent-thread`; a desktop's own dispatch is `desktop`. */
  source?: CloudAgentTurnSource;
  /** The desktop and local conversation that receive a desktop dispatch's result. */
  originDeviceId?: string;
  originConversationId?: string;
  /** Hosted-browser resume receipt carried into this attempt. */
  browserResume?: CloudBrowserResumeReceipt;
}>;

/** A refusal that trying again cannot fix (admission said no, or the request was bad). */
export class CloudAgentDispatchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAgentDispatchRefused";
  }
}

type CloudAgentDispatchEnv = Pick<
  Cloudflare.Env,
  "BUILD_SESSIONS" | "ORCHESTRATOR_SESSIONS"
> &
  Partial<Pick<Cloudflare.Env, "CLOUD_BUILDER_PUBLIC_URL">>;

export type CloudAgentDispatchDependencies = Readonly<{
  env: CloudAgentDispatchEnv;
  /**
   * Start an attempt that runs as its conversation's pi agent. Defaults to
   * the conversation's object; the conversation itself starts it in place.
   */
  startPiThread?: (input: PiThreadStart) => Promise<void>;
  ownerGateAdmit: (input: {
    ownerId: string;
    turnId: string;
    conversationId: string;
    expectedGeneration: string;
  }) => Promise<OwnerGateAdmission>;
  releaseOwnerGate: (input: {
    ownerId: string;
    turnId: string;
  }) => Promise<void>;
  deliverOwnerEvents: (events: readonly ThreadSpawnedEvent[]) => Promise<void>;
  now?: () => number;
}>;

export const toolScopedId = async (args: {
  ownerGeneration: string;
  parentTurnId: string;
  purpose: "thread" | "turn" | "message";
  toolCallId: string;
}): Promise<string> => {
  const hex = await sha256Hex(
    `cloud-agent\0${args.purpose}\0${args.ownerGeneration}\0${args.parentTurnId}\0${args.toolCallId}`,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const toolFingerprint = async (args: {
  ownerGeneration: string;
  parentTurnId: string;
  kind: CloudAgentToolKind;
  semanticInput: unknown;
}): Promise<string> =>
  await sha256Hex(
    JSON.stringify([
      "cloud-agent-tool/v1",
      args.ownerGeneration,
      args.parentTurnId,
      args.kind,
      args.semanticInput,
    ]),
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const dispatchCloudAgentTurn = async (args: {
  dependencies: CloudAgentDispatchDependencies;
  caller: CloudAgentDispatchCaller;
  attempt: CloudAgentDispatchAttempt;
  signal?: AbortSignal;
}): Promise<CloudAgentControlReceipt> => {
  const { dependencies, caller, attempt } = args;
  const agentDepth = caller.agentDepth + 1;
  if (agentDepth > MAX_CLOUD_AGENT_DEPTH) {
    throw new Error(CLOUD_AGENT_DEPTH_LIMIT_ERROR);
  }
  const admission = await dependencies.ownerGateAdmit({
    ownerId: caller.ownerId,
    turnId: attempt.turnId,
    conversationId: caller.conversationId,
    expectedGeneration: caller.ownerGeneration,
  });
  if (!admission.ok) {
    throw admission.retryable
      ? new Error(admission.message)
      : new CloudAgentDispatchRefused(admission.message);
  }
  const ownerSnapshot = admission.snapshot;
  const release = () =>
    dependencies.releaseOwnerGate({
      ownerId: caller.ownerId,
      turnId: attempt.turnId,
    });
  if (!snapshotAllowsExecutionEngine(ownerSnapshot, attempt.execution.engine)) {
    await release();
    throw new CloudAgentDispatchRefused(
      attempt.execution.engine === "anthropic"
        ? "Connect Claude before using that cloud execution route."
        : "Connect ChatGPT before using that cloud execution route.",
    );
  }
  if (runsAsPiAgent(attempt.execution)) {
    // Admitted above only so a refusal (the plan, the owner's limits)
    // reaches the caller now: pi admits each of its runs on the agent lane.
    await release();
    const start: PiThreadStart = {
      ownerId: caller.ownerId,
      ownerGeneration: caller.ownerGeneration,
      conversationId: caller.conversationId,
      audience: ownerSnapshot.allowance.audience,
      budgetMicroCents: ownerSnapshot.allowance.budgetMicroCents,
      execution: attempt.execution,
      prompt: attempt.prompt,
      attempt: {
        threadId: attempt.threadId,
        description: attempt.description,
        turnId: attempt.turnId,
        attemptGeneration: attempt.attemptGeneration,
        ...(attempt.originDeviceId
          ? { originDeviceId: attempt.originDeviceId }
          : {}),
      },
    };
    try {
      await (dependencies.startPiThread
        ? dependencies.startPiThread(start)
        : dependencies.env.ORCHESTRATOR_SESSIONS.getByName(
            caller.conversationId,
          ).startPiThread(start));
    } catch (error) {
      throw new Error(
        `Starting the agent failed: ${errorMessage(error)}`.slice(0, 400),
      );
    }
    return await projectSpawnedAttempt(dependencies, caller, attempt, agentDepth);
  }
  const publicOrigin = (dependencies.env.CLOUD_BUILDER_PUBLIC_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!publicOrigin) {
    await release();
    throw new Error(
      "Cloud agents are unavailable: the builder's public origin is not configured.",
    );
  }
  const payload: CloudAgentTurnStartRequest = {
    protocol: TURN_PLANE_PROTOCOL,
    kind: "agent",
    ownerId: caller.ownerId,
    ownerGeneration: caller.ownerGeneration,
    conversationId: caller.conversationId,
    threadId: attempt.threadId,
    ...(caller.parentThreadId ? { parentThreadId: caller.parentThreadId } : {}),
    agentDepth,
    attemptGeneration: attempt.attemptGeneration,
    turnId: attempt.turnId,
    prompt: attempt.prompt,
    description: attempt.description,
    execution: attempt.execution,
    audience: ownerSnapshot.allowance.audience,
    budgetMicroCents: ownerSnapshot.allowance.budgetMicroCents,
    source: attempt.source ?? "agent-thread",
    clientMsgId: attempt.clientMsgId,
    ...(caller.parentTurnId ? { parentTurnId: caller.parentTurnId } : {}),
    ...(attempt.originDeviceId ? { originDeviceId: attempt.originDeviceId } : {}),
    ...(attempt.originConversationId
      ? { originConversationId: attempt.originConversationId }
      : {}),
    ...(attempt.browserResume ? { browserResume: attempt.browserResume } : {}),
  };
  let response: Response;
  try {
    response = await dependencies.env.BUILD_SESSIONS.getByName(
      attempt.threadId,
    ).fetch("https://build-session/turn", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stella-build-session-name": attempt.threadId,
        "x-stella-turn-broker-endpoint": `${publicOrigin}/sessions/${encodeURIComponent(attempt.threadId)}/turn-broker`,
        [HEADER_GATE_ADMITTED]: "1",
      },
      body: JSON.stringify(payload),
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    await release();
    throw new Error(
      `Spawning the agent failed: ${errorMessage(error)}`.slice(0, 400),
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
    };
    await release();
    const detail =
      typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : `Spawning the agent failed (${response.status}).`;
    throw response.status >= 500 || response.status === 429
      ? new Error(detail)
      : new CloudAgentDispatchRefused(detail);
  }
  const accepted = (await response
    .json()
    .catch(() => null)) as Partial<CloudAgentTurnStartResponse> | null;
  if (
    accepted &&
    ((typeof accepted.turnId === "string" &&
      accepted.turnId !== attempt.turnId) ||
      (typeof accepted.attemptGeneration === "number" &&
        accepted.attemptGeneration !== attempt.attemptGeneration))
  ) {
    await release();
    throw new Error(
      `${attempt.threadId} was continued while this request was in flight. Refresh its status and try again.`,
    );
  }
  return await projectSpawnedAttempt(dependencies, caller, attempt, agentDepth);
};

/** The owner's agent threads learn of a started attempt; the receipt its starter keeps. */
const projectSpawnedAttempt = async (
  dependencies: CloudAgentDispatchDependencies,
  caller: CloudAgentDispatchCaller,
  attempt: CloudAgentDispatchAttempt,
  agentDepth: number,
): Promise<CloudAgentControlReceipt> => {
  const now = (dependencies.now ?? Date.now)();
  await dependencies.deliverOwnerEvents([
    {
      v: OWNER_EVENT_VERSION,
      key: `${attempt.threadId}:${attempt.attemptGeneration}`,
      ownerId: caller.ownerId,
      ownerGeneration: caller.ownerGeneration,
      emittedAt: now,
      kind: "thread.spawned",
      threadId: attempt.threadId,
      conversationId: caller.conversationId,
      parentTurnId: caller.parentTurnId ?? attempt.turnId,
      ...(attempt.originDeviceId ? { originDeviceId: attempt.originDeviceId } : {}),
      ...(attempt.originConversationId
        ? { originConversationId: attempt.originConversationId }
        : {}),
      ...(caller.parentThreadId
        ? { parentThreadId: caller.parentThreadId }
        : {}),
      agentDepth,
      attemptGeneration: attempt.attemptGeneration,
      description: attempt.description,
      prompt: attempt.prompt,
      execution: attempt.execution,
      placement: "cloud",
      createdAt: now,
    },
  ]);
  return {
    threadId: attempt.threadId,
    attemptGeneration: attempt.attemptGeneration,
    threadUpdatedAt: now,
    status: "running",
    turnId: attempt.turnId,
    execution: attempt.execution,
    description: attempt.description,
  };
};

/** Whether an attempt on this execution runs as its conversation's pi agent rather than in a container. */
export const runsAsPiAgent = (
  execution: CloudExecutionSelection,
): execution is Extract<CloudExecutionSelection, { engine: "stella" }> =>
  execution.engine === "stella";

/**
 * One attempt of an agent thread the owner's agent threads track (a Claude
 * Code orchestrator's spawn, a computer's cloud dispatch, a placed agent)
 * that runs on Stella's models, as its conversation's pi agent.
 */
export type PiThreadAttempt = Readonly<{
  threadId: string;
  description: string;
  /** The attempt's turn id in the agent threads (a placed agent's dispatch id). */
  turnId: string;
  attemptGeneration: number;
  /** A computer's dispatch: its report reaches that computer through the agent threads, not a wake here. */
  originDeviceId?: string;
}>;

/**
 * Start one attempt in its conversation (`OrchestratorSession.startPiThread`)
 * on the authority its dispatcher admitted: the owner's plan audience and
 * budget, and the attempt's Stella execution.
 */
export type PiThreadStart = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  audience: ManagedModelAudience;
  budgetMicroCents: number;
  execution: Extract<CloudExecutionSelection, { engine: "stella" }>;
  prompt: string;
  attempt: PiThreadAttempt;
}>;

/** New input for a running pi agent of an agent thread (`OrchestratorSession.steerPiThread`). */
export type PiThreadSteer = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  threadId: string;
  messageId: string;
  text: string;
}>;

/**
 * `unknown`: no agent of that thread runs in the conversation. An agent in a
 * container takes no input while it works.
 */
export type PiThreadSteerResult =
  | Readonly<{ accepted: true; turnId: string; attemptGeneration: number }>
  | Readonly<{ accepted: false; reason: "not_running" | "unknown" }>;

/** Pause one exact attempt of an agent thread's pi agent (`OrchestratorSession.pausePiThread`). */
export type PiThreadPause = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
}>;

/**
 * `paused`: it is stopping, and its attempt settles as canceled.
 * `terminal`: that attempt already settled. `changed`: another attempt is
 * the thread's now. `unknown`: no agent of that thread runs there.
 */
export type PiThreadPauseResult = "paused" | "terminal" | "changed" | "unknown";

/**
 * New input for a cloud agent's running attempt. Only an agent on Stella's
 * models (its conversation's pi agent) takes input while it works; one in a
 * container (`unknown` there) does not.
 */
export const steerCloudAgent = async (
  args: PiThreadSteer & {
    env: Pick<Cloudflare.Env, "ORCHESTRATOR_SESSIONS">;
    conversationId: string;
  },
): Promise<PiThreadSteerResult> =>
  await args.env.ORCHESTRATOR_SESSIONS.getByName(
    args.conversationId,
  ).steerPiThread({
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    threadId: args.threadId,
    messageId: args.messageId,
    text: args.text,
  });

/**
 * Stop one exact attempt of a cloud agent: its conversation's pi agent, or
 * else its BuildSession. `changed` means it is no longer that attempt.
 */
export const cancelCloudAgentAttempt = async (args: {
  env: Pick<Cloudflare.Env, "BUILD_SESSIONS" | "ORCHESTRATOR_SESSIONS">;
  conversationId: string;
  threadId: string;
  ownerId: string;
  ownerGeneration: string;
  turnId: string;
  attemptGeneration: number;
  cancelRequestId: string;
  reason: string;
}): Promise<"canceled" | "changed"> => {
  const paused = await args.env.ORCHESTRATOR_SESSIONS.getByName(
    args.conversationId,
  ).pausePiThread({
    ownerId: args.ownerId,
    ownerGeneration: args.ownerGeneration,
    threadId: args.threadId,
    turnId: args.turnId,
    attemptGeneration: args.attemptGeneration,
  });
  if (paused === "changed") return "changed";
  if (paused !== "unknown") return "canceled";
  const response = await args.env.BUILD_SESSIONS.getByName(args.threadId).fetch(
    "https://build-session/cancel",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        turnId: args.turnId,
        attemptGeneration: args.attemptGeneration,
        cancelRequestId: args.cancelRequestId,
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    },
  );
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 409) return "changed";
  if (!response.ok) {
    throw new Error(`Stopping the agent failed (${response.status}).`);
  }
  return "canceled";
};

export const agentLifecycleReport = (completion: {
  resultJson?: string;
  errorMessage?: string;
}): string => {
  let resultText = completion.errorMessage ?? "";
  if (completion.resultJson) {
    try {
      const parsed = JSON.parse(completion.resultJson) as {
        finalText?: unknown;
      };
      resultText =
        typeof parsed.finalText === "string" && parsed.finalText.trim()
          ? parsed.finalText
          : completion.resultJson;
    } catch {
      resultText = completion.resultJson;
    }
  }
  return resultText || "No result was reported.";
};

/** The hidden prompt that hands one finished thread to its requester. */
export const agentCompletionPromptText = (args: {
  threadId: string;
  description?: string;
  status: "completed" | "failed" | "canceled";
  resultJson?: string;
  errorMessage?: string;
}): string => {
  const resultText = agentLifecycleReport(args);
  const label =
    args.status === "completed"
      ? "[Agent completed]"
      : args.status === "canceled"
        ? "[Agent canceled]"
        : "[Agent failed]";
  const description = args.description?.trim() || args.threadId;
  return `${label} ${description} (thread ${args.threadId})\n\n${resultText}`;
};

export const agentStatusResult = (
  control: CloudAgentControlReceipt,
  now: number = Date.now(),
): AgentToolResult<unknown> => {
  const active = isCloudAgentControlActive(control.status);
  const status = active ? "active" : "paused";
  const lastActiveAt = new Date(control.threadUpdatedAt).toISOString();
  const currentTime = new Date(now).toISOString();
  const terminal =
    control.status === "completed" ||
    control.status === "failed" ||
    control.status === "canceled";
  // This is the same bounded, exact-attempt report carried by the queued
  // lifecycle wake. Expose it to a polling parent before that wake can run.
  const report = terminal
    ? control.lifecycleReport?.slice(0, TURN_PROMPT_MAX_CHARS)
    : undefined;
  const reportTruncated =
    terminal && (control.lifecycleReport?.length ?? 0) > TURN_PROMPT_MAX_CHARS;
  const text = [
    `Thread ${control.threadId}: ${status} (${control.status}).`,
    control.description ? `Description: ${control.description}.` : "",
    `Last lifecycle change: ${lastActiveAt}. Current time: ${currentTime}.`,
    active
      ? "It is executing a turn right now; its report arrives as an [Agent completed] message. This snapshot did not interrupt it."
      : report !== undefined
        ? "This attempt is finished; its report is included below. No follow-up is needed to retrieve it. This snapshot did not message it."
        : "It is idle; send_message resumes it with its history. This snapshot did not message it.",
    report !== undefined ? `Report for this attempt:\n${report}${reportTruncated ? "\n[Report truncated]" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    content: [{ type: "text", text }],
    details: {
      thread_id: control.threadId,
      status,
      status_detail: control.status,
      ...(control.description ? { description: control.description } : {}),
      last_active_at: lastActiveAt,
      attempt_generation: control.attemptGeneration,
      current_time: currentTime,
      ...(report !== undefined ? { result: report } : {}),
      ...(reportTruncated ? { result_truncated: true } : {}),
      note: "Read-only snapshot; the agent was NOT interrupted or messaged. To steer or ask it something, use send_message.",
    },
  };
};

export const pauseResult = (
  control: CloudAgentControlReceipt,
  disposition: "paused" | "pending" | "already_terminal",
): AgentToolResult<unknown> => ({
  content: [
    {
      type: "text",
      text:
        disposition === "pending"
          ? `Pause requested for ${control.threadId}. It is stopping now and can be resumed later with send_message.`
          : disposition === "already_terminal"
            ? `${control.threadId} had already stopped. Resume it later with send_message.`
            : `Paused ${control.threadId}. Resume it later with send_message.`,
    },
  ],
  details: {
    thread_id: control.threadId,
    canceled: true,
    attempt_generation: control.attemptGeneration,
    thread_updated_at: control.threadUpdatedAt,
  },
});
