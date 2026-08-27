import { describe, expect, it } from "vitest";

import {
  appendDemotedCatalogToNodeRepl,
  collectDemotedToolNames,
  createPiTools,
} from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import { collectReplSearchableTools } from "@stella/runtime/kernel/tools/host";
import { createMultiToolUseParallelTool } from "@stella/runtime/kernel/tools/defs/multi-tool-use-parallel";
import type {
  ToolContext,
  ToolMetadata,
} from "@stella/runtime/kernel/tools/types";

const NODE_REPL_DESCRIPTION =
  "Run JavaScript in a persistent Node REPL with top-level await.";

const baseCatalog: ToolMetadata[] = [
  {
    name: "node_repl",
    label: "Node REPL",
    description: NODE_REPL_DESCRIPTION,
    parameters: { type: "object", properties: { code: { type: "string" } } },
  },
  {
    name: "web",
    description: "Search and fetch the web.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "connector_status",
    description: "Check whether a Stella connector is connected.",
    parameters: {
      type: "object",
      properties: { connector: { type: "string" } },
      required: ["connector"],
    },
    demoted: { searchTerms: ["connector", "integration"] },
  },
  {
    name: "example_react_message",
    description: "Add or remove an example connector reaction.",
    parameters: {
      type: "object",
      properties: { operation: { type: "string" } },
    },
    demoted: {
      requiredConnectorProvider: "example_connector",
      searchTerms: ["example", "reaction"],
    },
  },
];

type CapturedCall = {
  toolName: string;
  allowedToolNames?: string[];
};

const makeTools = (options: {
  toolsAllowlist: string[];
  connectorProvider?: string;
  toolCatalog?: ToolMetadata[];
  captured?: CapturedCall[];
}) =>
  createPiTools({
    runId: "run-1",
    conversationId: "conv-1",
    agentType: "orchestrator",
    deviceId: "device-1",
    ...(options.connectorProvider
      ? {
          connectorDeliveryTarget: {
            requestId: "remote-1",
            conversationId: "backend-conv-1",
            provider: options.connectorProvider,
          },
        }
      : {}),
    toolsAllowlist: options.toolsAllowlist,
    toolCatalog: options.toolCatalog ?? baseCatalog,
    store: {} as never,
    toolExecutor: async (
      toolName: string,
      _args: Record<string, unknown>,
      context: ToolContext,
    ) => {
      options.captured?.push({
        toolName,
        ...(context.allowedToolNames
          ? { allowedToolNames: context.allowedToolNames }
          : {}),
      });
      return { result: `ran ${toolName}` };
    },
  });

