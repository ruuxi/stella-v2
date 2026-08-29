/**
 * The boundary of a cloud general-agent turn: what a turn is, where it runs,
 * and what a completed one is allowed to have made durable.
 *
 * `selectGeneralAgentTurnPlan` is the only engine-placement branch in the
 * system. A Stella turn with no browser handoff runs its agent loop right here
 * in the Durable Object, the pattern `OrchestratorSession` already proves in
 * workerd; every other turn keeps today's eager-container executor path
 * byte-for-byte. The decision is persisted at admission as a reasoned
 * `TurnComputePlan` so a config flip cannot re-place a turn that is already
 * running, and so alarm recovery reads a fact instead of re-deriving a guess
 * from an environment that may have changed underneath it.
 *
 * Nothing here is wired into admission yet. The resident loop below is
 * exercised by tests; production still runs the container path.
 */

import { Agent } from "@stella/runtime/kernel/agent-core/agent.js";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { Api, Model } from "@stella/runtime/ai/types.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentRunWithRetry,
  prepareTransientResumeTail,
} from "@stella/runtime/kernel/agent-runtime/run-retry.js";
import {
  buildDefaultTransformContext,
  getAgentCompletion,
} from "@stella/runtime/kernel/agent-runtime/run-shared.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import {
  isCloudBrowserResumeReceipt,
  type CloudBrowserResumeReceipt,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import type { TurnBrokerTurnStateCheckpointReceipt } from "@stella/contracts/turn-credential-broker";
import { parseAuthoritativeAgentHistory } from "@stella/executor-cloud/agent-history";
import { pruneAgentHistory } from "@stella/executor-cloud/prune-history";
import {
  buildGeneralAgentPrompt,
  type GeneralAgentPromptSkills,
} from "@stella/executor-cloud/general-agent-prompt";
import {
  createCloudRelayModel,
  resolveCloudThinkingLevel,
} from "@stella/executor-cloud/relay-model";
import type {
  CanonicalTranscriptReceipt,
  GeneralAgentControlPlane,
} from "./agent-control-plane.js";
import { AgentTurnJournal } from "./agent-turn-journal.js";
import type { SealedTurnTranscript } from "./agent-turn-journal.js";
import type { TurnExecutionContext } from "./turn-cancellation.js";
import { assertTurnExecutionActive } from "./turn-cancellation.js";

export type { CanonicalTranscriptReceipt } from "./agent-control-plane.js";

export type TrustedTurnBrokerRoute = Readonly<{
  sessionId: string;
  endpoint: string;
}>;

export type GeneralAgentTurnIdentity = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  threadId: string;
  turnId: string;
  attemptGeneration: number;
}>;

export type GeneralAgentTurnRequest = Readonly<{
  kind: "agent";
  identity: GeneralAgentTurnIdentity;
  prompt: string;
  turnToken: string;
  convexCallbackBase: string;
  /**
   * Derived from trusted outer-router headers; the JSON body cannot set it. A
   * resident turn keeps it because a later tool may still attach a container.
   */
  brokerRoute: TrustedTurnBrokerRoute;
  execution: CloudExecutionSelection;
  browserResume?: CloudBrowserResumeReceipt;
  watchdogMs: number;
}>;

export type StellaExecution = Extract<
  CloudExecutionSelection,
  { engine: "stella" }
>;

export type NativeExecution = Extract<
  CloudExecutionSelection,
  { engine: "anthropic" | "openai-codex" }
>;

export type GeneralAgentTurnPlan =
  | Readonly<{
      kind: "resident_stella";
      execution: StellaExecution;
    }>
  | Readonly<{
      kind: "native_sandbox";
      execution: NativeExecution | StellaExecution;
      reason: "native_engine" | "browser_resume" | "resident_disabled";
    }>
  /**
   * The one placement the selector never returns. It belongs to an attempt
   * that re-enters the runner with no admitted plan to read, which after this
   * stack means a turn admitted before the ladder shipped or a lost storage
   * row. Such an attempt already holds an eagerly reserved container, so it
   * keeps the path it was admitted onto, and it may carry no engine selection
   * at all.
   */
  | Readonly<{
      kind: "native_sandbox";
      execution?: CloudExecutionSelection;
      reason: "unplaced";
    }>;

