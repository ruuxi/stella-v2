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
import { getRuntimeToolMetadata } from "@stella/runtime/kernel/agent-runtime/tool-adapters.js";
import { loadParsedAgentsFromDir } from "@stella/runtime/kernel/agents/markdown-agent-loader";
import { loadStellaRuntimeAgents } from "@stella/runtime/extensions/stella-runtime/index";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";

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
  it("ships a bundled working-agent prompt and the General execution tools", () => {
    const orchestrator = loadParsedAgentsFromDir(metadataDir).find(
      (agent) => agent.id === AGENT_IDS.ORCHESTRATOR,
    );

    expect(orchestrator?.promptSource).toBe("bundled");
    expect(orchestrator?.maxAgentDepth).toBe(1);
    expect(orchestrator?.systemPrompt).toContain(
      "You are a working agent, not a coordinator",
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
      ]),
    );
  });

  it("registers the bundled prompt offline and still preserves a customized home body", async () => {
    const { rootPath } = await createTestHost();
    const offlineAgents = loadStellaRuntimeAgents(rootPath, metadataDir);
    expect(
      offlineAgents.find((agent) => agent.id === AGENT_IDS.ORCHESTRATOR)
        ?.systemPrompt,
    ).toContain("You are Stella, the user's primary AI assistant.");

    const agentsDir = path.join(rootPath, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      path.join(agentsDir, "orchestrator.md"),
      [
        "---",
        "name: Customized Orchestrator",
        "description: stale metadata",
        "tools: spawn_agent",
        "maxAgentDepth: 9",
        "---",
        "My customized working prompt.",
      ].join("\n"),
    );

    const customized = loadStellaRuntimeAgents(rootPath, metadataDir).find(
      (agent) => agent.id === AGENT_IDS.ORCHESTRATOR,
    );
    expect(customized?.systemPrompt).toBe("My customized working prompt.");
    expect(customized?.maxAgentDepth).toBe(1);
    expect(customized?.toolsAllowlist).toContain("node_repl");
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
      "Schedule",
      "spawn_agent",
      "send_input",
      "pause_agent",
    ]) {
      expect(orchestrator.has(toolName), toolName).toBe(true);
    }

    const childGeneral = advertised(AGENT_IDS.GENERAL, true);
    expect(childGeneral.has("exec_command")).toBe(true);
    expect(childGeneral.has("node_repl")).toBe(true);
    expect(childGeneral.has("apply_patch")).toBe(true);
    expect(childGeneral.has("spawn_agent")).toBe(false);
    expect(childGeneral.has("send_input")).toBe(false);
    expect(childGeneral.has("pause_agent")).toBe(false);
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
      },
    ]);
    expect(createdTasks[0]?.modelConfigSnapshot).toEqual({
      engine: "default",
      routeModel: "stella/deepseek/v4-flash",
      reasoningEffort: "xhigh",
    });
  });
});