describe("demoted tool catalog (createPiTools)", () => {
  it("removes demoted tools from the direct list only when node_repl is active", () => {
    const withRepl = makeTools({ toolsAllowlist: ["node_repl", "web"] });
    expect(withRepl.map((tool) => tool.name).sort()).toEqual([
      "node_repl",
      "web",
    ]);

    const withoutRepl = makeTools({ toolsAllowlist: ["web"] });

    expect(withoutRepl.map((tool) => tool.name).sort()).toEqual([
      "connector_status",
      "web",
    ]);
    const connectorStatus = withoutRepl.find(
      (tool) => tool.name === "connector_status",
    );
    expect(connectorStatus?.description).toBe(
      "Check whether a Stella connector is connected.",
    );
    expect(connectorStatus?.parameters).toMatchObject({
      required: ["connector"],
    });
  });

  it("embeds a COMPLETE signature catalog into node_repl's description", () => {
    const tools = makeTools({ toolsAllowlist: ["node_repl", "web"] });
    const nodeRepl = tools.find((tool) => tool.name === "node_repl");
    expect(nodeRepl?.description.startsWith(NODE_REPL_DESCRIPTION)).toBe(true);
    expect(nodeRepl?.description).toContain(
      "Some tools are demoted from your direct tool list",
    );

    expect(nodeRepl?.description).toContain(
      "## Demoted tools (COMPLETE — all 1 shown; call via tools.<name> inside node_repl)",
    );
    expect(nodeRepl?.description).toContain(
      "tools.connector_status(input: { connector: string }): Promise<unknown>",
    );
    expect(nodeRepl?.description).not.toContain("example_react_message");

    expect(tools.find((tool) => tool.name === "web")?.description).toBe(
      "Search and fetch the web.",
    );
  });

  it("keeps the node_repl description byte-identical when no demoted tool is in scope", () => {
    const tools = makeTools({
      toolsAllowlist: ["node_repl", "web"],
      toolCatalog: baseCatalog.filter((tool) => !tool.demoted),
    });
    expect(tools.find((tool) => tool.name === "node_repl")?.description).toBe(
      NODE_REPL_DESCRIPTION,
    );
  });

  it("marks the catalog PARTIAL with $search guidance once the budget overflows", () => {
    const bulky: ToolMetadata[] = Array.from({ length: 120 }, (_, index) => ({
      name: `bulk_tool_${String(index).padStart(3, "0")}`,
      description: "x".repeat(200),
      parameters: {
        type: "object",
        properties: { value: { type: "string", description: "y".repeat(80) } },
      },
      demoted: {},
    }));
    const tools = makeTools({
      toolsAllowlist: ["node_repl"],
      toolCatalog: [baseCatalog[0]!, ...bulky],
    });
    const description = tools.find((tool) => tool.name === "node_repl")
      ?.description;
    expect(description).toContain("## Demoted tools (PARTIAL — ");
    expect(description).toContain(
      "find the rest with await tools.$search({ query })",
    );
  });

  it("widens allowedToolNames with context-visible demoted names only when node_repl is active", async () => {
    const captured: CapturedCall[] = [];
    const tools = makeTools({
      toolsAllowlist: ["node_repl", "web"],
      captured,
    });
    await tools.find((tool) => tool.name === "web")!.execute("call-1", {
      query: "hi",
    });
    expect(captured[0]?.allowedToolNames).toContain("connector_status");
    expect(captured[0]?.allowedToolNames).not.toContain(
      "example_react_message",
    );

    const capturedNoRepl: CapturedCall[] = [];
    const withoutRepl = makeTools({
      toolsAllowlist: ["web"],
      captured: capturedNoRepl,
    });
    await withoutRepl.find((tool) => tool.name === "web")!.execute("call-2", {
      query: "hi",
    });

    expect(capturedNoRepl[0]?.allowedToolNames?.sort()).toEqual([
      "connector_status",
      "web",
    ]);
  });

  it("applies the requiredConnectorProvider gate to catalog, union, and direct fallback", async () => {

    const captured: CapturedCall[] = [];
    const connectorTools = makeTools({
      toolsAllowlist: ["node_repl", "web"],
      connectorProvider: "example_connector",
      captured,
    });
    const nodeRepl = connectorTools.find((tool) => tool.name === "node_repl");
    expect(nodeRepl?.description).toContain(
      "## Demoted tools (COMPLETE — all 2 shown",
    );
    expect(nodeRepl?.description).toContain("example_react_message");
    await connectorTools.find((tool) => tool.name === "web")!.execute("call-1", {
      query: "hi",
    });
    expect(captured[0]?.allowedToolNames).toContain("example_react_message");

    const connectorDirect = makeTools({
      toolsAllowlist: ["web"],
      connectorProvider: "example_connector",
    });
    expect(connectorDirect.map((tool) => tool.name).sort()).toEqual([
      "connector_status",
      "example_react_message",
      "web",
    ]);

    const nonConnectorDirect = makeTools({ toolsAllowlist: ["web"] });
    expect(
      nonConnectorDirect.some((tool) => tool.name === "example_react_message"),
    ).toBe(false);
  });

  it("never pulls demoted tools into the empty-allowlist STELLA_LOCAL_TOOLS fallback", async () => {
    const captured: CapturedCall[] = [];
    const tools = makeTools({ toolsAllowlist: [], captured });

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "NoResponse",
      "RequestCredential",
    ]);
    await tools
      .find((tool) => tool.name === "RequestCredential")!
      .execute("call-1", {});
    expect(captured[0]?.allowedToolNames).not.toContain("connector_status");
  });

  it("collectDemotedToolNames mirrors the connector gate", () => {
    expect(collectDemotedToolNames(baseCatalog, undefined)).toEqual([
      "connector_status",
    ]);
    expect(collectDemotedToolNames(baseCatalog, "example_connector").sort()).toEqual([
      "connector_status",
      "example_react_message",
    ]);
  });
});