/**
 * What a turn was allowed to make durable. Closed so no caller has to decide
 * whether an archive upload is legal by inspecting optional fields: a resident
 * success has a canonical transcript and no workspace receipt, an attached
 * success has both, a preflight failure has neither.
 */
export type TurnDurability =
  | Readonly<{
      kind: "none";
      reason: "preflight_failed" | "canceled" | "sandbox_lost";
    }>
  | Readonly<{
      kind: "transcript_only";
      transcript: CanonicalTranscriptReceipt;
    }>
  | Readonly<{
      kind: "workspace_checkpoint";
      transcript: CanonicalTranscriptReceipt;
      checkpoint: TurnBrokerTurnStateCheckpointReceipt;
    }>;

export type TurnComputeUse =
  | Readonly<{ kind: "resident" }>
  | Readonly<{
      kind: "sandbox";
      reason:
        "native_engine" | "process_tool" | "filesystem_tool" | "interior_build";
      instanceSize: "small" | "large";
      coldStartMs: number;
      restoreMs: number;
    }>;

export type TurnUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
}>;

export type GeneralAgentTurnResult =
  | Readonly<{
      outcome: "completed";
      ok: true;
      finalText: string;
      usage: TurnUsage;
      compute: TurnComputeUse;
      durability: Exclude<TurnDurability, { kind: "none" }>;
    }>
  | Readonly<{
      outcome: "failed";
      ok: false;
      error: string;
      usage: TurnUsage;
      compute: TurnComputeUse;
      durability: TurnDurability;
    }>
  | Readonly<{
      outcome: "suspended";
      ok: false;
      suspension: CloudBrowserSuspension;
      usage: TurnUsage;
      compute: TurnComputeUse;
      durability: Exclude<TurnDurability, { kind: "none" }>;
    }>;

/**
 * The admitted placement, with the facts that produced it. Persisted before
 * the turn runs so recovery reads a decision rather than re-deriving one from
 * an environment that may have changed since.
 */
export type TurnComputePlan = Readonly<{
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  plan: GeneralAgentTurnPlan;
  engine: CloudExecutionSelection["engine"];
  browserResume: boolean;
  residentDisabled: boolean;
  decidedAt: number;
}>;

const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_FIELD_LENGTH = 2048;

const boundedText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= MAX_FIELD_LENGTH;

const executionSelection = (
  value: unknown,
): CloudExecutionSelection | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (
    !boundedText(row.model) ||
    typeof row.reasoningEffort !== "string" ||
    !boundedText(row.reasoningEffort)
  ) {
    return undefined;
  }
  const pair = `${String(row.engine)}/${String(row.provider)}`;
  if (
    pair !== "stella/stella" &&
    pair !== "anthropic/anthropic" &&
    pair !== "openai-codex/openai-codex"
  ) {
    return undefined;
  }
  return row as unknown as CloudExecutionSelection;
};

export class GeneralAgentTurnRequestError extends Error {
  constructor(readonly field: string) {
    super(`Agent turn request field ${field} is invalid.`);
    this.name = "GeneralAgentTurnRequestError";
  }
}

/**
 * The guard at the system boundary. `brokerRoute` is a separate argument
 * because it comes from trusted outer-router headers: accepting it from the
 * body would let a caller name the broker session its turn talks to.
 *
 * Shaped against the exact record admission already validates and stores, so
 * wiring this in is a substitution rather than a second contract.
 */
