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
  type EnvTarget,
  type Harness,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { ShellExecutionEnv, type ShellBackend } from "@stella/agent/env/shell-env";
import { openStellaHarness, orchestratorAgent, stellaModelRef } from "@stella/agent/harness";
import {
  stellaProvider,
  type StellaGatewayAccess,
  type StellaModelSpec,
  type StellaRequestRoute,
} from "@stella/agent/provider/stella";
import { StellaAgentDoc } from "@stella/agent/stella/agent-doc";
import type { AgentReport, AgentRun, StellaAgentsHost } from "@stella/agent/stella/agents";
import { STELLA_CODING_TOOL_NAMES } from "@stella/agent/stella/coding";
import type { StellaContextSources, StellaMemory } from "@stella/agent/stella/context";
import { placementOf, StellaPlacementDoc } from "@stella/agent/stella/placement";
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
import { mintTurnCapability } from "./capability-signer.js";
import {
  fetchWithManagedCancellation,
  type ModelGatewayControl,
} from "./managed-request-cancellation.js";
import { bundledPrompt } from "./prompts/bundled.js";
import { sandboxClient, type SandboxHandle } from "./sandbox-client.js";
import { agentSandboxId, WORLD_ROOT, worldName } from "./workspace.js";

/** How long recovered work waits for its turn or agent run to bind a transport. */
const BINDING_WAIT_MS = 120_000;
/** A run's capability is minted again when less than this is left of it. */
const CAPABILITY_RENEW_MS = 60_000;
/** How long an agent waits for one of the owner's container slots. */
const CONTAINER_SLOT_WAIT_MS = 10 * 60_000;
const CONTAINER_SLOT_POLL_MS = 5_000;
/** A command without its own timeout. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
/** Storage key of what agents need between turns. */
const PI_AGENT_STATE_KEY = "piAgentState";
/** The newest entries a client starts from, and per older page. */
const CLIENT_HISTORY_PAGE = 200;
/** A client frame of entries stays well under the socket's message limit. */
const CLIENT_FRAME_BYTES = 512 * 1024;

export type PiStellaExecution = Extract<CloudExecutionSelection, { engine: "stella" }>;

/** Whose agents these are, as the latest chat turn admitted them. */
export type PiAuthority = {
  ownerId: string;
  ownerGeneration: string;
  /** The Stella conversation (this object's name). */
  conversationId: string;
  audience: ManagedModelAudience;
  budgetMicroCents: number;
  execution: PiStellaExecution;
};

/** What an agent needs when no turn is bound: kept in storage. */
type PiAgentState = {
  version: 1;
  authority: PiAuthority;
  /** The provider's models: the orchestrator's and the general agent's. */
  models: StellaModelSpec[];
  skillsCatalog?: string;
  executionContext: ExecutionContextSnapshot;
};

export type PiTurnSources = {
  orchestratorPrompt: string;
  personality: string | undefined;
  memory: StellaMemory;
  skillsCatalog: string | undefined;
  executionContext: ExecutionContextSnapshot;
};

export type PiTurnBinding = {
  turnId: string;
  capability: string;
  fetch: typeof fetch;
  authority: PiAuthority;
  /** The orchestrator's model, and the same alias for its agents. */
  model: StellaModelSpec;
  agentModel: StellaModelSpec;
  thinkingLevel: ModelThinkingLevel;
  sources: PiTurnSources;
};

export type PiRuntimeEnv = Pick<Cloudflare.Env, "OWNER_GATES"> &
  Partial<
    Pick<
      Cloudflare.Env,
      | "Sandbox"
      | "MODEL_GATEWAY"
      | "MODEL_GATEWAY_CONTROL"
      | "CAPABILITY_SIGNING_KEY"
      | "CAPABILITY_SIGNING_KID"
      | "SANDBOX_IDLE_TIMEOUT_MS"
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
  deliverReport(report: AgentReport, authority: PiAuthority): Promise<void>;
  /** Keep this object waking while agents run. */
  heartbeat(): void;
};

