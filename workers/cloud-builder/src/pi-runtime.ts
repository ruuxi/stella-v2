/**
 * Stella's pi-durable harness inside the conversation's Durable Object.
 *
 * The harness lives on this object's SQLite (`openDurableObjectSqliteStorage`),
 * beside the journal; pi's tables (`conversations`, `entries`, `tasks`,
 * `submissions`, `documents`, ...) do not collide with the journal's. The
 * orchestrator chat is pi's root conversation; the agents it starts are
 * conversations under it, each run in a cloud container of its own.
 *
 * Model requests are routed by the provider session id pi-durable puts on
 * each one:
 *
 * - The root conversation's go through the running chat turn: its model
 *   capability and guarded gateway transport (owner fence, model grant,
 *   managed cancellation, all unchanged). Work the root runs without a bound
 *   turn, such as a request recovered right after an eviction, waits briefly
 *   for the resumed turn to bind again.
 * - An agent's go through its run. Every message to an agent is one run:
 *   admitted by the owner gate on the `agent` lane, with a capability of its
 *   own for the `general` agent type, released when the agent answers.
 *
 * What an agent needs between turns (the owner's authority, the model specs,
 * its prompt material) is kept in this object's storage, so an agent can
 * finish after the turn that started it, and after an eviction.
 *
 * Loaded lazily, like the rest of the loop, so object wake stays lean.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  type EntryId,
  ProviderDoc,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Harness,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import {
  offersAgentTools,
  openStellaHarness,
  orchestratorAgent,
  stellaModelRef,
  type OpenStellaHarness,
} from "@stella/agent/harness";
import { CHATGPT_PROVIDER_ID, chatGptModel, chatGptProvider } from "@stella/agent/provider/chatgpt";
import {
  stellaProvider,
  type StellaGatewayAccess,
  type StellaModelSpec,
  type StellaRequestRoute,
} from "@stella/agent/provider/stella";
import { StellaAgentDoc } from "@stella/agent/stella/agent-doc";
import {
  StellaAgentsDoc,
  type AgentReport,
  type AgentRun,
  type AgentRunEnd,
  type RemoteAgentHost,
  type StellaAgentsHost,
} from "@stella/agent/stella/agents";
import {
  STELLA_HARNESS_TOOL_NAMES,
  type StellaToolHost,
  type StellaToolOutcome,
  type StellaToolSpec,
} from "@stella/agent/stella/host-tools";
import type { StellaContextSources, StellaMemory } from "@stella/agent/stella/context";
import { importJournal, JournalSyncDoc, type JournalMessage } from "@stella/agent/stella/journal-sync";
export { journalSeqOf } from "@stella/agent/stella/journal-sync";
import type { AgentModelReasoningEffort, CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { ExecutionContextSnapshot } from "@stella/contracts/execution-context";
import {
  mergePiEntries,
  piEntriesForClients,
  piEventsForClients,
  type PiChatEvent,
  type PiEntry,
} from "@stella/contracts/pi-chat";
import { gatewayRelayBaseUrl } from "@stella/contracts/gateway/api";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import { toolRequiresExplicitApproval } from "@stella/runtime/kernel/tools/code-tool.js";
import { mintTurnCapability } from "./capability-signer.js";
import type { CloudCodeSourceAgentTool } from "./cloud-code-tool.js";
import {
  fetchWithManagedCancellation,
  type ModelGatewayControl,
} from "./managed-request-cancellation.js";
import { bundledPrompt } from "./prompts/bundled.js";
import type { SerializedAgentToolResult } from "@stella/executor-cloud/attached-tool-protocol";
import { generalAgentWorldGuidance } from "@stella/executor-cloud/general-agent-prompt";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import { TURN_BROKER_HEADERS } from "@stella/contracts/turn-credential-broker";
import { serveTurnDriveRequest } from "./build-session/turn-broker.js";
import {
  forgetPiCompute,
  openPiComputeLease,
  piBrokerSessionId,
  releasePiCompute,
  type PiComputeHost,
  type PiComputeLease,
  type PiComputeOwner,
  type PiComputeRecord,
} from "./pi-agent-compute.js";
import { piAttachedCoding, type PiAttachedToolCall } from "./pi-attached-tools.js";
import { WORLD_ROOT } from "./workspace.js";
import {
  claimTurnBrokerRequest,
  preflightTurnBrokerRequest,
  TurnBrokerBodyTooLargeError,
  readTurnBrokerRequestBody,
  turnBrokerDenialResponse,
  turnBrokerStorageKey,
  turnBrokerTargetMatchesEngine,
  type TurnBrokerRecord,
} from "./turn-credential-broker.js";

/** How long recovered work waits for its turn or agent run to bind a transport. */
const BINDING_WAIT_MS = 120_000;
/** A run's capability is minted again when less than this is left of it. */
const CAPABILITY_RENEW_MS = 60_000;
/** How long an agent waits for one of the owner's container slots. */
const CONTAINER_SLOT_WAIT_MS = 10 * 60_000;
const CONTAINER_SLOT_POLL_MS = 5_000;
/** How long a computer's pause holds its turn: the run is marked at once, then winds down on its own. */
const ORIGIN_PAUSE_HOLD_MS = 5_000;
/** A command without its own timeout. */
/** Storage key of what agents need between turns. */
const PI_AGENT_STATE_KEY = "piAgentState";
/** The newest entries a client starts from, and per older page. */
const CLIENT_HISTORY_PAGE = 200;
/** A client frame of entries stays well under the socket's message limit. */
const CLIENT_FRAME_BYTES = 512 * 1024;

/** A turn pi runs: on Stella's models, or on the owner's ChatGPT plan through the gateway's native lane. */
export type PiExecution = Extract<CloudExecutionSelection, { engine: "stella" | "chatgpt" }>;

/** Whose agents these are, as the latest chat turn admitted them. */
export type PiAuthority = {
  ownerId: string;
  ownerGeneration: string;
  /** The Stella conversation (this object's name). */
  conversationId: string;
  audience: ManagedModelAudience;
  budgetMicroCents: number;
  execution: PiExecution;
};

/** What an agent needs when no turn is bound: kept in storage. */
type PiAgentState = {
  version: 1;
  authority: PiAuthority;
  /** The `stella` provider's models: the orchestrator's and the general agent's (none on a ChatGPT turn). */
  models: StellaModelSpec[];
  skillsCatalog?: string;
  executionContext: ExecutionContextSnapshot;
  /** The orchestrator's tools as the latest turn offered them, for work recovered before a turn binds. */
  tools?: StellaToolSpec[];
  /** The agents' own tools, likewise. */
  agentTools?: StellaToolSpec[];
  locale?: string;
  /** The latest turn bound, which an agent a reporter starts after it belongs to. */
  lastTurnId?: string;
};