export const parseGeneralAgentTurnRequest = (args: {
  body: unknown;
  brokerRoute: TrustedTurnBrokerRoute;
  defaultWatchdogMs: number;
}): GeneralAgentTurnRequest => {
  const body = args.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GeneralAgentTurnRequestError("body");
  }
  const row = body as Record<string, unknown>;
  if (row.kind !== "agent") throw new GeneralAgentTurnRequestError("kind");
  for (const field of [
    "ownerId",
    "ownerGeneration",
    "threadId",
    "turnId",
    "turnToken",
    "convexCallbackBase",
  ] as const) {
    if (!boundedText(row[field])) {
      throw new GeneralAgentTurnRequestError(field);
    }
  }
  if (
    typeof row.prompt !== "string" ||
    new TextEncoder().encode(row.prompt).byteLength > MAX_PROMPT_BYTES
  ) {
    throw new GeneralAgentTurnRequestError("prompt");
  }
  if (
    !Number.isSafeInteger(row.attemptGeneration) ||
    (row.attemptGeneration as number) < 1
  ) {
    throw new GeneralAgentTurnRequestError("attemptGeneration");
  }
  const execution = executionSelection(row.execution);
  if (!execution) throw new GeneralAgentTurnRequestError("execution");
  if (
    row.browserResume !== undefined &&
    !isCloudBrowserResumeReceipt(row.browserResume)
  ) {
    throw new GeneralAgentTurnRequestError("browserResume");
  }
  const watchdogMs =
    row.watchdogMs === undefined ? args.defaultWatchdogMs : row.watchdogMs;
  if (!Number.isSafeInteger(watchdogMs) || (watchdogMs as number) < 1) {
    throw new GeneralAgentTurnRequestError("watchdogMs");
  }
  return {
    kind: "agent",
    identity: {
      ownerId: row.ownerId as string,
      ownerGeneration: row.ownerGeneration as string,
      threadId: row.threadId as string,
      turnId: row.turnId as string,
      attemptGeneration: row.attemptGeneration as number,
    },
    prompt: row.prompt,
    turnToken: row.turnToken as string,
    convexCallbackBase: row.convexCallbackBase as string,
    brokerRoute: args.brokerRoute,
    execution,
    ...(row.browserResume
      ? { browserResume: row.browserResume as CloudBrowserResumeReceipt }
      : {}),
    watchdogMs: watchdogMs as number,
  };
};

export const turnComputePlanKey = (
  turnId: string,
  attemptGeneration: number,
): string => `turnComputePlan:${turnId}:${attemptGeneration}`;

/**
 * The one engine-placement branch. A browser handoff resumes inside the
 * container that suspended it, so it stays native regardless of engine, and
 * the kill switch demotes every Stella turn without touching the loop.
 */
export const selectGeneralAgentTurnPlan = (args: {
  execution: CloudExecutionSelection;
  browserResume: boolean;
  residentDisabled: boolean;
}): GeneralAgentTurnPlan => {
  if (args.execution.engine !== "stella") {
    return {
      kind: "native_sandbox",
      execution: args.execution,
      reason: "native_engine",
    };
  }
  if (args.browserResume) {
    return {
      kind: "native_sandbox",
      execution: args.execution,
      reason: "browser_resume",
    };
  }
  if (args.residentDisabled) {
    return {
      kind: "native_sandbox",
      execution: args.execution,
      reason: "resident_disabled",
    };
  }
  return { kind: "resident_stella", execution: args.execution };
};

/**
 * Whether this turn's saved thread candidate has to match its cursor exactly.
 *
 * A native engine's candidate is the only carrier of the CLI session state its
 * turn resumes from, so a registry entry that does not match this cursor means
 * the state on disk belongs to some other run of the conversation, and running
 * against it would resume the wrong session. A Stella turn restores nothing
 * from the candidate: its history is rebuilt from the canonical rows every
 * turn, so the same mismatch describes a turn it can simply start cold. A turn
 * dispatched without an engine selection keeps the strict rule it has today.
 */
export const requiresExactThreadCandidate = (
  execution: CloudExecutionSelection | undefined,
): boolean => execution?.engine !== "stella";

/**
 * Flat facts rather than a request object: admission holds `index.ts`'s
 * `TurnRequest`, the runner holds a parsed `GeneralAgentTurnRequest`, and both
 * have to reach the same decision. Passing the facts is what keeps that from
 * becoming two assembled records that can disagree.
 */