/** A pi call context: cancelled with `signal`, which only cancels that call or wait. */
export const contextFor = (signal?: AbortSignal): Context =>
  signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

export const thinkingLevelFor = (effort: AgentModelReasoningEffort): ModelThinkingLevel =>
  effort === "default" || effort === "none" ? "off" : effort;

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

const base64ToBytes = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
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
};

/** An agent's container, from its first command until its last run ends. */
type AgentContainer = {
  sandboxId: string;
  handle: SandboxHandle;
  env: ShellExecutionEnv;
  /** Set once the owner gate gave this container a slot. */
  slot?: Promise<void>;
};

type Opened = { harness: Harness; root: Conversation; rootSession: string };

export class PiConversationRuntime {
  readonly #options: PiRuntimeOptions;
  readonly #models = createModels();
  #opening: Promise<Opened> | undefined;
  #binding: PiTurnBinding | undefined;
  #state: PiAgentState | undefined;
  #modelKey: string | undefined;
  /** Agent runs by their conversation's provider session id. */
  readonly #runs = new Map<string, ActiveRun[]>();
  readonly #containers = new Map<number, AgentContainer>();
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
    return await fetchWithManagedCancellation({
      request: withBearer(request, capability),
      capability,
      control: control as unknown as ModelGatewayControl,
      waitUntil: (work) => this.#options.waitUntil(work),
      fetch: (value) => gateway.fetch(value),
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

  #setModels(models: readonly StellaModelSpec[]): void {
    const key = JSON.stringify(models);
    if (key === this.#modelKey) return;
    this.#models.setProvider(stellaProvider({ access: this.#access(), models }));
    this.#modelKey = key;
  }

  #sources(): StellaContextSources {
    // The orchestrator answers only inside a turn; agents also between turns.
    const turn = async (): Promise<PiTurnSources> => (await this.#turn()).sources;
    return {
      env: "cloud",
      agentPrompt: async (id) => (id === "agents/orchestrator.md" ? (await turn()).orchestratorPrompt : bundledPrompt(id)),
      personality: async () => (await turn()).personality,
      memory: async () => (await turn()).memory,
      skillsCatalog: async () => this.#binding?.sources.skillsCatalog ?? (await this.#agentState()).skillsCatalog,
      executionContext: async () =>
        this.#binding?.sources.executionContext ?? (await this.#agentState()).executionContext,
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
        return caller.kind === "cloud"
          ? { error: `A cloud agent cannot start an agent on device ${destination.deviceId} yet.` }
          : { error: `This conversation cannot start an agent on device ${destination.deviceId} yet.` };
      },
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
        const active: ActiveRun = {
          run,
          turnId,
          sessionId: await this.#providerSession(harness, run.agentConversationId, context),
          capability: await this.#mint(authority, turnId),
        };
        const runs = this.#runs.get(active.sessionId) ?? [];
        runs.push(active);
        this.#runs.set(active.sessionId, runs);
        this.#notify(active.sessionId);
        this.#options.heartbeat();
        this.#options.log("pi_agent_run_started", { threadId: run.threadId, turnId });
      },
      endAgentRun: async (run) => {
        let ended: ActiveRun | undefined;
        for (const [sessionId, runs] of this.#runs) {
          const index = runs.findIndex((active) => active.run.runId === run.runId);
          if (index < 0) continue;
          [ended] = runs.splice(index, 1);
          if (runs.length === 0) this.#runs.delete(sessionId);
          break;
        }
        const authority = this.#state?.authority;
        if (!authority) return;
        await this.#gate(authority)
          .release({ turnId: ended?.turnId ?? `pi:${authority.conversationId}:${run.runId}` })
          .catch((error: unknown) => this.#options.report(error));
        const busy = [...this.#runs.values()].some((runs) =>
          runs.some((active) => active.run.agentConversationId === run.agentConversationId),
        );
        if (!busy) await this.#releaseContainer(run).catch((error: unknown) => this.#options.report(error));
        this.#options.log("pi_agent_run_ended", { threadId: run.threadId, turnId: ended?.turnId });
      },
      deliverReport: async (report) => {
        const { authority } = await this.#agentState();
        await this.#options.deliverReport(report, authority);
      },
    };
  }

  // ---- agent containers -----------------------------------------------------

  /** The ExecutionEnv of a conversation: its container for a cloud agent; none for the orchestrator. */
  async #env({ conversationId, read }: EnvTarget, context: Context): Promise<ShellExecutionEnv | undefined> {
    const placement = placementOf(await read.snapshot(StellaPlacementDoc, conversationId, context));
    if (placement?.kind !== "cloud") return undefined;
    const existing = this.#containers.get(conversationId);
    if (existing) return existing.env;
    const role = await read.snapshot(StellaAgentDoc, conversationId, context);
    return (await this.#container(conversationId, role?.threadId ?? String(conversationId))).env;
  }

  /** An agent's container, one per agent thread. Nothing starts until its first command. */
  async #container(conversationId: ConversationId, threadId: string): Promise<AgentContainer> {
    const { authority } = await this.#agentState();
    const namespace = this.#options.env.Sandbox;
    if (!namespace) throw new Error("Cloud containers are not configured.");
    // Thread ids are unique per conversation; the container is per agent.
    const sandboxId = await agentSandboxId(authority.ownerId, `pi:${authority.conversationId}:${threadId}`);
    const world = await worldName(authority.ownerId);
    const existing = this.#containers.get(conversationId);
    if (existing) return existing;
    const idle = Number(this.#options.env.SANDBOX_IDLE_TIMEOUT_MS);
    const handle = sandboxClient(namespace, sandboxId, {
      size: "small",
      workload: "world",
      ...(Number.isSafeInteger(idle) && idle > 0 ? { idleTimeoutMs: idle } : {}),
      world,
    });
    const container: AgentContainer = {
      sandboxId,
      handle,
      env: new ShellExecutionEnv(this.#sandboxBackend(sandboxId, handle, () => this.#takeSlot(container, authority))),
    };
    this.#containers.set(conversationId, container);
    return container;
  }

  /**
   * Before the container's first command: one of the owner's agent container
   * slots, then the workspace directory commands run in.
   */
  #takeSlot(container: AgentContainer, authority: PiAuthority, signal?: AbortSignal): Promise<void> {
    container.slot ??= (async () => {
      const deadline = Date.now() + CONTAINER_SLOT_WAIT_MS;
      for (;;) {
        const slot = await this.#gate(authority).acquireAgentContainer({ sandboxId: container.sandboxId });
        if (slot.ok) {
          // A fresh container has no workspace yet; a command cannot start in a missing directory.
          try {
            await container.handle.mkdir(WORLD_ROOT, { recursive: true });
          } catch (error) {
            await this.#gate(authority)
              .releaseAgentContainer({ sandboxId: container.sandboxId })
              .catch(() => undefined);
            throw error;
          }
          return;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Your cloud is already running ${slot.limit} agents' workspaces, its limit. This agent waited ${CONTAINER_SLOT_WAIT_MS / 60_000} minutes for one of them to finish.`,
          );
        }
        await waitFor(CONTAINER_SLOT_POLL_MS, signal);
      }
    })().catch((error: unknown) => {
      container.slot = undefined;
      throw error;
    });
    return container.slot;
  }

