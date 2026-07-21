import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { LocalAgentManager } from "@stella/runtime/kernel/agents/local-agent-manager";
import { updateLocalModelPreferences } from "@stella/runtime/kernel/preferences/local-preferences";
import { resolveEffectiveAgentExecutionConfig } from "@stella/runtime/kernel/runner/context";
import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import { SessionStore } from "@stella/runtime/kernel/storage/session-store";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import type { ToolResult } from "@stella/runtime/kernel/tools/types";

const roots = new Set<string>();
const databases = new Set<SqliteDatabase>();

afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const createRoot = (label: string): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), `stella-${label}-`));
  roots.add(root);
  return root;
};

const stellaRoute = (modelId: string) =>
  ({
    route: "stella",
    model: {
      id: modelId,
      provider: "stella",
      contextWindow: 128_000,
      reasoning: true,
    },
    getApiKey: () => "test-key",
  }) as any;

const providerRoute = (provider: string, modelId: string) =>
  ({
    route: "direct",
    model: {
      id: modelId,
      provider,
      contextWindow: 128_000,
    },
    getApiKey: () => "test-key",
  }) as any;

describe("General spawn-time execution config", () => {
  it("captures omitted, explicit Codex, pinned Codex, direct-provider, and closed-model routes", () => {
    const root = createRoot("general-route-capture");
    updateLocalModelPreferences(root, {
      agentRuntimeEngine: "codex_cli",
      codexModel: "gpt-5.6-sol",
      codexModelExplicit: true,
      codexReasoningEffort: "high",
      claudeCodeModel: "sonnet",
      claudeCodeReasoningEffort: "medium",
    });
    const context = { stellaDataDir: root } as any;
    const base = {
      agentType: AGENT_IDS.GENERAL,
      model: "stella/gpt-5.6-sol",
      resolvedLlm: stellaRoute("gpt-5.6-sol"),
    };

    const omitted = resolveEffectiveAgentExecutionConfig(context, base);
    expect(omitted.modelConfigSnapshot).toEqual({
      engine: "codex_cli",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    const explicitCodex = resolveEffectiveAgentExecutionConfig(context, {
      ...base,
      spawnEngine: { engine: "codex_cli" },
    });
    expect(explicitCodex.modelConfigSnapshot).toEqual({
      engine: "codex_cli",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
      reasoningEffort: "high",
      executionProfile: "spawn_override",
    });

    const pinnedCodex = resolveEffectiveAgentExecutionConfig(context, {
      ...base,
      spawnEngine: { engine: "codex_cli", model: "gpt-5.7-codex" },
      spawnReasoningEffort: "xhigh",
    });
    expect(pinnedCodex.modelConfigSnapshot).toEqual({
      engine: "codex_cli",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "gpt-5.7-codex",
      reasoningEffort: "xhigh",
      executionProfile: "spawn_override",
    });

    const direct = resolveEffectiveAgentExecutionConfig(context, {
      agentType: AGENT_IDS.GENERAL,
      model: "openrouter/moonshotai/kimi-k2.5",
      resolvedLlm: providerRoute("openrouter", "moonshotai/kimi-k2.5"),
      spawnEngine: { engine: "default" },
    });
    expect(direct.modelConfigSnapshot).toEqual({
      engine: "default",
      routeModel: "openrouter/moonshotai/kimi-k2.5",
      reasoningEffort: "default",
      executionProfile: "spawn_override",
    });

    const closedModel = resolveEffectiveAgentExecutionConfig(context, {
      ...base,
      spawnEngine: { engine: "claude_code_local", model: "opus" },
      spawnReasoningEffort: "medium",
    });
    expect(closedModel.modelConfigSnapshot).toEqual({
      engine: "claude_code_local",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "opus",
      reasoningEffort: "medium",
      executionProfile: "spawn_override",
    });
  });

  it("keeps a captured Codex route authoritative after preferences change and never selects the provider runtime", () => {
    const root = createRoot("general-route-preference-change");
    updateLocalModelPreferences(root, {
      agentRuntimeEngine: "codex_cli",
      codexModel: "gpt-5.6-sol",
      codexModelExplicit: true,
      codexReasoningEffort: "high",
    });
    const context = { stellaDataDir: root } as any;
    const captured = resolveEffectiveAgentExecutionConfig(context, {
      agentType: AGENT_IDS.GENERAL,
      model: "stella/gpt-5.6-sol",
      resolvedLlm: stellaRoute("gpt-5.6-sol"),
      spawnEngine: { engine: "codex_cli", model: "gpt-5.7-codex" },
      spawnReasoningEffort: "xhigh",
    }).modelConfigSnapshot!;

    updateLocalModelPreferences(root, {
      agentRuntimeEngine: "default",
      codexModel: "gpt-future-global",
      codexModelExplicit: true,
      codexReasoningEffort: "low",
    });
    const resumed = resolveEffectiveAgentExecutionConfig(context, {
      agentType: AGENT_IDS.GENERAL,
      model: captured.routeModel,
      resolvedLlm: stellaRoute("gpt-5.6-sol"),
      modelConfigSnapshot: captured,
    });

    expect(resumed.agentEngine).toBe("codex_cli");
    expect(resumed.modelConfigSnapshot).toEqual(captured);
    expect(resumed.restoredSpawnEngine).toEqual({
      engine: "codex_cli",
      model: "gpt-5.7-codex",
    });
  });

  it("persists default effort as a concrete choice instead of reading a later agent effort", () => {
    const root = createRoot("general-route-default-effort");
    updateLocalModelPreferences(root, {
      agentRuntimeEngine: "default",
      reasoningEfforts: { [AGENT_IDS.GENERAL]: "default" },
    });
    const context = { stellaDataDir: root } as any;
    const captured = resolveEffectiveAgentExecutionConfig(context, {
      agentType: AGENT_IDS.GENERAL,
      model: "openai/gpt-5.6-sol",
      resolvedLlm: providerRoute("openai", "gpt-5.6-sol"),
      spawnEngine: { engine: "default" },
    }).modelConfigSnapshot!;
    expect(captured.reasoningEffort).toBe("default");

    updateLocalModelPreferences(root, {
      reasoningEfforts: { [AGENT_IDS.GENERAL]: "xhigh" },
    });
    const resumed = resolveEffectiveAgentExecutionConfig(context, {
      agentType: AGENT_IDS.GENERAL,
      model: captured.routeModel,
      resolvedLlm: providerRoute("openai", "gpt-5.6-sol"),
      modelConfigSnapshot: captured,
    });
    expect(resumed.effectiveReasoningEffort).toBe("default");
    expect(resumed.modelConfigSnapshot).toEqual(captured);
  });
});

type MutableSelection = {
  engine: AgentModelConfigSnapshot["engine"];
  routeModel: string;
  engineModel?: string;
  reasoningEffort?: AgentModelConfigSnapshot["reasoningEffort"];
};

const snapshotResolver =
  (selection: MutableSelection) =>
  async (args: {
    model?: string;
    spawnEngine?: {
      engine: AgentModelConfigSnapshot["engine"];
      model?: string;
    };
    spawnReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  }): Promise<AgentModelConfigSnapshot> => {
    if (args.spawnEngine) {
      return {
        engine: args.spawnEngine.engine,
        routeModel: args.model ?? selection.routeModel,
        ...(args.spawnEngine.engine !== "default"
          ? {
              engineModel:
                args.spawnEngine.model ?? selection.engineModel ?? "configured",
            }
          : {}),
        ...(args.spawnReasoningEffort
          ? { reasoningEffort: args.spawnReasoningEffort }
          : selection.reasoningEffort
            ? { reasoningEffort: selection.reasoningEffort }
            : {}),
        executionProfile: "spawn_override",
      };
    }
    return { ...selection };
  };

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for agent");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

const createStore = () => {
  const root = createRoot("general-route-store");
  const db = new DatabaseSync(getDesktopDatabasePath(root), {
    timeout: 5_000,
  }) as unknown as SqliteDatabase;
  databases.add(db);
  initializeDesktopDatabase(db);
  return { root, store: new SessionStore(db) };
};

const createManager = (args: {
  store: SessionStore;
  selection: MutableSelection;
  fetched: Array<AgentModelConfigSnapshot | undefined>;
  blockThread?: string;
  blockGate?: Promise<void>;
}) =>
  new LocalAgentManager({
    maxConcurrent: 1,
    resolveTaskThread: (request) =>
      args.store.resolveOrCreateActiveThread(request),
    listActiveThreads: (conversationId) =>
      args.store.listActiveThreads(conversationId),
    resolveAgentModelConfig: snapshotResolver(args.selection),
    fetchAgentContext: async (request) => {
      args.fetched.push(request.modelConfigSnapshot);
      return {
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
        modelConfigSnapshot: request.modelConfigSnapshot,
        agentEngine: request.modelConfigSnapshot?.engine,
      };
    },
    runSubagent: async (request) => {
      if (request.agentId === args.blockThread && args.blockGate) {
        await args.blockGate;
      }
      return { runId: request.userMessageId, result: "done" };
    },
    toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
    createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
    completeCloudAgentRecord: async () => undefined,
    getCloudAgentRecord: async () => null,
    cancelCloudAgentRecord: async () => ({ canceled: false }),
    saveAgentRecord: (record) => args.store.saveAgentRecord(record),
    getAgentRecord: (threadId) => args.store.getAgentRecord(threadId),
    listAgentRecordsByStatus: (status) =>
      args.store.listAgentRecordsByStatus(status),
  });

describe("General durable model identity", () => {
  it("freezes omitted defaults before enqueue and preserves them for queued execution and follow-up", async () => {
    const { store } = createStore();
    const selection: MutableSelection = {
      engine: "codex_cli",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    };
    const fetched: Array<AgentModelConfigSnapshot | undefined> = [];
    let releaseBlock!: () => void;
    const blockGate = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const manager = createManager({
      store,
      selection,
      fetched,
      blockThread: "occupy-the-slot",
      blockGate,
    });

    await manager.createAgent({
      conversationId: "conversation-freeze",
      threadId: "occupy-the-slot",
      description: "Block",
      prompt: "Wait",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const spawned = await manager.createAgent({
      conversationId: "conversation-freeze",
      threadId: "frozen-default",
      description: "Frozen default",
      prompt: "Use the spawn route",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    const frozen = store.getAgentRecord(spawned.threadId)?.modelConfigSnapshot;
    expect(frozen).toEqual({
      engine: "codex_cli",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    selection.engine = "default";
    selection.routeModel = "openai/gpt-future-global";
    selection.engineModel = undefined;
    selection.reasoningEffort = "low";
    releaseBlock();
    await waitFor(
      () => store.getAgentRecord(spawned.threadId)?.status === "completed",
    );
    expect(fetched).toContainEqual(frozen);

    const generationBeforeFollowUp =
      store.getAgentRecord(spawned.threadId)?.attemptGeneration ?? 0;
    await manager.sendAgentMessage(
      spawned.threadId,
      "Follow up on the same durable thread.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitFor(
      () =>
        (store.getAgentRecord(spawned.threadId)?.attemptGeneration ?? 0) >
          generationBeforeFollowUp &&
        store.getAgentRecord(spawned.threadId)?.status === "completed",
    );
    expect(store.getAgentRecord(spawned.threadId)?.modelConfigSnapshot).toEqual(
      frozen,
    );
    expect(fetched.at(-1)).toEqual(frozen);
  });

  it("round-trips explicit engines/models through restart rehydration without provider fallback", async () => {
    const { store } = createStore();
    const selection: MutableSelection = {
      engine: "codex_cli",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
      reasoningEffort: "high",
    };
    const firstFetches: Array<AgentModelConfigSnapshot | undefined> = [];
    let releaseManager!: () => void;
    const managerGate = new Promise<void>((resolve) => {
      releaseManager = resolve;
    });
    const first = createManager({
      store,
      selection,
      fetched: firstFetches,
      blockThread: "durable-manager-owner",
      blockGate: managerGate,
    });
    await first.createAgent({
      conversationId: "conversation-restart",
      threadId: "durable-manager-owner",
      description: "Durable manager owner",
      prompt: "Wait for the child",
      agentType: AGENT_IDS.MANAGER,
      storageMode: "local",
    });
    const spawned = await first.createAgent({
      conversationId: "conversation-restart",
      threadId: "pinned-codex",
      description: "Pinned Codex",
      prompt: "Run pinned",
      agentType: AGENT_IDS.GENERAL,
      spawnEngine: { engine: "codex_cli", model: "gpt-5.7-codex" },
      spawnReasoningEffort: "xhigh",
      parentAgentId: "durable-manager-owner",
      storageMode: "local",
    });
    releaseManager();
    await waitFor(
      () => store.getAgentRecord(spawned.threadId)?.status === "completed",
    );
    const frozen = store.getAgentRecord(spawned.threadId)?.modelConfigSnapshot;
    expect(frozen).toEqual({
      engine: "codex_cli",
      routeModel: "stella/gpt-5.6-sol",
      engineModel: "gpt-5.7-codex",
      reasoningEffort: "xhigh",
      executionProfile: "spawn_override",
    });

    selection.engine = "default";
    selection.routeModel = "openai/gpt-direct-later";
    selection.engineModel = undefined;
    selection.reasoningEffort = "low";
    const restartedFetches: Array<AgentModelConfigSnapshot | undefined> = [];
    const restarted = createManager({
      store,
      selection,
      fetched: restartedFetches,
    });
    const generationBeforeRestart =
      store.getAgentRecord(spawned.threadId)?.attemptGeneration ?? 0;
    await restarted.sendAgentMessage(
      spawned.threadId,
      "Resume after worker restart.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitFor(
      () =>
        (store.getAgentRecord(spawned.threadId)?.attemptGeneration ?? 0) >
          generationBeforeRestart &&
        store.getAgentRecord(spawned.threadId)?.status === "completed",
    );

    expect(restartedFetches).toEqual([frozen]);
    expect(store.getAgentRecord(spawned.threadId)).toMatchObject({
      parentAgentId: "durable-manager-owner",
      modelConfigSnapshot: frozen,
    });
    expect(
      (await restarted.getAgent(spawned.threadId))?.modelConfigSnapshot,
    ).toEqual(frozen);
  });

  it("heals a legacy null General row once and keeps the backfill across later restarts", async () => {
    const { store } = createStore();
    store.resolveOrCreateActiveThread({
      conversationId: "conversation-legacy",
      agentType: AGENT_IDS.GENERAL,
      threadId: "legacy-general",
      nameHint: "Legacy General",
    });
    store.saveAgentRecord({
      threadId: "legacy-general",
      conversationId: "conversation-legacy",
      agentType: AGENT_IDS.GENERAL,
      description: "Legacy General",
      agentDepth: 1,
      status: "completed",
      attemptGeneration: 1,
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2,
    });
    const selection: MutableSelection = {
      engine: "codex_cli",
      routeModel: "stella/gpt-legacy-healed",
      engineModel: "gpt-legacy-healed",
      reasoningEffort: "medium",
    };
    const firstFetches: Array<AgentModelConfigSnapshot | undefined> = [];
    const first = createManager({ store, selection, fetched: firstFetches });
    const firstGeneration =
      store.getAgentRecord("legacy-general")?.attemptGeneration ?? 0;
    await first.sendAgentMessage(
      "legacy-general",
      "Heal and resume.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    const healed = store.getAgentRecord("legacy-general")?.modelConfigSnapshot;
    expect(healed).toEqual({ ...selection });
    await waitFor(
      () =>
        (store.getAgentRecord("legacy-general")?.attemptGeneration ?? 0) >
          firstGeneration &&
        store.getAgentRecord("legacy-general")?.status === "completed",
    );

    selection.engine = "default";
    selection.routeModel = "openai/drifted-later";
    selection.engineModel = undefined;
    selection.reasoningEffort = "low";
    const secondFetches: Array<AgentModelConfigSnapshot | undefined> = [];
    const second = createManager({ store, selection, fetched: secondFetches });
    const secondGeneration =
      store.getAgentRecord("legacy-general")?.attemptGeneration ?? 0;
    await second.sendAgentMessage(
      "legacy-general",
      "Resume again.",
      "orchestrator",
      { deliveryKind: "external-input" },
    );
    await waitFor(
      () =>
        (store.getAgentRecord("legacy-general")?.attemptGeneration ?? 0) >
          secondGeneration &&
        store.getAgentRecord("legacy-general")?.status === "completed",
    );

    expect(secondFetches).toEqual([healed]);
    expect(store.getAgentRecord("legacy-general")?.modelConfigSnapshot).toEqual(
      healed,
    );
  });
});