export const turnComputePlan = (args: {
  turnId: string;
  attemptGeneration: number;
  execution: CloudExecutionSelection;
  browserResume: boolean;
  residentDisabled: boolean;
  now: number;
}): TurnComputePlan => ({
  schemaVersion: 1,
  turnId: args.turnId,
  attemptGeneration: args.attemptGeneration,
  plan: selectGeneralAgentTurnPlan({
    execution: args.execution,
    browserResume: args.browserResume,
    residentDisabled: args.residentDisabled,
  }),
  engine: args.execution.engine,
  browserResume: args.browserResume,
  residentDisabled: args.residentDisabled,
  decidedAt: args.now,
});

const isTurnComputePlanRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Which container placements a Stella turn is allowed to hold.
 *
 * The executor's in-container Stella loop survives stage 6 only to serve
 * these three. A browser handoff resumes inside the container that suspended
 * it, the kill switch is the ladder's rollback lever, and an unplaced attempt
 * keeps the path it was admitted onto. A Stella turn reaching the container
 * for `native_engine` means something built a placement without the selector.
 */
const STELLA_CONTAINER_REASONS: ReadonlySet<string> = new Set([
  "browser_resume",
  "resident_disabled",
  "unplaced",
]);

export const stellaMayUseContainer = (
  plan: Extract<GeneralAgentTurnPlan, { kind: "native_sandbox" }>,
): boolean =>
  plan.execution?.engine !== "stella" ||
  STELLA_CONTAINER_REASONS.has(plan.reason);

/**
 * Read back an admitted placement. The exact turn and attempt have to match:
 * a plan left by a predecessor attempt describes a container this attempt
 * never reserved, and acting on it would tear down or trust the wrong one.
 */
export const parseTurnComputePlan = (
  value: unknown,
  identity: Readonly<{ turnId: string; attemptGeneration: number }>,
): TurnComputePlan | null => {
  if (!isTurnComputePlanRecord(value)) return null;
  if (
    value.schemaVersion !== 1 ||
    value.turnId !== identity.turnId ||
    value.attemptGeneration !== identity.attemptGeneration ||
    typeof value.browserResume !== "boolean" ||
    typeof value.residentDisabled !== "boolean" ||
    !Number.isSafeInteger(value.decidedAt) ||
    !isTurnComputePlanRecord(value.plan)
  ) {
    return null;
  }
  const plan = value.plan;
  if (plan.kind === "resident_stella") {
    return value as unknown as TurnComputePlan;
  }
  if (
    plan.kind !== "native_sandbox" ||
    (plan.reason !== "native_engine" &&
      plan.reason !== "browser_resume" &&
      plan.reason !== "resident_disabled")
  ) {
    return null;
  }
  const parsed = value as unknown as TurnComputePlan;
  if (
    parsed.plan.kind === "native_sandbox" &&
    !stellaMayUseContainer(parsed.plan)
  ) {
    return null;
  }
  return parsed;
};

const RESIDENT_COMPUTE: TurnComputeUse = { kind: "resident" };
const EMPTY_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  llmCalls: 0,
};

/**
 * What the container executor reported, reduced to the fields a turn envelope
 * is built from. `index.ts` already parses the executor's result file into
 * this shape; the adapter below re-states it rather than importing the Worker,
 * which would drag the whole container module graph into the resident bundle.
 */
export type NativeSandboxExecutorOutcome = Readonly<{
  ok: boolean;
  outcome?: "completed" | "suspended";
  finalText?: string;
  error?: string;
  usage?: TurnUsage;
  suspension?: CloudBrowserSuspension;
}>;

/**
 * One `runAgentAttempt` call, plus the durability its caller committed.
 *
 * Durability is an input rather than something the adapter derives. The
 * container path's checkpoint is committed through the turn broker by code
 * that owns the archive; asking the adapter to guess from a receipt would let
 * it claim a checkpoint the turn never uploaded.
 */
export type NativeSandboxAttempt = Readonly<{
  result: NativeSandboxExecutorOutcome;
  durability: TurnDurability;
  instanceSize: "small" | "large";
  coldStartMs: number;
  restoreMs: number;
}>;