  /**
   * After an agent's last run: snapshot and stop its container for the
   * owner's next agent container, then free its slot. By the agent's id, not
   * by what this isolate started: an isolate lost to an eviction may have
   * started it. Both steps are no-ops for a container that never ran.
   */
  async #releaseContainer(run: AgentRun): Promise<void> {
    const authority = this.#state?.authority;
    if (!authority) return;
    const container = await this.#container(run.agentConversationId, run.threadId);
    this.#containers.delete(run.agentConversationId);
    await container.handle.release().catch((error: unknown) => this.#options.report(error));
    await this.#gate(authority)
      .releaseAgentContainer({ sandboxId: container.sandboxId })
      .catch((error: unknown) => this.#options.report(error));
  }

  #sandboxBackend(sandboxId: string, handle: SandboxHandle, slot: () => Promise<void>): ShellBackend {
    return {
      id: `sandbox:${sandboxId}`,
      cwd: WORLD_ROOT,
      exec: async (command, options) => {
        await slot();
        const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
        const result = await handle
          .exec(command, {
            cwd: options.cwd ?? WORLD_ROOT,
            ...(options.env ? { env: options.env } : {}),
            timeout: timeoutMs,
          })
          .catch((error: unknown) => {
            this.#options.log("pi_agent_exec_failed", {
              sandbox: sandboxId.slice(0, 16),
              cwd: options.cwd ?? WORLD_ROOT,
              message: error instanceof Error ? error.message : String(error),
            });
            throw error;
          });
        // `timeout(1)` exits 124 when it stops the command.
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.exitCode === 124 };
      },
      readFile: async (path) => {
        await slot();
        try {
          const file = await handle.readFile(path, { encoding: "base64" });
          return base64ToBytes(file.content);
        } catch (error) {
          if (!(await handle.exists(path)).exists) return undefined;
          throw error;
        }
      },
      writeFile: async (path, bytes) => {
        await slot();
        await handle.writeFile(path, bytesToBase64(bytes), { encoding: "base64" });
      },
    };
  }

  // ---- harness --------------------------------------------------------------

  /** Opens pi on this object's SQLite, once per isolate, and lets recovered work run. */
  open(): Promise<Opened> {
    this.#opening ??= (async () => {
      const kept = await this.#options.storage.get<PiAgentState>(PI_AGENT_STATE_KEY);
      if (kept) {
        this.#state = kept;
        this.#setModels(kept.models);
      }
      const storage = await openDurableObjectSqliteStorage(this.#options.storage);
      const { harness } = await openStellaHarness(
        {
          storage,
          models: this.#models,
          sources: this.#sources(),
          agents: this.#agents(),
          env: (target, context) => this.#env(target, context),
          onReport: this.#options.report,
        },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT);
      const rootSession = await this.#providerSession(harness, root.id, BACKGROUND_CONTEXT);
      harness.resume();
      return { harness, root, rootSession };
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
    const state: PiAgentState = {
      version: 1,
      authority: binding.authority,
      models: [binding.model, binding.agentModel],
      ...(binding.sources.skillsCatalog ? { skillsCatalog: binding.sources.skillsCatalog } : {}),
      executionContext: binding.sources.executionContext,
    };
    if (JSON.stringify(state) !== JSON.stringify(this.#state)) {
      await this.#options.storage.put(PI_AGENT_STATE_KEY, state);
      this.#state = state;
    }
    this.#setModels(state.models);
    this.#binding = binding;
    this.#notify("root");
    return () => {
      if (this.#binding === binding) this.#binding = undefined;
    };
  }

  /** The root conversation is the orchestrator: the turn's model, no file or shell tools. */
  async configureRoot(binding: PiTurnBinding, context: Context): Promise<void> {
    const { root } = await this.open();
    const agent = await root.agent(context);
    const model = stellaModelRef("orchestrator", binding.model.alias);
    const coding = agent.tools.some((tool) => (STELLA_CODING_TOOL_NAMES as readonly string[]).includes(tool.name));
    if (
      coding ||
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

  /** Entries of the root conversation as they commit, from `afterEntryId` on. */
  async follow(
    afterEntryId: number,
    onEntry: (entry: EntryRecord) => void,
    context: Context,
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
}