export type PiDeviceAgents = {
  start(
    args: { key: string; deviceId: string; description: string; prompt: string },
    authority: PiAuthority,
    parentTurnId: string,
  ): Promise<{ threadId: string }>;
  message(args: { key: string; threadId: string; message: string }, authority: PiAuthority, parentTurnId: string): Promise<void>;
  status(threadId: string, authority: PiAuthority, parentTurnId: string): Promise<string>;
  pause(args: { key: string; threadId: string }, authority: PiAuthority, parentTurnId: string): Promise<void>;
};

/** One of the orchestrator's agents, as its lifecycle cards name it. */
export type PiAgentInfo = {
  description: string;
  /** How many messages it has been given: 1 for the spawn, then one more per follow-up. */
  attempt: number;
  /** Started for a computer's orchestrator, whose own turns show it. */
  origin?: { deviceId: string };
  /** What its latest run saved to the owner's drive and linked in its answer. */
  files?: PiDeliveredFile[];
};

/** A file an agent delivered: in the owner's drive, for the conversation's files card. */
export type PiDeliveredFile = { path: string; name: string; sizeBytes: number; contentType: string };

export type PiTurnSources = {
  orchestratorPrompt: string;
  personality: string | undefined;
  memory: StellaMemory;
  skillsCatalog: string | undefined;
  executionContext: ExecutionContextSnapshot;
  /** The conversation's reply language. */
  locale?: string;
};

export type PiTurnBinding = {
  turnId: string;
  capability: string;
  fetch: typeof fetch;
  authority: PiAuthority;
  /** On Stella's models: the orchestrator's, and the same alias for its agents. */
  stellaModels?: { model: StellaModelSpec; agentModel: StellaModelSpec };
  thinkingLevel: ModelThinkingLevel;
  sources: PiTurnSources;
  /** The turn's orchestrator tools (web, html, image_gen, Read, drive, …), code excluded. */
  tools(): Promise<readonly CloudCodeSourceAgentTool[]>;
};

export type PiRuntimeEnv = Pick<
  Cloudflare.Env,
  "OWNER_GATES" | "WORLDS" | "BUILDER_SERVICE_SECRET"
> &
  Partial<
    Pick<
      Cloudflare.Env,
      | "Sandbox"
      | "MODEL_GATEWAY"
      | "MODEL_GATEWAY_CONTROL"
      | "CAPABILITY_SIGNING_KEY"
      | "CAPABILITY_SIGNING_KID"
      | "SANDBOX_IDLE_TIMEOUT_MS"
      | "CLOUD_BUILDER_PUBLIC_URL"
    >
  >;

export type PiRuntimeOptions = {
  storage: DurableObjectStorage;
  env: PiRuntimeEnv;
  gatewayOrigin: string;
  waitUntil(work: Promise<unknown>): void;
  report(error: unknown): void;
  log(event: string, fields: Record<string, unknown>): void;
  /** An agent's report for the orchestrator, as a hidden wake turn. */
  deliverReport(report: AgentReport, authority: PiAuthority, agent: PiAgentInfo): Promise<void>;
  /**
   * A report of an agent a computer's orchestrator started here: it goes
   * back to that computer (an `agent-report` card in the journal), not to
   * this conversation's orchestrator. `turnId` is the latest turn.
   */
  deliverOriginReport?(report: AgentReport & { origin: { deviceId: string } }, turnId: string): Promise<void>;
  /** An agent started work (a spawn or a follow-up), during or just after `turnId`. */
  agentStarted?(event: PiAgentInfo & { threadId: string; turnId: string }): void;
  /**
   * Agents on the owner's devices, run there as a whole through the owner's
   * agent threads as the loop's are; their reports come back as wake turns.
   */
  deviceAgents?: PiDeviceAgents;
  /** Keep this object waking while agents run. */
  heartbeat(): void;
  /** An agent's own tools (web, code with connectors), on the agents' authority. */
  agentTools(authority: PiAuthority): Promise<readonly CloudCodeSourceAgentTool[]>;
  /**
   * Holds one agent run to the owner's purge fence, as a chat turn is held:
   * a lease while it runs, and a model grant (under the owner's memory
   * policy) on each of its requests, revoked by a purge or privacy change.
   */
  agentGuard?(authority: PiAuthority, turnId: string): Promise<PiAgentGuard>;
};

/** A tool the root conversation started or finished, for clients' live view. */
export type PiToolActivity = {
  toolCallId: string;
  name: string;
  phase: "start" | "end";
  args?: unknown;
  isError?: boolean;
};

/** One agent run's hold on the owner's purge fence (`PiRuntimeOptions.agentGuard`). */
export type PiAgentGuard = {
  /** A model request, sent only under a valid grant. */
  fetch(request: Request): Promise<Response>;
  release(): Promise<void>;
};

/** A pi call context: cancelled with `signal`, which only cancels that call or wait. */
export const contextFor = (signal?: AbortSignal): Context =>
  signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

/**
 * The thinking level of a turn's reasoning effort. A ChatGPT plan's default
 * is its provider's (medium); Stella's models think only when asked.
 */
export const thinkingLevelFor = (effort: AgentModelReasoningEffort, engine: PiExecution["engine"] = "stella"): ModelThinkingLevel =>
  effort === "none" ? "off" : effort === "default" ? (engine === "chatgpt" ? "medium" : "off") : effort;

const MEMORY_FIELDS: Record<string, keyof Omit<StellaMemory, "enabled">> = {
  "~/.stella/core-memory.md": "core",
  "~/.stella/memories/profile.md": "profile",
  "~/.stella/memories/index.md": "index",
};

export const memoryFromDocuments = (
  enabled: boolean,
  documents: ReadonlyArray<{ displayPath: string; content: string }>,
): StellaMemory => {
  const memory: StellaMemory = { enabled };
  if (!enabled) return memory;
  for (const document of documents) {
    const field = MEMORY_FIELDS[document.displayPath];
    if (field && document.content.trim()) memory[field] = document.content;
  }
  return memory;
};