export class NativeSandboxDurabilityError extends Error {
  constructor(outcome: string, durability: TurnDurability["kind"]) {
    super(
      `A native sandbox turn ended ${outcome} with ${durability} durability.`,
    );
    this.name = "NativeSandboxDurabilityError";
  }
}

const nativeCompute = (attempt: NativeSandboxAttempt): TurnComputeUse => ({
  kind: "sandbox",
  reason: "native_engine",
  instanceSize: attempt.instanceSize,
  coldStartMs: attempt.coldStartMs,
  restoreMs: attempt.restoreMs,
});

/**
 * The `native_sandbox` arm of the selector.
 *
 * It runs the existing eager-container attempt untouched and projects what it
 * reported into the one envelope both plans return. Everything a native turn
 * does differently — the executor process, the broker file handoff, archive
 * ordering — stays inside `runAttempt`, so this arm adds no second control
 * path and cannot silently accept a resident plan.
 */
export const runNativeSandboxTurn = async (args: {
  plan: Extract<GeneralAgentTurnPlan, { kind: "native_sandbox" }>;
  context: TurnExecutionContext;
  runAttempt: () => Promise<NativeSandboxAttempt>;
}): Promise<GeneralAgentTurnResult> => {
  args.context.assertActive();
  const attempt = await args.runAttempt();
  const compute = nativeCompute(attempt);
  const usage = attempt.result.usage ?? EMPTY_USAGE;

  if (attempt.result.outcome === "suspended") {
    const suspension = attempt.result.suspension;
    if (!suspension) {
      throw new NativeSandboxDurabilityError(
        "suspended",
        attempt.durability.kind,
      );
    }
    if (attempt.durability.kind === "none") {
      throw new NativeSandboxDurabilityError(
        "suspended",
        attempt.durability.kind,
      );
    }
    return {
      outcome: "suspended",
      ok: false,
      suspension,
      usage,
      compute,
      durability: attempt.durability,
    };
  }

  if (!attempt.result.ok) {
    return {
      outcome: "failed",
      ok: false,
      error: attempt.result.error ?? "The agent hit a problem and stopped.",
      usage,
      compute,
      durability: attempt.durability,
    };
  }

  if (attempt.durability.kind === "none") {
    throw new NativeSandboxDurabilityError(
      "completed",
      attempt.durability.kind,
    );
  }
  return {
    outcome: "completed",
    ok: true,
    finalText: attempt.result.finalText ?? "",
    usage,
    compute,
    durability: attempt.durability,
  };
};

export class GeneralAgentPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneralAgentPlacementError";
  }
}

/**
 * What running an admitted placement produced.
 *
 * Asymmetric because the two arms really are. A resident turn hands its
 * envelope back so the caller can sequence finalization; the eager container
 * path owns its own checkpoint validation, terminal delivery and fencing
 * inline, and reports nothing. Saying so in the type is what keeps a caller
 * from having to invent a result envelope the container path never produced.
 */
export type GeneralAgentTurnOutcome =
  | Readonly<{ kind: "resident"; result: GeneralAgentTurnResult }>
  | Readonly<{ kind: "native_finalized" }>;

/**
 * The single dispatch on an admitted placement.
 *
 * Both arms are supplied by `BuildSession`, which owns the sandbox, the
 * archive and the terminal event. What this adds are the two guards at the
 * boundary. A resident arm that reports a workspace checkpoint without having
 * attached is a wiring bug, and letting it through would mean a chat-only turn
 * claiming an archive nobody uploaded. A Stella turn taking the container arm
 * without one of the three reasons that still justify it is the other, and
 * letting it through would silently re-run the loop stage 6 retired.
 */
