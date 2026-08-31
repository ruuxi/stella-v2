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
import { estimateProviderPayloadTokens } from "@stella/runtime/kernel/agent-runtime/context-budget.js";
import { buildSystemPrompt } from "@stella/runtime/kernel/agent-runtime/thread-memory.js";
import { loadParsedAgentsFromDir } from "@stella/runtime/kernel/agents/markdown-agent-loader";
import { loadStellaRuntimeAgents } from "@stella/runtime/extensions/stella-runtime/index";
import { SPAWN_AGENT_MODEL_DESCRIPTION } from "@stella/runtime/kernel/tools/defs/task.js";
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
const BUILT_IN_DEMOTED_TOOL_NAMES = [
  "schedule_add",
  "schedule_list",
  "schedule_update",
  "schedule_remove",
  "ScriptDraft",
  "connector_status",
] as const;

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
  it("describes unified Recall and retained profile memory only", () => {
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
    expect(prompt).toContain(
      "Every query searches and merges both thread and transcript history",
    );
    expect(prompt).toContain("~/.stella/memories/profile.md");
    expect(prompt).not.toContain("memory_map.md");
    expect(prompt).not.toContain("MEMORY.md");
    expect(prompt).not.toContain("memory_summary.md");
    expect(prompt).not.toContain("stella/gpt-5.6-sol");
  });

  it("exposes the canonical concise model selectors in the generated tool schema", async () => {
    const { host } = await createTestHost();
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

  it("ships the bundled coordinator prompt and its bounded tools", () => {
    const orchestrator = loadParsedAgentsFromDir(metadataDir).find(
      (agent) => agent.id === AGENT_IDS.ORCHESTRATOR,
    );

    expect(orchestrator?.maxAgentDepth).toBe(2);
    expect(orchestrator?.systemPrompt).toContain(
      "Execution happens through background agents",
    );
    expect(orchestrator?.toolsAllowlist).toEqual(
      expect.arrayContaining([
        "code",
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
    expect(orchestrator?.toolsAllowlist).not.toEqual(
      expect.arrayContaining(["exec_command", "write_stdin", "apply_patch"]),
    );
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
      agents.find((agent) => agent.id === AGENT_IDS.ORCHESTRATOR)?.systemPrompt,
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

  it("offers coordinator tools and keeps child agents one level deep", async () => {
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
      "code",
      "web",
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
    expect(childGeneral.has("code")).toBe(true);
    expect(childGeneral.has("apply_patch")).toBe(true);
    expect(childGeneral.has("spawn_agent")).toBe(false);
    expect(childGeneral.has("send_input")).toBe(false);
    expect(childGeneral.has("pause_agent")).toBe(false);
    expect(childGeneral.has("agent_status")).toBe(false);
  });

  it("builds the real orchestrated provider request with only the bounded deferred surface", async () => {
    const { host } = await createTestHost();
    const agents = loadParsedAgentsFromDir(metadataDir);
    const orchestrated = agents.find(
      (agent) => agent.id === AGENT_IDS.ORCHESTRATOR,
    );
    const buildProviderTools = (toolsAllowlist: string[] | undefined) =>
      createPiTools({
        runId: "run-1",
        conversationId: "conv-1",
        agentType: AGENT_IDS.ORCHESTRATOR,
        deviceId: "device-1",
        toolsAllowlist,
        toolCatalog: host.getToolCatalog(AGENT_IDS.ORCHESTRATOR),
        store: {} as never,
        toolExecutor: async () => ({ result: "unused" }),
      }) as Array<{
        name: string;
        description: string;
        parameters: unknown;
      }>;

    const providerTools = buildProviderTools(orchestrated?.toolsAllowlist);
    expect(providerTools.map((tool) => tool.name).sort()).toEqual([
      "Read",
      "Recall",
      "Remember",
      "agent_status",
      "code",
      "html",
      "image_gen",
      "pause_agent",
      "send_input",
      "spawn_agent",
      "web",
    ]);
    for (const toolName of BUILT_IN_DEMOTED_TOOL_NAMES) {
      expect(
        providerTools.some((tool) => tool.name === toolName),
        toolName,
      ).toBe(false);
    }
    expect(providerTools.some((tool) => tool.name === "map")).toBe(false);
    const code = providerTools.find((tool) => tool.name === "code");
    for (const toolName of BUILT_IN_DEMOTED_TOOL_NAMES) {
      expect(code?.description, toolName).toContain(`tools.${toolName}(`);
    }
    expect(code?.description).toContain("tools.map(");

    // Reconstruct the no-code profile to prove the never-strand fallback
    // and account for the exact provider payload reduction.
    const fallbackTools = buildProviderTools(
      orchestrated?.toolsAllowlist?.filter((name) => name !== "code"),
    );
    expect(fallbackTools.map((tool) => tool.name).sort()).toEqual([
      "Read",
      "Recall",
      "Remember",
      "ScriptDraft",
      "agent_status",
      "connector_status",
      "html",
      "image_gen",
      "map",
      "pause_agent",
      "schedule_add",
      "schedule_list",
      "schedule_remove",
      "schedule_update",
      "send_input",
      "spawn_agent",
      "web",
    ]);
    const deferredTokens = estimateProviderPayloadTokens(
      {
        tools: providerTools,
      },
      1,
    );
    const fallbackTokens = estimateProviderPayloadTokens(
      {
        tools: fallbackTools,
      },
      1,
    );
    expect(providerTools).toHaveLength(11);
    expect(fallbackTools).toHaveLength(17);
    expect(deferredTokens).toBeLessThan(fallbackTokens);
    expect(fallbackTokens - deferredTokens).toBeGreaterThan(1_000);

    const schemaMarker = `HOST_ONLY_FULL_SCHEMA_${"z".repeat(12_000)}`;
    host.registerExtensionTools([
      {
        name: "schema_bloat_probe",
        description: "Deferred provider accounting probe.",
        parameters: {
          type: "object",
          properties: {
            nested: {
              type: "object",
              properties: {
                value: { type: "string", description: schemaMarker },
              },
            },
          },
        },
        demoted: { searchTerms: ["schema accounting probe"] },
        execute: async () => ({ result: "unused" }),
      },
    ]);
    const deferredWithProbe = buildProviderTools(orchestrated?.toolsAllowlist);
    const fallbackWithProbe = buildProviderTools(
      orchestrated?.toolsAllowlist?.filter((name) => name !== "code"),
    );
    expect(
      deferredWithProbe.some((tool) => tool.name === "schema_bloat_probe"),
    ).toBe(false);
    expect(JSON.stringify(deferredWithProbe)).not.toContain(schemaMarker);
    expect(JSON.stringify(fallbackWithProbe)).toContain(schemaMarker);
    expect(
      estimateProviderPayloadTokens({ tools: deferredWithProbe }, 1),
    ).toBeLessThan(
      estimateProviderPayloadTokens({ tools: fallbackWithProbe }, 1),
    );
  });

  it("never demotes core built-ins and preserves the voice map fallback", async () => {
    const { host } = await createTestHost();
    const catalog = host.getToolCatalog(AGENT_IDS.ORCHESTRATOR);
    expect(Object.values(AGENT_IDS)).not.toContain("dream");
    expect(catalog.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["Dream", "StrReplace"]),
    );
    for (const toolName of [
      "exec_command",
      "write_stdin",
      "code",
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
    // The demoted surface: connector status, scheduling, watch-script
    // authoring, and map. code lifts map details back onto its outer
    // result so the existing inline artifact contract remains intact.
    expect(
      catalog
        .filter((tool) => tool.demoted)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      "ScriptDraft",
      "connector_status",
      "map",
      "schedule_add",
      "schedule_list",
      "schedule_remove",
      "schedule_update",
    ]);
    // Voice has no code tool: background/configuration deferred tools stay
    // out, while map retains its eager fallback.
    const voiceCatalog = catalog.filter(
      (tool) => !tool.demoted || tool.name === "map",
    );
    expect(voiceCatalog.some((tool) => tool.name === "connector_status")).toBe(
      false,
    );
    expect(voiceCatalog.some((tool) => tool.name === "map")).toBe(true);
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

  it("describes the real nested schedule union only on demand", async () => {
    const { host, rootPath } = await createTestHost();
    const result = await host.executeTool(
      "code",
      {
        code: [
          'const docs = await tools.$describe("schedule_add");',
          "nodeRepl.write(JSON.stringify(docs));",
        ].join("\n"),
      },
      {
        ...makeOrchestratorContext(),
        agentId: "agent-schedule-describe",
        stellaAppDir: rootPath,
        allowedToolNames: ["code", "schedule_add"],
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toContain('"name":"schedule_add"');
    expect(result.result).toContain('"inputSchema"');
    expect(result.result).toContain('"oneOf"');
    expect(result.result).toContain('"const":"at"');
    expect(result.result).toContain('"atMs"');
    expect(result.result).toContain('"const":"every"');
    expect(result.result).toContain('"everyMs"');
    expect(result.result).toContain('"anchorMs"');
    expect(result.result).toContain('"const":"cron"');
    expect(result.result).toContain('"expr"');
    expect(result.result).toContain('"tz"');
    expect(result.result).not.toContain("Record<string, unknown>");
  });

  it("searches, fully describes, and invokes a connector-gated GitHub action", async () => {
    const { host, rootPath } = await createTestHost();
    const invocations: Array<Record<string, unknown>> = [];
    const toolName = "github_create_pull_request";
    host.registerExtensionTools([
      {
        name: toolName,
        description:
          "Create a GitHub pull request with reviewers and merge options.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["repository", "title", "head", "base", "reviewers"],
          properties: {
            repository: {
              type: "object",
              additionalProperties: false,
              required: ["owner", "name"],
              properties: {
                owner: { type: "string", minLength: 1 },
                name: { type: "string", minLength: 1 },
              },
            },
            title: { type: "string", minLength: 1, maxLength: 256 },
            head: { type: "string", minLength: 1 },
            base: { type: "string", minLength: 1, default: "main" },
            reviewers: {
              type: "array",
              minItems: 1,
              items: {
                oneOf: [
                  {
                    type: "object",
                    required: ["login"],
                    properties: {
                      login: { type: "string", minLength: 1 },
                      role: {
                        type: "string",
                        enum: ["reviewer", "maintainer"],
                      },
                    },
                  },
                  { type: "string", minLength: 1 },
                ],
              },
            },
            draft: { type: "boolean", default: false },
          },
        },
        outputSchema: {
          type: "object",
          required: ["number", "url"],
          properties: {
            number: { type: "integer", minimum: 1 },
            url: { type: "string", format: "uri" },
          },
        },
        approval: { required: false },
        sideEffects: { creates: ["pull_request"] },
        reversible: false,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
        demoted: {
          requiredConnectorProvider: "github",
          searchTerms: ["github pull request create pr"],
        },
        execute: async (args) => {
          invocations.push(args);
          return {
            result: {
              number: 42,
              url: "https://github.com/fromyou/stella/pull/42",
            },
          };
        },
      },
    ]);

    const allowedContext: ToolContext = {
      ...makeOrchestratorContext(),
      agentId: "agent-github-action",
      stellaAppDir: rootPath,
      allowedToolNames: ["code", toolName],
      connectorDeliveryTarget: {
        requestId: "connector-request-1",
        conversationId: "connector-conversation-1",
        provider: "github",
      },
    };
    const result = await host.executeTool(
      "code",
      {
        code: [
          'const hit = (await tools.$search({ query: "create github pull request" }))[0];',
          "const compact = JSON.stringify(hit);",
          "const docs = await tools.$describe(hit.name);",
          `const outcome = await tools[hit.name](${JSON.stringify({
            repository: { owner: "fromyou", name: "stella" },
            title: "Deferred schema docs",
            head: "feature/deferred-schema",
            base: "main",
            reviewers: [{ login: "rahul", role: "maintainer" }],
            draft: false,
          })});`,
          "nodeRepl.write(JSON.stringify({ compact, docs, outcome }));",
        ].join("\n"),
      },
      allowedContext,
    );

    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.result ?? "{}");
    const compact = JSON.parse(payload.compact);
    expect(compact.name).toBe(toolName);
    expect(Object.keys(compact).sort()).toEqual([
      "access",
      "description",
      "dotNotation",
      "name",
      "signature",
    ]);
    expect(compact.access).toBe(`tools.${toolName}`);
    expect(compact.dotNotation).toBe(true);
    expect(compact).not.toHaveProperty("inputSchema");
    expect(
      payload.docs.inputSchema.properties.reviewers.items.oneOf,
    ).toHaveLength(2);
    expect(
      payload.docs.inputSchema.properties.reviewers.items.oneOf[0].properties
        .role.enum,
    ).toEqual(["reviewer", "maintainer"]);
    expect(payload.docs.inputSchema.properties.base.default).toBe("main");
    expect(payload.docs.inputSchema.properties.title.maxLength).toBe(256);
    expect(payload.docs.outputSchema.required).toEqual(["number", "url"]);
    expect(payload.docs.approval).toEqual({ required: false });
    expect(payload.docs.sideEffects).toEqual({ creates: ["pull_request"] });
    expect(payload.docs.reversible).toBe(false);
    expect(payload.docs.annotations.readOnlyHint).toBe(false);
    expect(payload.outcome).toMatchObject({ number: 42 });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      repository: { owner: "fromyou", name: "stella" },
      reviewers: [{ login: "rahul", role: "maintainer" }],
    });

    const denied = await host.executeTool(
      "code",
      { code: `await tools.$describe("${toolName}")` },
      {
        ...allowedContext,
        agentId: "agent-github-action-denied",
        connectorDeliveryTarget: undefined,
      },
    );
    expect(denied.error).toContain("unknown or not available");
    expect(denied.error).not.toContain("reviewers");

    const unknown = await host.executeTool(
      "code",
      { code: 'await tools.$describe("github_nonexistent_secret_action")' },
      allowedContext,
    );
    expect(unknown.error).toContain("unknown or not available");
    expect(unknown.error).not.toContain("inputSchema");
  });

  it("retrieves an oversized full schema through deterministic lossless pages", async () => {
    const { host, rootPath } = await createTestHost();
    const marker = `schema-start:${"z".repeat(280_000)}:schema-end`;
    host.registerExtensionTools([
      {
        name: "oversized_schema_probe",
        description: "Exercise lossless on-demand schema paging.",
        parameters: {
          type: "object",
          properties: {
            value: { type: "string", description: marker },
          },
        },
        demoted: { searchTerms: ["oversized schema"] },
        execute: async () => ({ result: "unused" }),
      },
    ]);

    const result = await host.executeTool(
      "code",
      {
        code: [
          'const name = "oversized_schema_probe";',
          "let page = await tools.$describe(name);",
          "const chunks = [];",
          "const pageStates = [];",
          "let expectedHash = page.sha256;",
          "let expectedChars = page.totalChars;",
          "while (page && page.format === 'lossless-json-chunks') {",
          "  chunks.push(page.chunk);",
          "  pageStates.push({ cursor: page.cursor, complete: page.complete, nextCursor: page.nextCursor });",
          "  if (page.sha256 !== expectedHash || page.totalChars !== expectedChars) throw new Error('paging metadata drifted');",
          "  if (page.nextCursor === undefined) break;",
          "  page = await tools.$describe(name, { cursor: page.nextCursor });",
          "}",
          "const combined = chunks.join('');",
          "const docs = JSON.parse(combined);",
          "const description = docs.inputSchema.properties.value.description;",
          "nodeRepl.write(JSON.stringify({ pages: pageStates.length, pageStates, combinedLength: combined.length, expectedChars, markerLength: description.length, starts: description.startsWith('schema-start:'), ends: description.endsWith(':schema-end') }));",
        ].join("\n"),
      },
      {
        ...makeOrchestratorContext(),
        agentId: "agent-oversized-schema",
        stellaAppDir: rootPath,
        allowedToolNames: ["code", "oversized_schema_probe"],
      },
    );

    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(result.result ?? "{}");
    expect(parsed.pages).toBeGreaterThan(1);
    expect(parsed.combinedLength).toBe(parsed.expectedChars);
    expect(parsed.markerLength).toBe(marker.length);
    expect(parsed.starts).toBe(true);
    expect(parsed.ends).toBe(true);
    expect(parsed.pageStates[0]).toMatchObject({ cursor: 0, complete: false });
    expect(parsed.pageStates.at(-1)).toMatchObject({ complete: true });
    expect(parsed.pageStates.at(-1).nextCursor).toBeUndefined();
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