describe("collectReplSearchableTools (searchable must equal callable)", () => {
  const baseContext: ToolContext = {
    conversationId: "conv-1",
    deviceId: "device-1",
    requestId: "req-1",
    agentType: "orchestrator",
  };

  it("excludes a demoted tool absent from allowedToolNames (never-widened context)", () => {

    const names = collectReplSearchableTools(baseCatalog, {
      ...baseContext,
      allowedToolNames: ["node_repl", "web"],
    }).map((tool) => tool.name);
    expect(names).toEqual(["web"]);
  });

  it("includes a demoted tool once the union carries its name", () => {
    const names = collectReplSearchableTools(baseCatalog, {
      ...baseContext,
      allowedToolNames: ["node_repl", "web", "connector_status"],
    }).map((tool) => tool.name);
    expect(names.sort()).toEqual(["connector_status", "web"]);
  });

  it("keeps the connector and agent-type gates as defense in depth", () => {

    const nonConnectorTool = collectReplSearchableTools(baseCatalog, {
      ...baseContext,
      allowedToolNames: ["example_react_message"],
    });
    expect(nonConnectorTool).toEqual([]);
    const connectorTool = collectReplSearchableTools(baseCatalog, {
      ...baseContext,
      allowedToolNames: ["example_react_message"],
      connectorDeliveryTarget: {
        requestId: "remote-1",
        conversationId: "backend-conv-1",
        provider: "example_connector",
      },
    }).map((tool) => tool.name);
    expect(connectorTool).toEqual(["example_react_message"]);

    const gated: ToolMetadata[] = [
      {
        name: "orch_only",
        description: "Orchestrator-only tool.",
        parameters: { type: "object" },
        agentTypes: ["orchestrator"],
      },
    ];
    expect(
      collectReplSearchableTools(gated, {
        ...baseContext,
        agentType: "general",
        allowedToolNames: ["orch_only"],
      }),
    ).toEqual([]);
  });

  it("never returns REPL-excluded intrinsics", () => {
    const names = collectReplSearchableTools(baseCatalog, {
      ...baseContext,
      allowedToolNames: ["node_repl", "multi_tool_use_parallel", "web"],
    }).map((tool) => tool.name);
    expect(names).toEqual(["web"]);
  });
});

describe("appendDemotedCatalogToNodeRepl (external-engine parity)", () => {
  it("appends the workflow text + catalog to node_repl only, when demoted tools are in scope", () => {
    const metadata = [
      { name: "node_repl", description: NODE_REPL_DESCRIPTION },
      { name: "web", description: "Search and fetch the web." },
    ];
    const appended = appendDemotedCatalogToNodeRepl(
      metadata,
      baseCatalog,
      undefined,
    ) as Array<{ name: string; description: string }>;
    const nodeRepl = appended.find((tool) => tool.name === "node_repl");
    expect(nodeRepl?.description).toContain(
      "Some tools are demoted from your direct tool list",
    );
    expect(nodeRepl?.description).toContain("connector_status");
    expect(appended.find((tool) => tool.name === "web")?.description).toBe(
      "Search and fetch the web.",
    );

    expect(
      appendDemotedCatalogToNodeRepl([metadata[1]!], baseCatalog, undefined),
    ).toEqual([metadata[1]]);
    expect(
      appendDemotedCatalogToNodeRepl(
        metadata,
        baseCatalog.filter((tool) => !tool.demoted),
        undefined,
      ),
    ).toEqual(metadata);
  });
});

describe("multi_tool_use_parallel with demoted tools", () => {
  it("invokes a demoted tool present in the widened allowedToolNames", async () => {
    const executed: string[] = [];
    const parallel = createMultiToolUseParallelTool({
      executeTool: async (toolName) => {
        executed.push(toolName);
        return { result: `ran ${toolName}` };
      },
    });
    const context: ToolContext = {
      conversationId: "conv-1",
      deviceId: "device-1",
      requestId: "req-1",
      agentType: "orchestrator",

      allowedToolNames: [
        "node_repl",
        "web",
        "multi_tool_use_parallel",
        "connector_status",
      ],
    };
    const result = await parallel.execute(
      {
        tool_uses: [
          {
            recipient_name: "functions.connector_status",
            parameters: { connector: "gmail" },
          },
          { recipient_name: "web", parameters: { query: "hello" } },
        ],
      },
      context,
    );
    expect(result.error).toBeUndefined();
    expect(executed.sort()).toEqual(["connector_status", "web"]);
  });
});