export const runGeneralAgentTurn = async (args: {
  plan: GeneralAgentTurnPlan;
  context: TurnExecutionContext;
  resident: (
    plan: Extract<GeneralAgentTurnPlan, { kind: "resident_stella" }>,
  ) => Promise<GeneralAgentTurnResult>;
  native: (
    plan: Extract<GeneralAgentTurnPlan, { kind: "native_sandbox" }>,
  ) => Promise<void>;
}): Promise<GeneralAgentTurnOutcome> => {
  args.context.assertActive();
  if (args.plan.kind === "native_sandbox") {
    if (!stellaMayUseContainer(args.plan)) {
      throw new GeneralAgentPlacementError(
        `A Stella turn reached the container as ${args.plan.reason}.`,
      );
    }
    await args.native(args.plan);
    return { kind: "native_finalized" };
  }
  const result = await args.resident(args.plan);
  if (
    result.durability.kind === "workspace_checkpoint" &&
    result.compute.kind !== "sandbox"
  ) {
    throw new GeneralAgentPlacementError(
      "A resident turn claimed a workspace checkpoint without attaching.",
    );
  }
  return { kind: "resident", result };
};

export type ResidentModelFactory = (args: {
  siteUrl: string;
  turnToken: string;
  execution: StellaExecution;
  signal: AbortSignal;
}) => Promise<Model<Api>>;

const relayModelFactory: ResidentModelFactory = async (args) =>
  await createCloudRelayModel({
    siteUrl: args.siteUrl,
    turnToken: args.turnToken,
    agentType: "general",
    execution: args.execution,
    signal: args.signal,
  });

export type ResidentStellaLoopInput = Readonly<{
  turn: GeneralAgentTurnRequest;
  execution: StellaExecution;
  context: TurnExecutionContext;
  control: GeneralAgentControlPlane;
  sql: SqlStorage;
  tools: readonly AgentTool[];
  workspacePrompt: Readonly<{
    office: boolean;
    skills?: GeneralAgentPromptSkills;
  }>;
  now: () => number;
  createModel?: ResidentModelFactory;
  /** `Agent`'s own provider seam, forwarded so a test can script completions. */
  streamFn?: StreamFn;
  /**
   * Called with the running loop's own abort, so the DO's interrupt hooks can
   * stop it. An `Agent` ignores an `AbortSignal`; this is the only handle.
   */
  onAgentStarted?: (abort: () => void) => void;
  /**
   * How the sealed transcript becomes durable.
   *
   * D6 requires an attached turn to commit its workspace archive *before* the
   * transcript, so a canonical cursor can never name a workspace revision that
   * was never uploaded. The loop cannot know whether a container attached
   * during it, so the caller sequences the commit. Absent, the resident-only
   * `transcript_only` commit below is what runs.
   */
  commit?: (
    sealed: SealedTurnTranscript,
  ) => Promise<Exclude<TurnDurability, { kind: "none" }>>;
}>;

/**
 * The resident Stella agent loop.
 *
 * Convex history in, sealed transcript out, no sandbox touched. The prompt is
 * the lazy workspace variant: nothing is on disk yet, and telling the model
 * otherwise is how it ends up reasoning about paths that do not exist.
 *
 * Every produced message is journaled synchronously from `Agent.subscribe`.
 * A journal write failure aborts the Agent rather than being swallowed,
 * because the in-memory context would otherwise diverge from what the next
 * turn reads back from Convex.
 */
