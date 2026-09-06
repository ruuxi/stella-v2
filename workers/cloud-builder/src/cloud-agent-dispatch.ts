import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  OUTBOX_EVENT_VERSION,
  type ThreadSpawnedEvent,
} from "@stella/contracts/turn-plane/outbox";
import {
  TURN_PLANE_PROTOCOL,
  TURN_PROMPT_MAX_CHARS,
  type CloudAgentSteerMessage,
  type CloudAgentTurnStartRequest,
  type CloudAgentTurnStartResponse,
  type CloudAgentWorkspace,
} from "@stella/contracts/turn-plane/turn-start";
import type { OwnerGateAdmission } from "./owner-gate.js";
import { snapshotAllowsExecutionEngine } from "./owner-gate.js";
import { HEADER_GATE_ADMITTED } from "./turn-start-request.js";
import { parseCloudExecutionSelection } from "./turn-start-request.js";
import { sha256Hex } from "./hash.js";
import { worldName } from "./workspace.js";

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
  workspace?: CloudAgentWorkspace;
  workspaceForkId?: string;
};

export type CloudAgentToolKind = "spawn_agent" | "send_input" | "pause_agent";

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
  const workspace =
    candidate.workspace === "shared" ||
    candidate.workspace === "new" ||
    candidate.workspace === "fork"
      ? candidate.workspace
      : undefined;
  const workspaceForkId =
    typeof candidate.workspaceForkId === "string" &&
    /^fork-[0-9a-f-]{36}$/u.test(candidate.workspaceForkId)
      ? candidate.workspaceForkId
      : undefined;
  if (
    (workspaceForkId !== undefined &&
      workspace !== "new" &&
      workspace !== "fork") ||
    ((workspace === "new" || workspace === "fork") &&
      workspaceForkId === undefined)
  ) {
    return null;
  }
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
    ...(workspace ? { workspace } : {}),
    ...(workspaceForkId ? { workspaceForkId } : {}),
  };
};

export const advanceCloudAgentControlReceipt = (
  existing: CloudAgentControlReceipt | null,
  receipt: CloudAgentControlReceipt,
): CloudAgentControlReceipt => {
  if (!existing) return receipt;
  if (receipt.attemptGeneration < existing.attemptGeneration) return existing;
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
  parentTurnId: string;
  parentThreadId?: string;
  agentDepth: number;
  workspaceForkId?: string;
}>;

export type CloudAgentDispatchAttempt = Readonly<{
  threadId: string;
  attemptGeneration: number;
  turnId: string;
  clientMsgId: string;
  description: string;
  prompt: string;
  execution: CloudExecutionSelection;
  workspace?: CloudAgentWorkspace;
  workspaceForkId?: string;
}>;

type CloudAgentDispatchEnv = Pick<Cloudflare.Env, "BUILD_SESSIONS" | "WORLDS"> &
  Partial<Pick<Cloudflare.Env, "CLOUD_BUILDER_PUBLIC_URL">>;

export type CloudAgentDispatchDependencies = Readonly<{
  env: CloudAgentDispatchEnv;
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
  enqueueOutbox: (events: readonly ThreadSpawnedEvent[]) => Promise<void>;
  now?: () => number;
}>;

