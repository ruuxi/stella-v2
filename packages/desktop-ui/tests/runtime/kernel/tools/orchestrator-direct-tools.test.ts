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
import type { ToolContext } from "@stella/runtime/kernel/tools/types";
import { getRuntimeToolMetadata } from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import { loadParsedAgentsFromDir } from "@stella/runtime/kernel/agents/markdown-agent-loader";
import { loadStellaRuntimeAgents } from "@stella/runtime/extensions/stella-runtime/index";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";

type TestHostContext = {
  rootPath: string;
  db: SqliteDatabase;
  host: ReturnType<typeof createToolHost>;
  createdTasks: Array<Record<string, unknown>>;
  managerReports: Array<Record<string, unknown>>;
  contextLookups: Array<Record<string, unknown>>;
};

const activeContexts = new Set<TestHostContext>();
const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");

const createTestHost = async (
  validateSpawnModel?: (modelName: string) => void,
): Promise<TestHostContext> => {
  const rootPath = path.join(
    os.tmpdir(),
    `stella-orchestrator-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(path.join(rootPath), { recursive: true });

  const dbPath = getDesktopDatabasePath(rootPath);
  const db = new DatabaseSync(dbPath, {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);

  const createdTasks: Array<Record<string, unknown>> = [];
  const managerReports: Array<Record<string, unknown>> = [];
  const contextLookups: Array<Record<string, unknown>> = [];

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
      reportManager: async (request) => {
        managerReports.push(request);
        return { accepted: true, final: request.final };
      },
    },
    validateSpawnModel,
    webSearch: async (query) => ({ text: `results for ${query}` }),
    contextProvider: async (payload) => {
      contextLookups.push(payload);
      return {
        status: "found" as const,
        brief: "Relevant context for this turn.",
      };
    },
  });

  const context = {
    rootPath,
    db,
    host,
    createdTasks,
    managerReports,
    contextLookups,
  };
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

const makeToolContext = (agentType: string): ToolContext => ({
  conversationId: "conv-1",
  deviceId: "device-1",
  requestId: "req-1",
  runId: "run-1",
  agentType,
  storageMode: "local",
  ...(agentType === AGENT_IDS.MANAGER
    ? { agentId: "manager-1", attemptGeneration: 3 }
    : {}),
  ...(agentType === AGENT_IDS.ORCHESTRATOR
    ? {
        modelConfigSnapshot: {
          engine: "default" as const,
          routeModel: "stella/openai/gpt-5.6-sol",
          reasoningEffort: "high" as const,
        },
      }
    : {}),
});

describe("orchestrator direct tool surface", () => {
  it("keeps orchestrator capabilities readable by the pre-metadata-only loader", () => {
    const agents = loadParsedAgentsFromDir(
      path.join(
        repoRoot,
        "packages/runtime/extensions/stella-runtime/agent-metadata",
      ),
    );
    const orchestrator = agents.find((agent) => agent.id === "orchestrator");

    expect(orchestrator?.toolsAllowlist).toEqual(
      expect.arrayContaining([
        "spawn_agent",
        "spawn_manager",
        "send_input",
        "pause_agent",
      ]),
    );
  });

  it("overlays shipped capability metadata onto customized home prompt bodies", async () => {
    const { host, rootPath } = await createTestHost();
    const agentsDir = path.join(rootPath, "agents");
    await mkdir(agentsDir, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(agentsDir, "orchestrator.md"),
        [
          "---",
          "name: Customized Orchestrator",
          "description: stale orchestrator metadata",
          "tools: spawn_agent, send_input, pause_agent",
          "maxAgentDepth: 1",
          "---",
          "My customized orchestrator prompt.",
        ].join("\n"),
      ),
      writeFile(
        path.join(agentsDir, "manager.md"),
        [
          "---",
          "name: Customized Manager",
          "description: overly broad manager metadata",
          "tools: spawn_agent, spawn_manager, send_input, pause_agent, report",
          "maxAgentDepth: 9",
          "---",
          "My customized manager prompt.",
        ].join("\n"),
      ),
      writeFile(
        path.join(agentsDir, "general.md"),
        [
          "---",
          "name: Customized General",
          "description: overly broad general metadata",
          "tools: spawn_agent, spawn_manager, send_input, pause_agent",
          "maxAgentDepth: 9",
          "---",
          "My customized general prompt.",
        ].join("\n"),
      ),
    ]);

    const agents = loadStellaRuntimeAgents(
      rootPath,
      path.join(
        repoRoot,
        "packages/runtime/extensions/stella-runtime/agent-metadata",
      ),
    );
    const advertisedToolNames = (agentType: string) => {
      const agent = agents.find((candidate) => candidate.id === agentType);
      expect(agent).toBeDefined();
      return getRuntimeToolMetadata({
        toolsAllowlist: agent?.toolsAllowlist,
        toolCatalog: host.getToolCatalog(agentType),
      }).map((tool) => tool.name);
    };

    expect(
      agents.find((agent) => agent.id === "orchestrator")?.systemPrompt,
    ).toBe("My customized orchestrator prompt.");
    expect(advertisedToolNames("orchestrator")).toEqual(
      expect.arrayContaining([
        "spawn_agent",
        "spawn_manager",
        "send_input",
        "pause_agent",
      ]),
    );
    expect(advertisedToolNames("manager")).toEqual([
      "spawn_agent",
      "send_input",
      "pause_agent",
      "report",
    ]);
    const generalToolNames = advertisedToolNames("general");
    for (const coordinationTool of [
      "spawn_agent",
      "spawn_manager",
      "send_input",
      "pause_agent",
      "report",
    ]) {
      expect(generalToolNames).not.toContain(coordinationTool);
    }
  });

  it("shows direct coordination tools only to the orchestrator", async () => {
    const { host } = await createTestHost();

    const orchestratorTools = new Set(
      host.getToolCatalog("orchestrator").map((tool) => tool.name),
    );
    expect(orchestratorTools.has("Recall")).toBe(true);
    expect(orchestratorTools.has("Remember")).toBe(true);
    expect(orchestratorTools.has("search_threads")).toBe(false);
    expect(orchestratorTools.has("spawn_agent")).toBe(true);
    expect(orchestratorTools.has("spawn_manager")).toBe(true);
    expect(orchestratorTools.has("send_input")).toBe(true);
    expect(orchestratorTools.has("pause_agent")).toBe(true);
    expect(orchestratorTools.has("report")).toBe(false);
    expect(orchestratorTools.has("Display")).toBe(false);
    expect(orchestratorTools.has("DisplayGuidelines")).toBe(false);
    expect(orchestratorTools.has("image_gen")).toBe(true);
    expect(orchestratorTools.has("web")).toBe(true);
    expect(orchestratorTools.has("tool_search")).toBe(true);
    expect(orchestratorTools.has("linq_send_message")).toBe(false);
    expect(orchestratorTools.has("Memory")).toBe(false);
    expect(orchestratorTools.has("MemoryNote")).toBe(false);
    expect(orchestratorTools.has("askQuestion")).toBe(false);
    expect(orchestratorTools.has("AskUserQuestion")).toBe(false);
    expect(orchestratorTools.has("Fashion")).toBe(false);

    const spawnAgentTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "spawn_agent");
    const sendInputTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "send_input");
    const spawnManagerTool = host
      .getToolCatalog("orchestrator")
      .find((tool) => tool.name === "spawn_manager");
    const spawnAgentProperties = spawnAgentTool?.parameters.properties as
      | Record<string, unknown>
      | undefined;
    expect(spawnAgentProperties?.agent_type).toBeUndefined();
    expect(spawnAgentProperties?.group).toBeUndefined();
    expect(spawnAgentProperties?.model).toMatchObject({ type: "string" });
    expect(
      spawnAgentTool?.parameters.required as string[] | undefined,
    ).not.toContain("model");
    expect(spawnManagerTool?.parameters).toMatchObject({
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    });
    expect(
      Object.keys(
        (spawnManagerTool?.parameters.properties as Record<string, unknown>) ??
          {},
      ),
    ).toEqual(["prompt"]);
    expect(
      (sendInputTool?.parameters.properties as Record<string, unknown>)
        .description,
    ).toMatchObject({
      description:
        "One short, user-friendly sentence summarizing what this work is about.",
    });
    expect(
      Object.keys(
        (sendInputTool?.parameters.properties as Record<string, unknown>) ?? {},
      ),
    ).toEqual(["thread_id", "description", "message"]);
    expect(sendInputTool?.parameters.required).toEqual([
      "thread_id",
      "description",
      "message",
    ]);
    expect(
      sendInputTool?.parameters.required as string[] | undefined,
    ).toContain("description");

    const generalTools = new Set(
      host.getToolCatalog("general").map((tool) => tool.name),
    );
    expect(generalTools.has("spawn_agent")).toBe(false);
    expect(generalTools.has("spawn_manager")).toBe(false);
    expect(generalTools.has("report")).toBe(false);
    const managerTools = new Set(
      host.getToolCatalog("manager").map((tool) => tool.name),
    );
    expect(managerTools.has("report")).toBe(true);
    expect(generalTools.has("linq_send_message")).toBe(false);
    expect(generalTools.has("Display")).toBe(false);
    expect(generalTools.has("DisplayGuidelines")).toBe(false);
    expect(generalTools.has("Memory")).toBe(false);
    expect(generalTools.has("MemoryNote")).toBe(false);
    expect(generalTools.has("Recall")).toBe(false);
    expect(generalTools.has("Remember")).toBe(false);
    expect(generalTools.has("import_source")).toBe(false);
    expect(generalTools.has("askQuestion")).toBe(false);
    expect(generalTools.has("AskUserQuestion")).toBe(false);
    expect(generalTools.has("exec_command")).toBe(true);
    expect(generalTools.has("write_stdin")).toBe(true);
    expect(generalTools.has("apply_patch")).toBe(true);
    expect(generalTools.has("web")).toBe(true);
    expect(generalTools.has("RequestCredential")).toBe(true);
    expect(generalTools.has("view_image")).toBe(true);
    expect(generalTools.has("image_gen")).toBe(false);

    const claudeCodeGeneralTools = new Set(
      host
        .getToolCatalog("general", {
          model: {
            api: "openai-responses",
            provider: "openai",
            id: "gpt-5",
            name: "gpt-5",
          },
          agentEngine: "claude_code_local",
        })
        .map((tool) => tool.name),
    );
    expect(claudeCodeGeneralTools.has("apply_patch")).toBe(false);
    expect(claudeCodeGeneralTools.has("Write")).toBe(true);
    expect(claudeCodeGeneralTools.has("Edit")).toBe(true);

    const claudeCodeOrchestratorTools = new Set(
      host
        .getToolCatalog("orchestrator", {
          model: {
            api: "openai-responses",
            provider: "openai",
            id: "gpt-5",
            name: "gpt-5",
          },
          agentEngine: "claude_code_local",
        })
        .map((tool) => tool.name),
    );
    expect(claudeCodeOrchestratorTools.has("apply_patch")).toBe(false);
    expect(claudeCodeOrchestratorTools.has("Write")).toBe(true);
    expect(claudeCodeOrchestratorTools.has("Edit")).toBe(true);

    const generalImageResult = await host.executeTool(
      "image_gen",
      { prompt: "Generate a small test image." },
      makeToolContext("general"),
    );
    expect(generalImageResult.error).toContain(
      "image_gen is only available to the orchestrator",
    );

    // Store agent now lives on the backend — the local runtime exposes
    // none of its tools and the orchestrator no longer has a `Store`
    // delegation tool. Sanity-check that's still the case.
    expect(orchestratorTools.has("Store")).toBe(false);

    const fashionTools = new Set(
      host.getToolCatalog("fashion").map((tool) => tool.name),
    );
    expect(fashionTools.has("FashionGetContext")).toBe(true);
    expect(fashionTools.has("FashionSearchProducts")).toBe(true);
    expect(fashionTools.has("FashionCreateOutfit")).toBe(true);
    expect(fashionTools.has("FashionMarkOutfitReady")).toBe(true);
    expect(fashionTools.has("Fashion")).toBe(false);
    expect(fashionTools.has("image_gen")).toBe(true);
  });

  it("executes report only for a fenced Manager context", async () => {
    const { host, managerReports } = await createTestHost();
    await expect(
      host.executeTool(
        "report",
        { message: "Halfway" },
        makeToolContext(AGENT_IDS.MANAGER),
      ),
    ).resolves.toMatchObject({ details: { accepted: true, final: false } });
    expect(managerReports).toEqual([
      expect.objectContaining({
        threadId: "manager-1",
        message: "Halfway",
        final: false,
        attemptGeneration: 3,
      }),
    ]);

    for (const agentType of [AGENT_IDS.GENERAL, AGENT_IDS.ORCHESTRATOR]) {
      await expect(
        host.executeTool(
          "report",
          { message: "Not allowed", final: true },
          makeToolContext(agentType),
        ),
      ).resolves.toMatchObject({
        error: expect.stringMatching(/only available to the Manager/i),
      });
    }
    expect(managerReports).toHaveLength(1);
  });

  it("gives managers only agent-management tools and prevents deeper nesting", async () => {
    const { host } = await createTestHost();
    const managerCoordinationTools = host
      .getToolCatalog("manager")
      .filter((tool) =>
        ["spawn_agent", "spawn_manager", "send_input", "pause_agent"].includes(
          tool.name,
        ),
      )
      .map((tool) => tool.name)
      .sort();
    expect(managerCoordinationTools).toEqual([
      "pause_agent",
      "send_input",
      "spawn_agent",
    ]);

    const nestedResult = await host.executeTool(
      "spawn_agent",
      { description: "Nested work", prompt: "Should not run." },
      makeToolContext("general"),
    );
    expect(nestedResult.error).toContain("only available");
  });

  it("keeps deferred Linq tools hidden unless explicitly requested by the runtime", async () => {
    const { host } = await createTestHost();

    const visibleTools = new Set(
      host.getToolCatalog("orchestrator").map((tool) => tool.name),
    );
    const runtimeTools = new Set(
      host
        .getToolCatalog("orchestrator", { includeDeferred: true })
        .map((tool) => tool.name),
    );

    expect(visibleTools.has("linq_send_message")).toBe(false);
    expect(runtimeTools.has("linq_send_message")).toBe(true);
    expect(runtimeTools.has("linq_react_to_message")).toBe(true);
  });

  it("executes Recall for the orchestrator and rejects other agents", async () => {
    const { host, contextLookups } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "Recall",
      {
        prompt: "Find context for what the user means by yesterday's tab.",
        memorySearchTerms: ["yesterday", "tab"],
      },
      makeToolContext("orchestrator"),
    );

    expect(orchestratorResult.error).toBeUndefined();
    expect(orchestratorResult.result).toEqual({
      status: "found",
      brief: "Relevant context for this turn.",
    });
    expect(contextLookups).toHaveLength(1);
    expect(contextLookups[0]).toMatchObject({
      conversationId: "conv-1",
      requestId: "req-1",
      runId: "run-1",
      prompt: "Find context for what the user means by yesterday's tab.",
      memorySearchTerms: ["yesterday", "tab"],
      agentType: "orchestrator",
      modelConfigSnapshot: {
        engine: "default",
        routeModel: "stella/openai/gpt-5.6-sol",
        reasoningEffort: "high",
      },
    });

    const generalResult = await host.executeTool(
      "Recall",
      { prompt: "Find context." },
      makeToolContext("general"),
    );

    expect(generalResult.error).toContain("only available to the orchestrator");

    const missingPromptResult = await host.executeTool(
      "Recall",
      {},
      makeToolContext("orchestrator"),
    );
    expect(missingPromptResult.error).toContain("Recall prompt is required");
  });

  it("executes spawn_agent directly for the orchestrator and rejects other agents", async () => {
    const { host, createdTasks } = await createTestHost();

    const orchestratorResult = await host.executeTool(
      "spawn_agent",
      {
        description: "Add a notes page.",
        prompt: "Build the requested notes experience.",
      },
      makeToolContext("orchestrator"),
    );

    expect(orchestratorResult.error).toBeUndefined();
    expect(orchestratorResult.result).toMatchObject({
      thread_id: "thread-1",
      created: true,
      running_in_background: true,
    });
    expect(createdTasks).toEqual([
      {
        description: "Add a notes page.",
        prompt: "Build the requested notes experience.",
        agentType: "general",
      },
    ]);

    const generalResult = await host.executeTool(
      "spawn_agent",
      {
        description: "Should fail",
        prompt: "This agent should not have direct task creation.",
      },
      makeToolContext("general"),
    );

    expect(generalResult.error).toContain("only available to the orchestrator");
  });

  it("executes spawn_manager with the configured default", async () => {
    const { host, createdTasks } = await createTestHost();
    const result = await host.executeTool(
      "spawn_manager",
      { prompt: "Coordinate three checks and return one report." },
      makeToolContext("orchestrator"),
    );
    expect(result).toMatchObject({
      result: { thread_id: "thread-1", created: true },
    });
    expect(createdTasks).toEqual([
      {
        description: "Coordinate three checks and return one report.",
        prompt: "Coordinate three checks and return one report.",
        agentType: "manager",
        modelConfigSnapshot: {
          engine: "default",
          routeModel: "stella/openai/gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
    ]);
  });

  it("fails spawn_agent loudly when the model override cannot be routed", async () => {
    const { host, createdTasks } = await createTestHost(() => {
      throw new Error('No provider route for model "banana/split".');
    });

    const result = await host.executeTool(
      "spawn_agent",
      {
        description: "Should fail",
        prompt: "This spawn names an unroutable model.",
        model: "banana/split",
      },
      makeToolContext("orchestrator"),
    );

    expect(result.error).toBe('No provider route for model "banana/split".');
    expect(createdTasks).toEqual([]);
  });

  it("forwards per-spawn model and engine selections to createAgent", async () => {
    const { host, createdTasks } = await createTestHost(() => {});

    await host.executeTool(
      "spawn_agent",
      {
        description: "Cheap bulk pass",
        prompt: "Process the files.",
        model: "stella/light",
      },
      makeToolContext("orchestrator"),
    );
    await host.executeTool(
      "spawn_agent",
      {
        description: "Repo work",
        prompt: "Fix the bug.",
        model: "claude-code/opus",
      },
      makeToolContext("orchestrator"),
    );

    expect(createdTasks).toEqual([
      expect.objectContaining({ model: "stella/light" }),
      expect.objectContaining({
        spawnEngine: { engine: "claude_code_local", model: "opus" },
      }),
    ]);
  });
});
