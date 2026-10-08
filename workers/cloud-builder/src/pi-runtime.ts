/**
 * Stella's pi-durable harness inside the conversation's Durable Object.
 *
 * The harness lives on this object's SQLite (`openDurableObjectSqliteStorage`),
 * beside the journal; pi's tables (`conversations`, `entries`, `tasks`,
 * `submissions`, `documents`, ...) do not collide with the journal's. The
 * orchestrator chat is pi's root conversation.
 *
 * A turn binds what pi needs from the turn plane: the turn's model
 * capability and guarded gateway transport (owner fence, model grant,
 * managed cancellation, all unchanged), and the prompt material the turn
 * prepared (served prompt, personality, memory, skills, execution context).
 * Work pi runs without a bound turn, such as a request recovered right
 * after an eviction, waits briefly for the resumed turn to bind again.
 *
 * Loaded lazily, like the rest of the loop, so object wake stays lean.
 */
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  watchEvents,
  type AgentEventStream,
  type Conversation,
  type EntryRecord,
  type Harness,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { openStellaHarness, stellaModelRef } from "@stella/agent/harness";
import {
  stellaProvider,
  type StellaGatewayAccess,
  type StellaModelSpec,
} from "@stella/agent/provider/stella";
import type { StellaContextSources, StellaMemory } from "@stella/agent/stella/context";
import type { AgentModelReasoningEffort } from "@stella/contracts/agent-engine";
import type { ExecutionContextSnapshot } from "@stella/contracts/execution-context";
import { gatewayRelayBaseUrl } from "@stella/contracts/gateway/api";

/** How long recovered work waits for a resumed turn to bind its transport. */
const BINDING_WAIT_MS = 120_000;

export type PiTurnSources = {
  orchestratorPrompt: string;
  generalPrompt?: string;
  personality: string | undefined;
  memory: StellaMemory;
  skillsCatalog: string | undefined;
  executionContext: ExecutionContextSnapshot;
};

export type PiTurnBinding = {
  turnId: string;
  capability: string;
  fetch: typeof fetch;
  model: StellaModelSpec;
  thinkingLevel: ModelThinkingLevel;
  sources: PiTurnSources;
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

type Opened = { harness: Harness; root: Conversation };

export class PiConversationRuntime {
  readonly #storage: DurableObjectStorage;
  readonly #gatewayOrigin: string;
  readonly #report: (error: unknown) => void;
  readonly #models = createModels();
  #opening: Promise<Opened> | undefined;
  #binding: PiTurnBinding | undefined;
  #bound: Array<() => void> = [];
  #modelKey: string | undefined;

  constructor(options: { storage: DurableObjectStorage; gatewayOrigin: string; report: (error: unknown) => void }) {
    this.#storage = options.storage;
    this.#gatewayOrigin = options.gatewayOrigin;
    this.#report = options.report;
  }

  /** The bound turn, or the one recovered work is waiting for. */
  async #turn(signal?: AbortSignal | null): Promise<PiTurnBinding> {
    if (this.#binding) return this.#binding;
    const timeout = AbortSignal.timeout(BINDING_WAIT_MS);
    const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return await new Promise<PiTurnBinding>((resolve, reject) => {
      const onStop = () => {
        cleanup();
        reject(
          signal?.aborted
            ? (signal.reason ?? new Error("aborted"))
            : new Error("No Stella turn is running to carry this model request."),
        );
      };
      const ready = () => {
        cleanup();
        resolve(this.#binding!);
      };
      const cleanup = () => {
        stop.removeEventListener("abort", onStop);
        this.#bound = this.#bound.filter((entry) => entry !== ready);
      };
      if (stop.aborted) return onStop();
      stop.addEventListener("abort", onStop, { once: true });
      this.#bound.push(ready);
    });
  }

  #access(): StellaGatewayAccess {
    return {
      relayBaseUrl: gatewayRelayBaseUrl(this.#gatewayOrigin),
      capability: async (signal) => (await this.#turn(signal)).capability,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return (await this.#turn(signal)).fetch(input, init);
      }) as typeof fetch,
    };
  }

  #sources(): StellaContextSources {
    const sources = (): PiTurnSources => {
      if (!this.#binding) throw new Error("No Stella turn is bound.");
      return this.#binding.sources;
    };
    return {
      env: "cloud",
      agentPrompt: async (id) =>
        id === "agents/orchestrator.md" ? sources().orchestratorPrompt : sources().generalPrompt,
      personality: async () => sources().personality,
      memory: async () => sources().memory,
      skillsCatalog: async () => sources().skillsCatalog,
      executionContext: async () => sources().executionContext,
    };
  }

  /** Opens pi on this object's SQLite, once per isolate, and lets recovered work run. */
  open(): Promise<Opened> {
    this.#opening ??= (async () => {
      const storage = await openDurableObjectSqliteStorage(this.#storage);
      const { harness } = await openStellaHarness(
        {
          storage,
          models: this.#models,
          sources: this.#sources(),
          onReport: this.#report,
        },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT);
      harness.resume();
      return { harness, root };
    })().catch((error: unknown) => {
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }

  /**
   * Bind a running turn: its transport, model and prompt material. Returns
   * the unbind for the turn's `finally`.
   */
  bind(binding: PiTurnBinding): () => void {
    const key = `${binding.model.agentType}:${binding.model.alias}:${binding.model.protocol}:${binding.model.contextWindow ?? ""}:${binding.model.maxOutputTokens ?? ""}`;
    if (key !== this.#modelKey) {
      this.#models.setProvider(stellaProvider({ access: this.#access(), models: [binding.model] }));
      this.#modelKey = key;
    }
    this.#binding = binding;
    for (const ready of this.#bound.splice(0)) ready();
    return () => {
      if (this.#binding === binding) this.#binding = undefined;
    };
  }

  /** The root conversation's stored agent follows the turn's model choice. */
  async configureRoot(binding: PiTurnBinding, context: Context): Promise<void> {
    const { root } = await this.open();
    const agent = await root.agent(context);
    const model = stellaModelRef("orchestrator", binding.model.alias);
    if (
      agent.model?.provider !== model.provider ||
      agent.model?.modelId !== model.modelId ||
      agent.thinkingLevel !== binding.thinkingLevel
    ) {
      await root.configure({ model, thinkingLevel: binding.thinkingLevel }, context);
    }
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

  /** Closes pi's in-memory side. Its durable state is untouched. */
  async close(): Promise<void> {
    const opening = this.#opening;
    this.#opening = undefined;
    const opened = await opening?.catch(() => undefined);
    await opened?.harness.close(BACKGROUND_CONTEXT);
  }
}
