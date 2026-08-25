import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { createToolHost } from "@stella/runtime/kernel/tools/host";
import type {
  ToolContext,
  ToolHostOptions,
} from "@stella/runtime/kernel/tools/types";
import {
  createPiTools,
  getRuntimeToolMetadata,
} from "@stella/runtime/kernel/agent-runtime/tool-adapters.js";
import { buildSystemPrompt } from "@stella/runtime/kernel/agent-runtime/thread-memory.js";
import { loadParsedAgentsFromDir } from "@stella/runtime/kernel/agents/markdown-agent-loader";
import { loadStellaRuntimeAgents } from "@stella/runtime/extensions/stella-runtime/index";
import { SPAWN_AGENT_MODEL_DESCRIPTION } from "@stella/runtime/kernel/tools/defs/task.js";
import { setDeveloperModeEnabled } from "@stella/runtime/kernel/preferences/local-preferences";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import {
  ORCHESTRATED_ORCHESTRATOR_ID,
  resolveAgentForWorkingMode,
} from "@stella/runtime/kernel/runner/context";

type TestHostContext = {
  rootPath: string;
  db: SqliteDatabase;
  host: ReturnType<typeof createToolHost>;
  createdTasks: Array<Record<string, unknown>>;
};

const activeContexts = new Set<TestHostContext>();
const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");
const metadataDir = path.join(
  repoRoot,
  "packages/runtime/extensions/stella-runtime/agent-metadata",
);

const createTestHost = async (
  options: Pick<
    ToolHostOptions,
    | "validateSpawnModel"
    | "validateSpawnModelWithMetadata"
    | "captureSpawnModelConfig"
  > = {},
): Promise<TestHostContext> => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-orchestrator-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(rootPath, { recursive: true });
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);

  const createdTasks: Array<Record<string, unknown>> = [];
  const host = createToolHost({
    stellaAppDir: rootPath,
    agentApi: {
      createAgent: async (request) => {
        createdTasks.push({
          description: request.description,
          prompt: request.prompt,
          agentType: request.agentType,
          ...(request.model ? { model: request.model } : {}),
          ...(request.spawnEngine ? { spawnEngine: request.spawnEngine } : {}),
          ...(request.modelConfigSnapshot
            ? { modelConfigSnapshot: request.modelConfigSnapshot }
            : {}),
        });
        return { threadId: `thread-${createdTasks.length}` };
      },
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    },
    ...options,
  });

  const context = { rootPath, db, host, createdTasks };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    await context.host.shutdown();
    context.db.close();
    await rm(context.rootPath, { recursive: true, force: true });
  }
  activeContexts.clear();
});

const makeOrchestratorContext = (): ToolContext => ({
  conversationId: "conv-1",
  deviceId: "device-1",
  requestId: "req-1",
  agentType: AGENT_IDS.ORCHESTRATOR,
  storageMode: "local",
  modelConfigSnapshot: {
    engine: "default",
    routeModel: "stella/openai/gpt-5.6-sol",
    reasoningEffort: "high",
  },
});