export const assistantText = (entry: EntryRecord | undefined): string => {
  const message = entry?.model?.[0];
  if (message?.role !== "assistant") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

const withBearer = (request: Request, capability: string): Request => {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${capability}`);
  return new Request(request, { headers });
};

const waitFor = async (ms: number, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted();
  await scheduler.wait(ms);
  signal?.throwIfAborted();
};

/** One message an agent is working on: admitted, with its own capability. */
type ActiveRun = {
  run: AgentRun;
  /** Owner gate and capability turn id; unique across the owner's conversations. */
  turnId: string;
  sessionId: string;
  capability: { token: string; expiresAt: number };
  guard?: PiAgentGuard;
};

/** An agent's container, from its first tool call until its last run ends. */
type AgentLease = {
  lease: PiComputeLease;
  threadId: string;
  /** Tool calls on it now: a lease is renewed only between them. */
  inFlight: number;
};

/** A lease is renewed before its credentials run out, when no call is on it. */
const LEASE_RENEW_MS = 3 * 60_000;
/** The files an agent's latest run delivered, until its report carries them. */
const deliveredFilesKey = (threadId: string) => `piAgentFiles:${threadId}`;

const brokerFailure = (status: number): Response =>
  Response.json({ error: "Turn broker request failed." }, { status, headers: { "cache-control": "no-store" } });

type Opened = {
  harness: Harness;
  root: Conversation;
  rootSession: string;
  refreshTools(): void;
  agents: Pick<OpenStellaHarness, "startAgent" | "messageAgent" | "pauseAgent">;
};

/** A cloud tool as the harness offers it. */
const toolSpec = (tool: CloudCodeSourceAgentTool): StellaToolSpec => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters as unknown as Record<string, unknown>,
  ...(tool.replay ? { replay: tool.replay } : {}),
  ...(tool.demoted && !toolRequiresExplicitApproval(tool.approval)
    ? { codeOnly: { ...(tool.demoted.searchTerms ? { searchTerms: tool.demoted.searchTerms } : {}) } }
    : {}),
});

/** A journal record as `importJournal` reads it; only messages are imported. */
export type JournalRecordLike = {
  seq: number;
  kind: string;
  turnId: string;
  role?: "user" | "assistant" | "toolResult";
  hidden?: boolean;
  payload?: unknown;
};

export class PiConversationRuntime {
  readonly #options: PiRuntimeOptions;
  readonly #models = createModels();
  #opening: Promise<Opened> | undefined;
  #binding: PiTurnBinding | undefined;
  /** The bound turn's tools, built once per turn. */
  #turnTools: { binding: PiTurnBinding; tools: Promise<readonly CloudCodeSourceAgentTool[]> } | undefined;
  #state: PiAgentState | undefined;
  #modelKey: string | undefined;
  /** Agent runs by their conversation's provider session id. */
  readonly #runs = new Map<string, ActiveRun[]>();
  /** Agents' containers by their conversation. */
  readonly #leases = new Map<number, Promise<AgentLease>>();
  /** Leases whose daemon may call the broker, by `turnId:attemptGeneration` (until released). */
  readonly #live = new Map<string, AgentLease>();
  /** Broker claims, one at a time. */
  #brokerClaims: Promise<unknown> = Promise.resolve();
  /** Requests waiting for a transport: `root`, or an agent's session id. */
  readonly #waiting = new Map<string, Set<() => void>>();
  /** The root conversation's events for clients watching the pi view. */
  #clientStream: AgentEventStream | undefined;

  constructor(options: PiRuntimeOptions) {
    this.#options = options;
  }

  // ---- transports ---------------------------------------------------------

  #notify(key: string): void {
    const waiters = this.#waiting.get(key);
    if (!waiters) return;
    this.#waiting.delete(key);
    for (const ready of waiters) ready();
  }

  /** Wait until `ready()` has an answer, for at most {@link BINDING_WAIT_MS}. */
  async #await<T>(key: string, ready: () => T | undefined, refusal: string, signal?: AbortSignal | null): Promise<T> {
    const now = ready();
    if (now !== undefined) return now;
    const timeout = AbortSignal.timeout(BINDING_WAIT_MS);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return await new Promise<T>((resolve, reject) => {
      let waiters = this.#waiting.get(key);
      if (!waiters) this.#waiting.set(key, (waiters = new Set()));
      const onStop = () => {
        waiters.delete(wake);
        reject(signal?.aborted ? (signal.reason ?? new Error("aborted")) : new Error(refusal));
      };
      const wake = () => {
        const value = ready();
        if (value === undefined) {
          let next = this.#waiting.get(key);
          if (!next) this.#waiting.set(key, (next = new Set()));
          next.add(wake);
          return;
        }
        stop.removeEventListener("abort", onStop);
        resolve(value);
      };
      if (stop.aborted) return onStop();
      stop.addEventListener("abort", onStop, { once: true });
      waiters.add(wake);
    });
  }

  #turn(signal?: AbortSignal | null): Promise<PiTurnBinding> {
    return this.#await("root", () => this.#binding, "No Stella turn is running to carry this model request.", signal);
  }

  #agentRun(sessionId: string, signal?: AbortSignal | null): Promise<ActiveRun> {
    return this.#await(
      sessionId,
      () => this.#runs.get(sessionId)?.at(-1),
      "This agent has no admitted run to carry its model request.",
      signal,
    );
  }

  async #runCapability(active: ActiveRun): Promise<string> {
    if (active.capability.expiresAt - Date.now() > CAPABILITY_RENEW_MS) return active.capability.token;
    const state = await this.#agentState();
    active.capability = await this.#mint(state.authority, active.turnId);
    return active.capability.token;
  }

  async #mint(authority: PiAuthority, turnId: string): Promise<{ token: string; expiresAt: number }> {
    const minted = await mintTurnCapability(this.#options.env, {
      ownerId: authority.ownerId,
      ownerGeneration: authority.ownerGeneration,
      turnId,
      conversationId: authority.conversationId,
      execution: authority.execution,
      audience: authority.audience,
      budgetMicroCents: authority.budgetMicroCents,
      agentTypes: ["general"],
    });
    return { token: minted.token, expiresAt: minted.expiresAt };
  }

  /** An agent's request: its run's capability over the gateway, cancellable there. */
  async #agentFetch(active: ActiveRun, request: Request): Promise<Response> {
    const { env } = this.#options;
    const gateway = env.MODEL_GATEWAY;
    const control = env.MODEL_GATEWAY_CONTROL;
    if (!gateway || !control) throw new Error("Model gateway is not configured.");
    const capability = await this.#runCapability(active);
    const send = (value: Request) => (active.guard ? active.guard.fetch(value) : gateway.fetch(value));
    // The native lane serves a plan's request as one stream; the managed lane's cancellation is Stella's own.
    if ((await this.#agentState()).authority.execution.engine === "chatgpt") return await send(withBearer(request, capability));
    return await fetchWithManagedCancellation({
      request: withBearer(request, capability),
      capability,
      control: control as unknown as ModelGatewayControl,
      waitUntil: (work) => this.#options.waitUntil(work),
      fetch: send,
    });
  }

  #access(): StellaGatewayAccess {
    return {
      relayBaseUrl: gatewayRelayBaseUrl(this.#options.gatewayOrigin),
      // The bearer is set per request below, by the conversation it is for.
      capability: async () => "stella-routed",
      fetch: async (input: string | URL | Request, init?: RequestInit, route?: StellaRequestRoute) => {
        const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        const { rootSession } = await this.open();
        if (!route?.sessionId || route.sessionId === rootSession) {
          const turn = await this.#turn(request.signal);
          return await turn.fetch(withBearer(request, turn.capability));
        }
        return await this.#agentFetch(await this.#agentRun(route.sessionId, request.signal), request);
      },
    };
  }

  // ---- what agents keep between turns --------------------------------------

  async #agentState(): Promise<PiAgentState> {
    this.#state ??= await this.#options.storage.get<PiAgentState>(PI_AGENT_STATE_KEY);
    if (!this.#state) throw new Error("No Stella turn has run in this conversation yet.");
    return this.#state;
  }

  #setModels(state: Pick<PiAgentState, "models" | "authority">): void {
    const { execution } = state.authority;
    const plan = execution.engine === "chatgpt" ? chatGptModel(execution.model) : undefined;
    const key = JSON.stringify([state.models, plan?.id]);
    if (key === this.#modelKey) return;
    const access = this.#access();
    this.#models.setProvider(stellaProvider({ access, models: state.models }));
    if (plan) {
      this.#models.setProvider(
        chatGptProvider({
          models: [plan],
          transport: { baseUrl: access.relayBaseUrl, fetch: (request, route) => access.fetch(request, undefined, route) },
        }),
      );
    }
    this.#modelKey = key;
  }

  /** The orchestrator's model for a turn's execution. */
  #rootModel(execution: PiExecution) {
    return execution.engine === "chatgpt"
      ? { provider: CHATGPT_PROVIDER_ID, modelId: execution.model }
      : stellaModelRef("orchestrator", execution.model);
  }

  #sources(): StellaContextSources {
    // The orchestrator answers only inside a turn; agents also between turns.
    const turn = async (): Promise<PiTurnSources> => (await this.#turn()).sources;
    return {
      env: "cloud",
      agentPrompt: async (id) =>
        id === "agents/orchestrator.md"
          ? (await turn()).orchestratorPrompt
          : id === "agents/general.md"
            ? // Where an agent's work lives and how what it makes reaches the user, as the cloud's agents are told.
              `${bundledPrompt(id).trim()}\n\n${generalAgentWorldGuidance()}`
            : bundledPrompt(id),
      personality: async () => (await turn()).personality,
      memory: async () => (await turn()).memory,
      skillsCatalog: async () => this.#binding?.sources.skillsCatalog ?? (await this.#agentState()).skillsCatalog,
      executionContext: async () =>
        this.#binding?.sources.executionContext ?? (await this.#agentState()).executionContext,
      locale: async () => (this.#binding ? this.#binding.sources.locale : (await this.#agentState()).locale),
      // The orchestrator's code reads the journal while memory is on; agents' code has no history.
      codeHistory: async (agentType) => agentType === "orchestrator" && (await turn()).memory.enabled,
    };
  }

  // ---- Stella's tools ---------------------------------------------------------

  #turnToolsFor(binding: PiTurnBinding): Promise<readonly CloudCodeSourceAgentTool[]> {
    if (this.#turnTools?.binding !== binding) {
      const tools = binding.tools();
      this.#turnTools = { binding, tools };
      tools.catch(() => {
        if (this.#turnTools?.tools === tools) this.#turnTools = undefined;
      });
    }
    return this.#turnTools.tools;
  }

  #tools(): StellaToolHost {
    return {
      specs: (role) => (role === "orchestrator" ? this.#state?.tools : this.#state?.agentTools) ?? [],
      run: async (call, context) => {
        const signal = context.abortSignal;
        // The orchestrator's tools are its turn's: recovered work waits for the turn to bind again.
        const tools =
          call.role === "orchestrator"
            ? await this.#turnToolsFor(await this.#turn(signal))
            : await this.#options.agentTools((await this.#agentState()).authority);
        const tool = tools.find((candidate) => candidate.name === call.name);
        if (!tool) throw new Error(`${call.name} is not available here.`);
        const started = Date.now();
        const fields = { role: call.role, tool: call.name, callId: call.callId };
        try {
          const result = await tool.execute(call.callId, call.args, signal);
          this.#options.log("pi_tool_ran", { ...fields, ms: Date.now() - started });
          return {
            content: result.content as StellaToolOutcome["content"],
            details: result.details,
          };
        } catch (error) {
          this.#options.log("pi_tool_failed", {
            ...fields,
            ms: Date.now() - started,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    };
  }

  // ---- agents ---------------------------------------------------------------

  async #providerSession(harness: Harness, conversationId: ConversationId, context: Context): Promise<string> {
    const existing = await harness.snapshot(ProviderDoc, conversationId, context);
    if (existing) return existing.sessionId;
    let created: string | undefined;
    await harness.commit(async (tx) => {
      created = (await tx.doc(ProviderDoc, conversationId)).sessionId;
      return undefined;
    }, context);
    if (!created) throw new Error(`Conversation ${conversationId} has no provider session.`);
    return created;
  }

  #gate(authority: PiAuthority) {
    return this.#options.env.OWNER_GATES.getByName(authority.ownerId);
  }

  #agents(): StellaAgentsHost {
    return {
      rootPlacement: { kind: "cloud" },
      place: (destination, caller) => {
        if (destination.kind === "here" || destination.kind === "cloud") return { kind: "cloud" };
        if (this.#options.deviceAgents && caller.kind === "cloud") {
          return { kind: "device", deviceId: destination.deviceId };
        }
        return { error: `This conversation cannot start an agent on device ${destination.deviceId}.` };
      },
      remote: (placement) => (placement.kind === "device" ? this.#deviceAgentHost(placement.deviceId) : undefined),
      beginAgentRun: async (run, context) => {
        const { authority } = await this.#agentState();
        const turnId = `pi:${authority.conversationId}:${run.runId}`;
        const admission = await this.#gate(authority).admit({
          lane: "agent",
          turnId,
          conversationId: authority.conversationId,
          expectedGeneration: authority.ownerGeneration,
        });
        if (!admission.ok) throw new Error(admission.message);
        const { harness } = await this.open();
        const guard = await this.#options.agentGuard?.(authority, turnId).catch(async (error: unknown) => {
          await this.#gate(authority).release({ turnId }).catch(() => undefined);
          throw error;
        });
        const active: ActiveRun = {
          run,
          turnId,
          sessionId: await this.#providerSession(harness, run.agentConversationId, context),
          capability: await this.#mint(authority, turnId),
          ...(guard ? { guard } : {}),
        };
        const runs = this.#runs.get(active.sessionId) ?? [];
        runs.push(active);
        this.#runs.set(active.sessionId, runs);
        this.#notify(active.sessionId);
        this.#options.heartbeat();
        this.#options.log("pi_agent_run_started", { threadId: run.threadId, turnId });
        const spawnedIn = this.#binding?.turnId ?? this.#state?.lastTurnId;
        const info = await this.#agentInfo(run.threadId, context);
        // A computer's agent shows in that computer's own turns.
        if (spawnedIn && !info.origin) {
          this.#options.agentStarted?.({ threadId: run.threadId, turnId: spawnedIn, ...info });
        }
      },
      endAgentRun: async (run, _context, end) => {
        let ended: ActiveRun | undefined;
        for (const [sessionId, runs] of this.#runs) {
          const index = runs.findIndex((active) => active.run.runId === run.runId);
          if (index < 0) continue;
          [ended] = runs.splice(index, 1);
          if (runs.length === 0) this.#runs.delete(sessionId);
          break;
        }
        // The agent's last run: its container's work is saved and delivered
        // while the run still holds its admission, then the container goes.
        const busy = [...this.#runs.values()].some((runs) =>
          runs.some((active) => active.run.agentConversationId === run.agentConversationId),
        );
        if (!busy) {
          await this.#endLease(run.agentConversationId, end ?? {}).catch((error: unknown) => this.#options.report(error));
        }
        await ended?.guard?.release().catch((error: unknown) => this.#options.report(error));
        const authority = this.#state?.authority;
        if (!authority) return;
        await this.#gate(authority)
          .release({ turnId: ended?.turnId ?? `pi:${authority.conversationId}:${run.runId}` })
          .catch((error: unknown) => this.#options.report(error));
        this.#options.log("pi_agent_run_ended", { threadId: run.threadId, turnId: ended?.turnId });
      },
      deliverReport: async (report, context) => {
        const { authority } = await this.#agentState();
        if (report.origin && this.#options.deliverOriginReport) {
          await this.#options.deliverOriginReport(
            { ...report, origin: report.origin },
            this.#binding?.turnId ?? this.#state?.lastTurnId ?? `pi:${authority.conversationId}`,
          );
          return;
        }
        // Only the host that started it counts what settled without a report.
        if (report.settled) return;
        // What the agent's run delivered goes with its report, once.
        const filesKey = deliveredFilesKey(report.threadId);
        const files = await this.#options.storage.get<PiDeliveredFile[]>(filesKey);
        const info = await this.#agentInfo(report.threadId, context);
        await this.#options.deliverReport(report, authority, files?.length ? { ...info, files } : info);
        if (files) await this.#options.storage.delete(filesKey);
      },
    };
  }

  /** The host of agents on one of the owner's devices. */
  #deviceAgentHost(deviceId: string): RemoteAgentHost | undefined {
    const devices = this.#options.deviceAgents;
    if (!devices) return undefined;
    const scope = async () => {
      const { authority } = await this.#agentState();
      return { authority, parentTurnId: this.#binding?.turnId ?? this.#state?.lastTurnId ?? `pi:${authority.conversationId}` };
    };
    return {
      start: async (args) => {
        const { authority, parentTurnId } = await scope();
        return await devices.start({ ...args, deviceId }, authority, parentTurnId);
      },
      message: async (args) => {
        const { authority, parentTurnId } = await scope();
        await devices.message(args, authority, parentTurnId);
      },
      status: async (threadId) => {
        const { authority, parentTurnId } = await scope();
        return await devices.status(threadId, authority, parentTurnId);
      },
      pause: async (threadId) => {
        const { authority, parentTurnId } = await scope();
        await devices.pause({ key: `pause:${threadId}:${Date.now()}`, threadId }, authority, parentTurnId);
      },
    };
  }

  /** What an agent's lifecycle cards say about it. */
  async #agentInfo(threadId: string, context: Context): Promise<PiAgentInfo> {
    const { harness, root } = await this.open();
    const state = await harness.snapshot(StellaAgentsDoc, root.id, context);
    const calls = Object.values(state?.calls ?? {}).filter((call) => call.threadId === threadId).length;
    const agent = state?.agents[threadId];
    return {
      description: agent?.description ?? threadId,
      attempt: Math.max(1, calls),
      ...(agent?.origin ? { origin: agent.origin } : {}),
    };
  }

  // ---- agent containers -----------------------------------------------------

  /** The ExecutionEnv of a conversation: its container for a cloud agent; none for the orchestrator. */
  // ---- agents' containers ---------------------------------------------------

  #owner(authority: PiAuthority): PiComputeOwner {
    return { ownerId: authority.ownerId, ownerGeneration: authority.ownerGeneration, conversationId: authority.conversationId };
  }

  #computeHost(): PiComputeHost {
    return {
      env: this.#options.env,
      storage: this.#options.storage,
      takeSlot: (owner, sandboxId, signal) => this.#takeSlot(owner, sandboxId, signal),
      releaseSlot: async (owner, sandboxId) => {
        await this.#options.env.OWNER_GATES.getByName(owner.ownerId).releaseAgentContainer({ sandboxId });
      },
      log: this.#options.log,
    };
  }

  /** One of the owner's agent container slots, waited for. */
  async #takeSlot(owner: PiComputeOwner, sandboxId: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + CONTAINER_SLOT_WAIT_MS;
    for (;;) {
      const slot = await this.#options.env.OWNER_GATES.getByName(owner.ownerId).acquireAgentContainer({ sandboxId });
      if (slot.ok) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `Your cloud is already running ${slot.limit} agents' workspaces, its limit. This agent waited ${CONTAINER_SLOT_WAIT_MS / 60_000} minutes for one of them to finish.`,
        );
      }
      await waitFor(CONTAINER_SLOT_POLL_MS, signal);
    }
  }

  /** A cloud agent's file or shell tool call, run in its container. */
  async #attachedTool(call: PiAttachedToolCall, context: Context): Promise<SerializedAgentToolResult> {
    const { harness } = await this.open();
    const agentConversationId = call.conversationId as ConversationId;
    const sessionId = await this.#providerSession(harness, agentConversationId, context);
    const active = await this.#agentRun(sessionId, context.abortSignal);
    const held = await this.#lease(agentConversationId, active, context);
    // A pause or stop while the command runs takes the container's work down
    // with it, unsaved, rather than waiting for the command to finish.
    const signal = context.abortSignal;
    const stop = () => {
      void this.#endLease(agentConversationId, { aborted: true }).catch((error: unknown) => this.#options.report(error));
    };
    signal?.addEventListener("abort", stop, { once: true });
    try {
      signal?.throwIfAborted();
      return await held.lease.ladder.execute({ toolCallId: call.callId, toolName: call.toolName, params: call.params });
    } finally {
      signal?.removeEventListener("abort", stop);
      held.inFlight -= 1;
    }
  }

  /**
   * The agent's lease, with this call counted on it: the one it holds, or a
   * new one when it holds none or its credentials are near their end with
   * nothing running on it.
   */
  async #lease(agentConversationId: ConversationId, active: ActiveRun, context: Context): Promise<AgentLease> {
    const current = this.#leases.get(agentConversationId);
    if (current) {
      const held = await current;
      if (held.inFlight > 0 || held.lease.expiresAt - Date.now() > LEASE_RENEW_MS) {
        held.inFlight += 1;
        return held;
      }
      if (this.#leases.get(agentConversationId) === current) {
        this.#leases.delete(agentConversationId);
        await this.#releaseLease(agentConversationId, held, {});
      }
      return await this.#lease(agentConversationId, active, context);
    }
    const opening = (async (): Promise<AgentLease> => {
      const { authority } = await this.#agentState();
      const { harness } = await this.open();
      const role = await harness.snapshot(StellaAgentDoc, agentConversationId, context);
      const threadId = role?.threadId ?? active.run.threadId;
      const lease = await openPiComputeLease(this.#computeHost(), {
        owner: this.#owner(authority),
        agentConversationId,
        threadId,
        turnId: active.turnId,
      });
      const held: AgentLease = { lease, threadId, inFlight: 0 };
      this.#live.set(`${lease.record.turnId}:${lease.record.attemptGeneration}`, held);
      return held;
    })();
    this.#leases.set(agentConversationId, opening);
    opening.catch(() => {
      if (this.#leases.get(agentConversationId) === opening) this.#leases.delete(agentConversationId);
    });
    const held = await opening;
    held.inFlight += 1;
    return held;
  }

  /** The agent's last run ended: its lease is quiesced (unless it was stopped) and released. */
  async #endLease(agentConversationId: number, end: AgentRunEnd): Promise<void> {
    const current = this.#leases.get(agentConversationId);
    if (!current) return;
    this.#leases.delete(agentConversationId);
    const held = await current.catch(() => undefined);
    if (held) await this.#releaseLease(agentConversationId, held, end);
  }

  /**
   * Quiesce a lease (the world pushed, the drive written back, the files the
   * answer links delivered), then release it. A stopped run's lease is only
   * released.
   */
  async #releaseLease(agentConversationId: number, held: AgentLease, end: AgentRunEnd): Promise<void> {
    const { ladder, record } = held.lease;
    if (!end.aborted && ladder.attached()) {
      try {
        // The agent's home is the world: a link to `~/drive/...` names the drive copy there.
        const linked = extractLocalFileLinkPaths(end.answer ?? "").map((linkedPath) =>
          linkedPath === "~" || linkedPath.startsWith("~/") ? `${WORLD_ROOT}${linkedPath.slice(1)}` : linkedPath,
        );
        const { deliveredFiles } = await ladder.quiesce(linked);
        this.#options.log("pi_agent_quiesced", { threadId: held.threadId, delivered: deliveredFiles.length });
      } catch (error) {
        this.#options.report(error);
      }
    }
    await ladder.teardown().catch((error: unknown) => this.#options.report(error));
    held.lease.abort();
    this.#live.delete(`${record.turnId}:${record.attemptGeneration}`);
    await forgetPiCompute(this.#computeHost(), agentConversationId, record).catch((error: unknown) =>
      this.#options.report(error),
    );
  }

  /** Leases an eviction dropped: their sessions and slots are released, their records forgotten. */
  async #sweepLeases(): Promise<void> {
    const left = await this.#options.storage.list<PiComputeRecord>({ prefix: "piCompute:" });
    for (const [key, record] of left) {
      const agentConversationId = Number(key.slice("piCompute:".length));
      if (this.#leases.has(agentConversationId) || record?.version !== 1) continue;
      const released = releasePiCompute(this.#computeHost(), record).catch((error: unknown) => this.#options.report(error));
      await Promise.race([released, scheduler.wait(20_000)]);
      await forgetPiCompute(this.#computeHost(), agentConversationId, record).catch(() => undefined);
      this.#options.log("pi_agent_lease_swept", { turnId: record.turnId, attemptGeneration: record.attemptGeneration });
    }
  }

  /**
   * A request from an agent's container daemon, presented with its lease's
   * one-shot credential (`/sessions/pi:<conversation>/turn-broker`): the
   * drive's sync, writes and deletes, and the lease's events (its delivered
   * files). Nothing else is served here.
   */
  async handleBroker(request: Request): Promise<Response> {
    const turnId = request.headers.get(TURN_BROKER_HEADERS.turnId) ?? "";
    const attemptGeneration = Number(request.headers.get(TURN_BROKER_HEADERS.attemptGeneration));
    if (!turnId || !Number.isSafeInteger(attemptGeneration) || attemptGeneration < 1) return brokerFailure(401);
    const recordKey = turnBrokerStorageKey({ turnId, attemptGeneration });
    const initial = await this.#options.storage.get<TurnBrokerRecord>(recordKey);
    if (!initial) return brokerFailure(401);
    const preflight = await preflightTurnBrokerRequest({ record: initial, headers: request.headers, now: Date.now() });
    if (!preflight.ok) return turnBrokerDenialResponse(preflight);
    const { target } = preflight;
    if (request.method !== target.method) return brokerFailure(403);
    const held = this.#live.get(`${turnId}:${attemptGeneration}`);
    if (!held) return brokerFailure(410);
    const engine = (await this.#agentState()).authority.execution.engine;
    if ((target.kind !== "drive" && target.kind !== "turn-event") || !turnBrokerTargetMatchesEngine(target, engine)) {
      return brokerFailure(403);
    }
    let body: Uint8Array;
    try {
      body = await readTurnBrokerRequestBody(request, target.maxBodyBytes);
    } catch (error) {
      return brokerFailure(error instanceof TurnBrokerBodyTooLargeError ? 413 : 400);
    }
    const bodySha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const { owner } = held.lease.record;
    // One claim at a time: each consumes the record's next sequence.
    const claim = this.#brokerClaims.then(async () => {
      const record = await this.#options.storage.get<TurnBrokerRecord>(recordKey);
      if (!record) return undefined;
      const claimed = await claimTurnBrokerRequest({
        record,
        live: {
          sessionId: piBrokerSessionId(owner.conversationId),
          ownerId: owner.ownerId,
          ownerGeneration: owner.ownerGeneration,
          turnId,
          attemptGeneration,
          active: this.#live.get(`${turnId}:${attemptGeneration}`) === held,
          canceled: false,
          terminal: false,
        },
        headers: request.headers,
        now: Date.now(),
        bodyBytes: body.byteLength,
        bodySha256,
      });
      if (claimed.ok && claimed.disposition === "claim") await this.#options.storage.put(recordKey, claimed.record);
      return claimed;
    });
    this.#brokerClaims = claim.catch(() => undefined);
    const claimed = await claim;
    if (!claimed) return brokerFailure(401);
    if (!claimed.ok) return turnBrokerDenialResponse(claimed);
    if (claimed.disposition !== "claim") return brokerFailure(409);
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    } catch {
      return brokerFailure(400);
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return brokerFailure(400);
    const payload = decoded as Record<string, unknown>;
    if (payload.turnId !== turnId) return brokerFailure(403);
    try {
      if (target.kind === "drive") {
        return await serveTurnDriveRequest(
          this.#options.env,
          { ownerId: owner.ownerId, ownerGeneration: owner.ownerGeneration, turnId, kind: "agent" },
          target.path,
          payload,
        );
      }
      // A container never decides that work is over.
      if (payload.terminal === true) return brokerFailure(403);
      if (payload.kind === "output_files") await this.#noteDeliveredFiles(held.threadId, payload.payload);
      else this.#options.log("pi_agent_turn_event", { threadId: held.threadId, kind: String(payload.kind).slice(0, 64) });
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      this.#options.report(error);
      return brokerFailure(502);
    }
  }

  /** The files a lease's quiesce delivered, kept for the agent's report. */
  async #noteDeliveredFiles(threadId: string, payload: unknown): Promise<void> {
    const listed = (payload as { files?: unknown } | undefined)?.files;
    if (!Array.isArray(listed)) return;
    const files: PiDeliveredFile[] = [];
    for (const entry of listed) {
      const file = entry as Record<string, unknown> | null;
      if (!file || typeof file.path !== "string") continue;
      files.push({
        path: file.path,
        name: typeof file.name === "string" ? file.name : file.path.split("/").at(-1) || file.path,
        sizeBytes: typeof file.sizeBytes === "number" ? file.sizeBytes : 0,
        contentType: typeof file.contentType === "string" ? file.contentType : "application/octet-stream",
      });
    }
    if (files.length === 0) return;
    const key = deliveredFilesKey(threadId);
    const kept = (await this.#options.storage.get<PiDeliveredFile[]>(key)) ?? [];
    const byPath = new Map(kept.map((file) => [file.path, file]));
    for (const file of files) byPath.set(file.path, file);
    await this.#options.storage.put(key, [...byPath.values()].slice(-50));
  }

  // ---- harness --------------------------------------------------------------

  /** Opens pi on this object's SQLite, once per isolate, and lets recovered work run. */
  open(): Promise<Opened> {
    this.#opening ??= (async () => {
      const kept = await this.#options.storage.get<PiAgentState>(PI_AGENT_STATE_KEY);
      if (kept) {
        this.#state = kept;
        this.#setModels(kept);
      }
      const storage = await openDurableObjectSqliteStorage(this.#options.storage);
      const { harness, refreshTools, startAgent, messageAgent, pauseAgent } = await openStellaHarness(
        {
          storage,
          models: this.#models,
          sources: this.#sources(),
          agents: this.#agents(),
          tools: this.#tools(),
          // An agent's file and shell tools run in its container, through the attached tool host.
          extensions: [piAttachedCoding((call, context) => this.#attachedTool(call, context))],
          onReport: this.#options.report,
        },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT);
      const rootSession = await this.#providerSession(harness, root.id, BACKGROUND_CONTEXT);
      // Work an eviction cut off held containers this isolate never leased.
      await this.#sweepLeases().catch((error: unknown) => this.#options.report(error));
      harness.resume();
      return { harness, root, rootSession, refreshTools, agents: { startAgent, messageAgent, pauseAgent } };
    })().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  /**
   * Bind a running turn: its transport, model and prompt material. What
   * agents need later is kept. Returns the unbind for the turn's `finally`.
   */
  async bind(binding: PiTurnBinding): Promise<() => void> {
    const offered = (tools: readonly CloudCodeSourceAgentTool[]) =>
      tools.filter((tool) => !STELLA_HARNESS_TOOL_NAMES.has(tool.name)).map(toolSpec);
    const tools = offered(await this.#turnToolsFor(binding));
    const agentTools = offered(await this.#options.agentTools(binding.authority));
    const state: PiAgentState = {
      version: 1,
      authority: binding.authority,
      models: binding.stellaModels ? [binding.stellaModels.model, binding.stellaModels.agentModel] : [],
      ...(binding.sources.skillsCatalog ? { skillsCatalog: binding.sources.skillsCatalog } : {}),
      executionContext: binding.sources.executionContext,
      tools,
      agentTools,
      ...(binding.sources.locale ? { locale: binding.sources.locale } : {}),
      lastTurnId: binding.turnId,
    };
    if (JSON.stringify(state) !== JSON.stringify(this.#state)) {
      await this.#options.storage.put(PI_AGENT_STATE_KEY, state);
      this.#state = state;
    }
    this.#setModels(state);
    (await this.#opening?.catch(() => undefined))?.refreshTools();
    this.#binding = binding;
    this.#notify("root");
    return () => {
      if (this.#binding === binding) this.#binding = undefined;
    };
  }

  /** The root conversation is the orchestrator: the turn's model and the orchestrator's tools. */
  async configureRoot(binding: PiTurnBinding, context: Context): Promise<void> {
    const { root } = await this.open();
    const agent = await root.agent(context);
    const model = this.#rootModel(binding.authority.execution);
    if (
      offersAgentTools(agent) ||
      agent.model?.provider !== model.provider ||
      agent.model?.modelId !== model.modelId ||
      agent.thinkingLevel !== binding.thinkingLevel
    ) {
      await root.configure({ ...orchestratorAgent(model), thinkingLevel: binding.thinkingLevel }, context);
    }
  }

  /** Whether pi has work in flight here: agents running, reports on their way. */
  async busy(context: Context): Promise<boolean> {
    const { harness } = await this.open();
    const inspection = await harness.inspect(context);
    return inspection.tasks.length > 0 || inspection.submissions.length > 0;
  }

  /**
   * A computer's orchestrator controlling its cloud agent here (a `piAgent`
   * turn): start it under its own thread id, message it, or pause it. The
   * turn is marked this conversation's own, so its prompt is not imported
   * as someone else's.
   */
  async originAgent(
    request: { op: "start" | "message" | "pause"; threadId: string; description?: string; originDeviceId: string },
    prompt: string,
    turnId: string,
    context: Context,
  ): Promise<void> {
    const { root, agents } = await this.open();
    await root.submit(
      {
        type: "write",
        requestId: `turn:${turnId}`,
        entry: { kind: "stella.agent-op", data: { op: request.op, threadId: request.threadId } },
      },
      context,
    );
    if (request.op === "start") {
      await agents.startAgent(
        {
          key: `origin:${request.originDeviceId}:${request.threadId}`,
          description: request.description ?? request.threadId,
          prompt,
          threadId: request.threadId,
          origin: { deviceId: request.originDeviceId },
        },
        context,
      );
    } else if (request.op === "message") {
      await agents.messageAgent(
        { key: `origin:${turnId}`, threadId: request.threadId, message: prompt, fromOrchestrator: true },
        context,
      );
    } else {
      const paused = agents.pauseAgent(request.threadId, context);
      paused.catch((error: unknown) => this.#options.report(error));
      await Promise.race([paused, waitFor(ORIGIN_PAUSE_HOLD_MS)]);
    }
  }

  /**
   * Write what other writers journaled into the root conversation before a
   * turn answers: a computer's mirrored turns, another engine's. A record of
   * a turn this conversation ran itself (submitted as `turn:<id>`) is its own,
   * and so is the turn about to run, except what a rewind dropped from its
   * context (`rewind`). `read` gives journal records after a seq. Returns
   * the seq the transcript now holds the journal through.
   */
  async importJournal(
    read: (afterSeq: number) => Promise<{ records: readonly JournalRecordLike[]; complete: boolean }>,
    currentTurnId: string,
    context: Context,
  ): Promise<number> {
    const { harness, root } = await this.open();
    const state = await harness.snapshot(JournalSyncDoc, root.id, context);
    let after = state?.importedSeq ?? -1;
    const whole = state?.importAllThrough ?? -1;
    const ran = new Map<string, boolean>();
    for (;;) {
      const page = await read(after);
      const messages: JournalMessage[] = [];
      for (const record of page.records) {
        if (record.kind !== "message" || !record.role || record.turnId === currentTurnId) continue;
        let own = record.seq <= whole ? false : ran.get(record.turnId);
        if (own === undefined) {
          own = Boolean(await root.commit((tx) => tx.submissionByRequest(root.id, `turn:${record.turnId}`), context));
          ran.set(record.turnId, own);
        }
        const message = record.payload as JournalMessage["message"] | null;
        if (own || !message || typeof message !== "object" || message.role !== record.role) continue;
        messages.push({ seq: record.seq, turnId: record.turnId, role: record.role, hidden: record.hidden === true, message });
      }
      const through: number = page.records.at(-1)?.seq ?? after;
      await importJournal(harness, root, messages, through, context);
      if (page.complete || through <= after) return through;
      after = through;
    }
  }

  /**
   * The journal was rewound to `throughSeq` (its epoch is now `epoch`): the
   * root's context starts over, and the next import brings back the whole
   * journal that is left, this conversation's own turns too. Once per epoch.
   */
  async rewind(epoch: number, throughSeq: number, context: Context): Promise<void> {
    const { harness, root } = await this.open();
    if (((await harness.snapshot(JournalSyncDoc, root.id, context))?.epoch ?? 0) >= epoch) return;
    await root.reset(undefined, context);
    await harness.commit(async (tx) => {
      const doc = await tx.doc(JournalSyncDoc, root.id);
      doc.epoch = epoch;
      doc.importedSeq = -1;
      doc.importAllThrough = throughSeq;
      return undefined;
    }, context);
  }

  /** Entries of the root conversation as they commit, from `afterEntryId` on. */
  async follow(
    afterEntryId: number,
    onEntry: (entry: EntryRecord) => void,
    context: Context,
    onTool?: (tool: PiToolActivity) => void,
  ): Promise<AgentEventStream> {
    const { harness, root } = await this.open();
    const stream = await watchEvents(harness, root.id, context);
    let last = afterEntryId;
    const take = (entry: EntryRecord) => {
      if (entry.id <= last) return;
      last = entry.id;
      onEntry(entry);
    };
    for (const entry of stream.snapshot.entries) take(entry);
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type === "message_end" || event.type === "entry_appended") take(event.entry);
        else if (event.type === "snapshot") for (const entry of event.entries) take(entry);
        else if (event.type === "tool_execution_start") {
          onTool?.({ toolCallId: event.toolCallId, name: event.toolName, phase: "start", args: event.args });
        } else if (event.type === "tool_execution_end") {
          const result = event.entry?.model?.[0] as { role?: string; isError?: boolean } | undefined;
          onTool?.({
            toolCallId: event.toolCallId,
            name: event.toolName,
            phase: "end",
            isError: result?.role === "toolResult" && result.isError === true,
          });
        }
      }
    });
    return stream;
  }

  async answer(settled: SettledSubmissionRecord, context: Context): Promise<string> {
    if (settled.status !== "done" || settled.type !== "input") return "";
    const { root } = await this.open();
    return assistantText(await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context));
  }

  // ---- the clients' view (`@stella/contracts/pi-chat`) ----------------------

  /**
   * (Re)attach the root conversation's event stream for clients: every batch
   * goes to `onEvents`, the new snapshot first, so a client attached to an
   * older stream misses nothing. Returns the snapshot widened to the newest
   * page of the whole history.
   */
  async watchForClients(
    onEvents: (events: PiChatEvent[]) => void,
    context: Context,
  ): Promise<{ snapshot: unknown; hasOlder: boolean }> {
    const { harness, root } = await this.open();
    const previous = this.#clientStream;
    const stream = await watchEvents(harness, root.id, context);
    this.#clientStream = stream;
    const [snapshot] = piEventsForClients([stream.snapshot as unknown as PiChatEvent]) as [
      Extract<PiChatEvent, { type: "snapshot" }>,
    ];
    if (previous) onEvents([snapshot]);
    stream.start(async (events) => {
      if (this.#clientStream === stream) onEvents(piEventsForClients(events as unknown as PiChatEvent[]));
    });
    await previous?.stop().catch(() => undefined);
    const page = await root.entries({}, CLIENT_HISTORY_PAGE, undefined, context);
    const history = [...page.items].reverse() as unknown as PiEntry[];
    const { entries, trimmed } = piEntriesForClients(
      mergePiEntries(history, snapshot.entries),
      CLIENT_FRAME_BYTES,
    );
    return { snapshot: { ...snapshot, entries }, hasOlder: page.next !== undefined || trimmed };
  }

  /** Whether the clients' stream is attached in this isolate. */
  get watchingForClients(): boolean {
    return this.#clientStream !== undefined;
  }

  async stopWatchingForClients(): Promise<void> {
    const stream = this.#clientStream;
    this.#clientStream = undefined;
    await stream?.stop().catch(() => undefined);
  }

  /** History before `beforeEntryId`, as clients receive it. */
  async olderForClients(beforeEntryId: number, context: Context): Promise<{ entries: PiEntry[]; hasOlder: boolean }> {
    const { root } = await this.open();
    const page = await root.entries(
      { maxEntryId: (beforeEntryId - 1) as EntryId },
      CLIENT_HISTORY_PAGE,
      undefined,
      context,
    );
    const { entries, trimmed } = piEntriesForClients(
      [...page.items].reverse() as unknown as PiEntry[],
      CLIENT_FRAME_BYTES,
    );
    return { entries, hasOlder: page.next !== undefined || trimmed };
  }

  /** Closes pi's in-memory side. Its durable state is untouched. */
  async close(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    const opened = await opening?.catch(() => undefined);
    await opened?.harness.close(BACKGROUND_CONTEXT);
  }

  /**
   * The conversation is being purged: stop every run here, and let go of
   * what they hold (leases, owner admissions, containers). Its storage goes
   * with the object's.
   */
  async discard(): Promise<number> {
    const runs = [...this.#runs.values()].flat();
    this.#runs.clear();
    const leases = [...this.#leases.keys()];
    await this.close();
    const authority = this.#state?.authority;
    // Nothing a purged conversation's agents did is saved anywhere.
    await Promise.all(
      leases.map((agentConversationId) =>
        this.#endLease(agentConversationId, { aborted: true }).catch((error: unknown) => this.#options.report(error)),
      ),
    );
    await Promise.all(
      runs.map(async (active) => {
        await active.guard?.release().catch((error: unknown) => this.#options.report(error));
        if (authority) {
          await this.#gate(authority)
            .release({ turnId: active.turnId })
            .catch((error: unknown) => this.#options.report(error));
        }
      }),
    );
    return runs.length;
  }
}