export const runResidentStellaLoop = async (
  input: ResidentStellaLoopInput,
): Promise<GeneralAgentTurnResult> => {
  const { turn, context, control } = input;
  const preflightFailure = (error: string): GeneralAgentTurnResult => ({
    outcome: "failed",
    ok: false,
    error,
    usage: EMPTY_USAGE,
    compute: RESIDENT_COMPUTE,
    durability: { kind: "none", reason: "preflight_failed" },
  });

  context.assertActive();
  let history: AgentMessage[];
  try {
    history = pruneAgentHistory(
      parseAuthoritativeAgentHistory(
        await control.loadAuthoritativeHistory({ excludeCurrentTurn: true }),
      ),
    );
  } catch {
    return preflightFailure(
      "Stella couldn't validate this agent's conversation history. Try again.",
    );
  }

  context.assertActive();
  const model = await (input.createModel ?? relayModelFactory)({
    siteUrl: turn.convexCallbackBase,
    turnToken: turn.turnToken,
    execution: input.execution,
    signal: context.signal,
  });

  const journal = AgentTurnJournal.open({
    sql: input.sql,
    identity: {
      turnId: turn.identity.turnId,
      attemptGeneration: turn.identity.attemptGeneration,
    },
    terminal: {
      prompt: turn.prompt,
      provider: input.execution.provider,
      model: input.execution.model,
      finalText: "",
      timestamp: input.now(),
    },
    now: input.now(),
  });

  context.assertActive();
  // No await between this synchronous latch and constructing the Agent. The
  // next async admission boundary repeats the check.
  assertTurnExecutionActive(context.cancellation, context.signal);
  const agent = new Agent({
    initialState: {
      systemPrompt: buildGeneralAgentPrompt({
        workspace: "lazy",
        office: input.workspacePrompt.office,
        ...(input.workspacePrompt.skills
          ? { skills: input.workspacePrompt.skills }
          : {}),
      }),
      model,
      thinkingLevel: resolveCloudThinkingLevel(
        model,
        input.execution.reasoningEffort,
      ),
      tools: [...input.tools],
      messages: history,
    },
    sessionId: turn.identity.threadId,
    getApiKey: () => turn.turnToken,
    toolExecution: "sequential",
    toolInactivityTimeoutMs: 5 * 60_000,
    transformContext: buildDefaultTransformContext({ model }),
    degenerateResponseRetries: 0,
    providerRequestLimit: AGENT_RUN_MAX_ATTEMPTS,
    ...(input.streamFn ? { streamFn: input.streamFn } : {}),
  });
  input.onAgentStarted?.(() => agent.abort());

  let inputTokens = 0;
  let outputTokens = 0;
  let llmCalls = 0;
  let journalError: string | undefined;
  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (context.cancellation.aborted || context.signal.aborted) return;
    if (event.type !== "message_end") return;
    try {
      journal.append(event.message);
    } catch (error) {
      journalError ??=
        error instanceof Error ? error.message : "journal append failed";
      agent.abort();
      return;
    }
    if (event.message.role !== "assistant") return;
    llmCalls += 1;
    inputTokens += event.message.usage.input;
    outputTokens += event.message.usage.output;
  });

  let finalText = "";
  let runError: string | undefined;
  try {
    const execution = await executeAgentRunWithRetry({
      state: { attemptsUsed: 0, retriesUsed: 0 },
      isCanceled: () => context.cancellation.aborted,
      sleep: (milliseconds) => context.cancellation.sleep(milliseconds),
      execute: async (resume) => {
        context.assertActive();
        assertTurnExecutionActive(context.cancellation, context.signal);
        if (resume) await agent.continue();
        else await agent.prompt(turn.prompt);
        const completion = getAgentCompletion(agent);
        return { ...completion, finalText: completion.finalText.trim() };
      },
      prepareResume: (_reason, classification) =>
        prepareTransientResumeTail(agent.state.messages, classification),
    });
    finalText = execution.finalText;
    runError = execution.errorMessage;
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe();
  }

  const usage: TurnUsage = { inputTokens, outputTokens, llmCalls };
  const error = journalError ?? runError;
  if (journalError) {
    return {
      outcome: "failed",
      ok: false,
      error: `Persisting the reply failed: ${journalError}`,
      usage,
      compute: RESIDENT_COMPUTE,
      durability: { kind: "none", reason: "preflight_failed" },
    };
  }

  const sealed = await journal.seal({ suspended: false });
  const durability = input.commit
    ? await input.commit(sealed)
    : ({
        kind: "transcript_only",
        transcript: await control.appendAndVerifyTranscript(sealed),
      } as const);
  journal.clearAfterCanonicalCommit();
  return error
    ? {
        outcome: "failed",
        ok: false,
        error,
        usage,
        compute: RESIDENT_COMPUTE,
        durability,
      }
    : {
        outcome: "completed",
        ok: true,
        finalText,
        usage,
        compute: RESIDENT_COMPUTE,
        durability,
      };
};