export const toolScopedId = async (args: {
  ownerGeneration: string;
  parentTurnId: string;
  purpose: "thread" | "turn";
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
  const workspace = attempt.workspace ?? "shared";
  if (workspace !== "shared" && workspace !== "new" && workspace !== "fork") {
    throw new Error("Cloud agent workspace is invalid.");
  }
  if (
    attempt.workspaceForkId !== undefined &&
    !/^fork-[0-9a-f-]{36}$/u.test(attempt.workspaceForkId)
  ) {
    throw new Error("Cloud agent workspace fork id is invalid.");
  }
  if (workspace === "shared" && attempt.workspaceForkId !== undefined) {
    throw new Error("A shared cloud agent cannot name a workspace fork.");
  }
  const admission = await dependencies.ownerGateAdmit({
    ownerId: caller.ownerId,
    turnId: attempt.turnId,
    conversationId: caller.conversationId,
    expectedGeneration: caller.ownerGeneration,
  });
  if (!admission.ok) throw new Error(admission.message);
  const ownerSnapshot = admission.snapshot;
  const release = () =>
    dependencies.releaseOwnerGate({
      ownerId: caller.ownerId,
      turnId: attempt.turnId,
    });
  if (!snapshotAllowsExecutionEngine(ownerSnapshot, attempt.execution.engine)) {
    await release();
    throw new Error(
      attempt.execution.engine === "anthropic"
        ? "Connect Claude before using that cloud execution route."
        : "Connect ChatGPT before using that cloud execution route.",
    );
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
  const now = (dependencies.now ?? Date.now)();
  let workspaceForkId = attempt.workspaceForkId;
  if (workspace !== "shared" && !workspaceForkId) {
    try {
      workspaceForkId = (
        await dependencies.env.WORLDS.getByName(
          await worldName(caller.ownerId),
        ).fork({
          kind: workspace,
          threadId: attempt.threadId,
          ...(workspace === "fork"
            ? { from: caller.workspaceForkId ?? "shared" }
            : {}),
        })
      ).forkId;
    } catch (error) {
      await release();
      throw new Error(
        `Creating the isolated workspace failed: ${errorMessage(error)}`.slice(
          0,
          400,
        ),
      );
    }
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
    source: "agent-thread",
    clientMsgId: attempt.clientMsgId,
    parentTurnId: caller.parentTurnId,
    workspace,
    ...(workspaceForkId ? { workspaceForkId } : {}),
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
    throw new Error(detail);
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
  await dependencies.enqueueOutbox([
    {
      v: OUTBOX_EVENT_VERSION,
      key: `${attempt.threadId}:${attempt.attemptGeneration}`,
      ownerId: caller.ownerId,
      ownerGeneration: caller.ownerGeneration,
      emittedAt: now,
      kind: "thread.spawned",
      threadId: attempt.threadId,
      conversationId: caller.conversationId,
      parentTurnId: caller.parentTurnId,
      ...(caller.parentThreadId
        ? { parentThreadId: caller.parentThreadId }
        : {}),
      agentDepth,
      attemptGeneration: attempt.attemptGeneration,
      description: attempt.description,
      prompt: attempt.prompt,
      execution: attempt.execution,
      placement: "cloud",
      workspace,
      ...(workspaceForkId ? { workspaceForkId } : {}),
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
    workspace,
    ...(workspaceForkId ? { workspaceForkId } : {}),
  };
};

export type SteerAgentResult =
  | Readonly<{
      accepted: true;
      turnId: string;
      attemptGeneration: number;
    }>
  | Readonly<{ accepted: false; reason: "not_running" }>;

export const steerCloudAgent = async (args: {
  env: Pick<Cloudflare.Env, "BUILD_SESSIONS">;
  threadId: string;
  message: CloudAgentSteerMessage;
  signal?: AbortSignal;
}): Promise<SteerAgentResult> => {
  const response = await args.env.BUILD_SESSIONS.getByName(args.threadId).fetch(
    "https://build-session/steer",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args.message),
      ...(args.signal ? { signal: args.signal } : {}),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    accepted?: unknown;
    reason?: unknown;
    turnId?: unknown;
    attemptGeneration?: unknown;
  } | null;
  if (
    response.status === 409 &&
    body?.accepted === false &&
    body.reason === "not_running"
  ) {
    return { accepted: false, reason: "not_running" };
  }
  if (
    !response.ok ||
    body?.accepted !== true ||
    typeof body.turnId !== "string" ||
    !Number.isSafeInteger(body.attemptGeneration)
  ) {
    throw new Error(`Could not steer ${args.threadId} (${response.status}).`);
  }
  return {
    accepted: true,
    turnId: body.turnId,
    attemptGeneration: body.attemptGeneration as number,
  };
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
        : "It is idle; send_input resumes it with its history. This snapshot did not message it.",
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
      note: "Read-only snapshot; the agent was NOT interrupted or messaged. To steer or ask it something, use send_input.",
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
          ? `Pause requested for ${control.threadId}. It is stopping now and can be resumed later with send_input.`
          : disposition === "already_terminal"
            ? `${control.threadId} had already stopped. Resume it later with send_input.`
            : `Paused ${control.threadId}. Resume it later with send_input.`,
    },
  ],
  details: {
    thread_id: control.threadId,
    canceled: true,
    attempt_generation: control.attemptGeneration,
    thread_updated_at: control.threadUpdatedAt,
  },
});