describe("working orchestrator surface", () => {
  it("assembles concise routing guidance without the retired memory summary", () => {
    const orchestrator = loadParsedAgentsFromDir(metadataDir).find(
      (agent) => agent.id === AGENT_IDS.ORCHESTRATOR,
    );
    const prompt = buildSystemPrompt({
      systemPrompt: orchestrator?.systemPrompt ?? "",
      dynamicContext: "runtime context",
      maxAgentDepth: orchestrator?.maxAgentDepth ?? 1,
      threadHistory: [],
      toolsAllowlist: orchestrator?.toolsAllowlist,
    });

    expect(prompt).toContain(
      "The authoritative model and engine selector list is in the `spawn_agent.model` field description. Do not invent aliases.",
    );
    expect(prompt).toContain("injected profile and memory map");
    expect(prompt).toContain("~/.stella/memories/memory_map.md");
    expect(prompt).not.toContain("memory_summary.md");
    expect(prompt).not.toContain("injected profile/summary");
    expect(prompt).not.toContain("stella/gpt-5.6-sol");
  });

  it("exposes the canonical concise model selectors in the generated tool schema", async () => {
    const { host, rootPath } = await createTestHost();
    // The spawn_agent `model` parameter is a developer-mode surface; this
    // test asserts the dev-mode (power-user) schema, so enable it explicitly.
    setDeveloperModeEnabled(rootPath, true);
    const orchestrator = loadParsedAgentsFromDir(metadataDir).find(
      (agent) => agent.id === AGENT_IDS.ORCHESTRATOR,
    );
    const tools = createPiTools({
      runId: "run-schema",
      conversationId: "conv-schema",
      agentType: AGENT_IDS.ORCHESTRATOR,
      deviceId: "device-schema",
      toolsAllowlist: orchestrator?.toolsAllowlist,
      toolCatalog: host.getToolCatalog(AGENT_IDS.ORCHESTRATOR),
      store: {} as never,
      toolExecutor: async () => ({ result: "unused" }),
    }) as Array<{
      name: string;
      parameters: {
        properties?: { model?: { description?: string } };
      };
    }>;
    const description = tools.find((tool) => tool.name === "spawn_agent")
      ?.parameters.properties?.model?.description;

    expect(description).toBe(SPAWN_AGENT_MODEL_DESCRIPTION);
    expect(description).toContain("`stella/default`");
    expect(description).toContain("`openrouter/<provider>/<model>`");
    expect(description).toContain("`codex/gpt-5.6-sol`");
    expect(description).toContain("`claude-code/fable`");
    expect(description).toContain("`claude-code/opus`");
    expect(description).toContain("`:low`, `:medium`, `:high`, or `:xhigh`");
    expect(description).not.toContain("stella/light");
    expect(description).not.toContain("stella/max");
    expect(description).not.toContain("stella/gpt-5.6-sol");
    expect(description).not.toContain("Terra");
    expect(description).not.toContain("Luna");
  });

  it("ships a bundled working-agent prompt and the General execution tools", () => {
    const orchestrator = loadParsedAgentsFromDir(metadataDir).find(
      (agent) => agent.id === AGENT_IDS.ORCHESTRATOR,
    );

    expect(orchestrator?.maxAgentDepth).toBe(1);
    expect(orchestrator?.systemPrompt).toContain(
      "Complete requests directly with your own tools.",
    );
    expect(orchestrator?.toolsAllowlist).toEqual(
      expect.arrayContaining([
        "exec_command",
        "write_stdin",
        "node_repl",
        "apply_patch",
        "web",
        "RequestCredential",
        "Read",
        "spawn_agent",
        "send_input",
        "pause_agent",
        "agent_status",
      ]),
    );
  });

  it("ships a separate coordinator prompt with two-level General ownership", () => {
    const agents = loadParsedAgentsFromDir(metadataDir);
    const orchestrated = agents.find(
      (agent) => agent.id === ORCHESTRATED_ORCHESTRATOR_ID,
    );

    expect(orchestrated?.maxAgentDepth).toBe(2);
    expect(orchestrated?.systemPrompt).toContain(
      "Execution happens through background agents",
    );
    expect(orchestrated?.toolsAllowlist).toEqual(
      expect.arrayContaining([
        "web",
        "Read",
        "Recall",
        "Remember",
        "spawn_agent",
        "send_input",
        "pause_agent",
        "agent_status",
      ]),
    );
    expect(orchestrated?.toolsAllowlist).not.toEqual(
      expect.arrayContaining([
        "exec_command",
        "write_stdin",
        "node_repl",
        "apply_patch",
      ]),
    );

    expect(
      resolveAgentForWorkingMode(agents, AGENT_IDS.ORCHESTRATOR, "direct")?.id,
    ).toBe(AGENT_IDS.ORCHESTRATOR);
    expect(
      resolveAgentForWorkingMode(agents, AGENT_IDS.ORCHESTRATOR, "orchestrated")
        ?.id,
    ).toBe(ORCHESTRATED_ORCHESTRATOR_ID);
  });

  it("registers the full bundled agent set and ignores user data-dir files", async () => {
    const { rootPath } = await createTestHost();
    const agents = loadStellaRuntimeAgents(rootPath, metadataDir);
    expect(
      agents.find((agent) => agent.id === AGENT_IDS.ORCHESTRATOR)?.systemPrompt,
    ).toContain(
      "You are Stella, the World's best Personal AI Assistant and Secretary.",
    );
    expect(
      agents.find((agent) => agent.id === ORCHESTRATED_ORCHESTRATOR_ID)
        ?.systemPrompt,
    ).toContain("Execution happens through background agents");
    expect(
      agents.find((agent) => agent.id === AGENT_IDS.GENERAL)?.systemPrompt,
    ).toBeTruthy();

    // System prompts are not user-customizable: files in the data dir never
    // register or override anything.
    const agentsDir = path.join(rootPath, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      path.join(agentsDir, "orchestrator.md"),
      "---\nname: Rogue\ntools: exec_command\n---\nrogue prompt\n",
    );
    const reloaded = loadStellaRuntimeAgents(rootPath, metadataDir);
    expect(
      reloaded.filter((agent) => agent.id === AGENT_IDS.ORCHESTRATOR),
    ).toHaveLength(1);
    expect(
      reloaded.find((agent) => agent.id === AGENT_IDS.ORCHESTRATOR)
        ?.systemPrompt,
    ).toContain("World's best Personal AI Assistant");
  });

  it("offers direct execution plus personal tools and keeps child agents one level deep", async () => {
    const { host } = await createTestHost();
    const agents = loadParsedAgentsFromDir(metadataDir);
    const advertised = (agentType: string, parentOwned = false) => {
      const agent = agents.find((candidate) => candidate.id === agentType);
      return new Set(
        getRuntimeToolMetadata({
          toolsAllowlist: agent?.toolsAllowlist,
          toolCatalog: host.getToolCatalog(agentType, { parentOwned }),
        }).map((tool) => tool.name),
      );
    };

    const orchestrator = advertised(AGENT_IDS.ORCHESTRATOR);
    for (const toolName of [
      "exec_command",
      "write_stdin",
      "node_repl",
      "apply_patch",
      "web",
      "RequestCredential",
      "Read",
      "Recall",
      "Remember",
      "spawn_agent",
      "send_input",
      "pause_agent",
      "agent_status",
    ]) {
      expect(orchestrator.has(toolName), toolName).toBe(true);
    }

    // A top-level (root-spawned) General agent is in orchestrator mode: it
    // owns subagents, so it gets the orchestration tools including the
    // read-only agent_status.
    const topLevelGeneral = advertised(AGENT_IDS.GENERAL);
    expect(topLevelGeneral.has("spawn_agent")).toBe(true);
    expect(topLevelGeneral.has("send_input")).toBe(true);
    expect(topLevelGeneral.has("pause_agent")).toBe(true);
    expect(topLevelGeneral.has("agent_status")).toBe(true);

    const childGeneral = advertised(AGENT_IDS.GENERAL, true);
    expect(childGeneral.has("exec_command")).toBe(true);
    expect(childGeneral.has("node_repl")).toBe(true);
    expect(childGeneral.has("apply_patch")).toBe(true);
    expect(childGeneral.has("spawn_agent")).toBe(false);
    expect(childGeneral.has("send_input")).toBe(false);
    expect(childGeneral.has("pause_agent")).toBe(false);
    expect(childGeneral.has("agent_status")).toBe(false);
  });

  it("keeps demoted connector tools out of the working orchestrator's direct list but direct for the coordinator", async () => {
    const { host } = await createTestHost();
    const agents = loadParsedAgentsFromDir(metadataDir);
    const directToolNames = (
      agentId: string,
      connectorProvider?: string,
    ): Set<string> => {
      const agent = agents.find((candidate) => candidate.id === agentId);
      const tools = createPiTools({
        runId: "run-1",
        conversationId: "conv-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
        deviceId: "device-1",
        ...(connectorProvider
          ? {
              connectorDeliveryTarget: {
                requestId: "remote-1",
                conversationId: "backend-conv-1",
                provider: connectorProvider,
              },
            }
          : {}),
        toolsAllowlist: agent?.toolsAllowlist,
        toolCatalog: host.getToolCatalog(AGENT_IDS.ORCHESTRATOR),
        store: {} as never,
        toolExecutor: async () => ({ result: "unused" }),
      }) as Array<{ name: string; description: string }>;
      return new Set(tools.map((tool) => tool.name));
    };

    // Working orchestrator has node_repl → demoted tools leave the direct
    // list and are advertised inside node_repl's description instead.
    const working = directToolNames(AGENT_IDS.ORCHESTRATOR);
    expect(working.has("node_repl")).toBe(true);
    expect(working.has("connector_status")).toBe(false);
    expect(working.has("schedule_add")).toBe(false);
    expect(working.has("schedule_list")).toBe(false);
    expect(working.has("ScriptDraft")).toBe(false);

    // Coordinator variant has no node_repl → never-strand fallback puts
    // demoted tools straight into its direct list.
    const orchestrated = directToolNames(ORCHESTRATED_ORCHESTRATOR_ID);
    expect(orchestrated.has("node_repl")).toBe(false);
    expect(orchestrated.has("connector_status")).toBe(true);
    expect(orchestrated.has("schedule_add")).toBe(true);
    expect(orchestrated.has("schedule_remove")).toBe(true);
  });

  it("never demotes core built-ins and keeps voice-style catalogs demoted-free", async () => {
    const { host } = await createTestHost();
    const catalog = host.getToolCatalog(AGENT_IDS.ORCHESTRATOR);
    for (const toolName of [
      "exec_command",
      "write_stdin",
      "node_repl",
      "apply_patch",
      "web",
      "Read",
      "Recall",
      "Remember",
      "spawn_agent",
    ]) {
      const entry = catalog.find((tool) => tool.name === toolName);
      expect(entry, toolName).toBeDefined();
      expect(entry?.demoted, toolName).toBeUndefined();
    }
    // The demoted surface: the connector-status affordance plus the
    // deferred scheduling tools (and the watch-script authoring tool).
    expect(
      catalog
        .filter((tool) => tool.demoted)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "ScriptDraft",
      "connector_status",
      "schedule_add",
      "schedule_list",
      "schedule_remove",
      "schedule_update",
    ]);
    // Voice paths filter demoted entries out of the realtime function list.
    const voiceCatalog = catalog.filter((tool) => !tool.demoted);
    expect(voiceCatalog.some((tool) => tool.name === "connector_status")).toBe(
      false,
    );
    expect(voiceCatalog.some((tool) => tool.name === "web")).toBe(true);
  });

  it("rejects reserved $-prefixed extension tool names and carries demoted metadata", async () => {
    const { host } = await createTestHost();
    host.registerExtensionTools([
      {
        name: "$evil",
        description: "Tries to shadow the REPL $search intrinsic.",
        parameters: { type: "object" },
        execute: async () => ({ result: "never" }),
      },
      {
        name: "ext_demoted_tool",
        description: "A demoted extension tool.",
        parameters: { type: "object" },
        demoted: { searchTerms: ["ext"] },
        execute: async () => ({ result: "ok" }),
      },
    ]);
    const catalog = host.getToolCatalog(AGENT_IDS.ORCHESTRATOR);
    expect(catalog.some((tool) => tool.name === "$evil")).toBe(false);
    const demotedExt = catalog.find((tool) => tool.name === "ext_demoted_tool");
    expect(demotedExt?.demoted).toEqual({ searchTerms: ["ext"] });
  });

  it("captures the configured General model instead of inheriting the Orchestrator model", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const { host, createdTasks } = await createTestHost({
      captureSpawnModelConfig: async (args) => {
        captured.push(args);
        return {
          engine: "default",
          routeModel: "stella/deepseek/v4-flash",
          reasoningEffort: "xhigh",
        };
      },
    });

    const result = await host.executeTool(
      "spawn_agent",
      {
        description: "Independent repository review",
        prompt: "Review the repository and report the findings.",
      },
      makeOrchestratorContext(),
    );

    expect(result.error).toBeUndefined();
    expect(captured).toEqual([
      {
        agentType: AGENT_IDS.GENERAL,
        spawnEngine: { engine: "default" },
        useConfiguredEngine: true,
      },
    ]);
    expect(createdTasks[0]?.modelConfigSnapshot).toEqual({
      engine: "default",
      routeModel: "stella/deepseek/v4-flash",
      reasoningEffort: "xhigh",
    });
  });
});
