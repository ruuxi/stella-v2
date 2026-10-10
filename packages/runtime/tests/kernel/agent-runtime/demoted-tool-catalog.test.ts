import { describe, expect, it } from "vitest";

import { appendDemotedCatalogToCode } from "@stella/runtime/kernel/agent-runtime/tool-adapters";
import { collectReplSearchableTools } from "@stella/runtime/kernel/tools/host";
import { createMultiToolUseParallelTool } from "@stella/runtime/kernel/tools/defs/multi-tool-use-parallel";
import type {
  ToolContext,
  ToolMetadata,
} from "@stella/runtime/kernel/tools/types";

const CODE_DESCRIPTION = "Run JavaScript with top-level await.";

const baseCatalog: ToolMetadata[] = [
  {
    name: "code",
    label: "Code",
    description: CODE_DESCRIPTION,
    parameters: { type: "object", properties: { code: { type: "string" } } },
  },
  {
    name: "web",
    description: "Search and fetch the web.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "connector_status",
    description: "Check whether a Stella Store connector is connected.",
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

describe("collectReplSearchableTools (searchable must equal callable)", () => {
  const baseContext: ToolContext = {
    conversationId: "conv-1",
    deviceId: "device-1",
    requestId: "req-1",
    agentType: "orchestrator",
  };

  it("excludes a demoted tool absent from allowedToolNames (never-widened context)", () => {
    // e.g. a voice-style session that has code but never widened its
    // allowedToolNames with demoted tools: $search must not advertise a
    // signature that tools.<name> cannot invoke.
    const names = collectReplSearchableTools(baseCatalog, {
      ...baseContext,
      allowedToolNames: ["code", "web"],
    }).map((tool) => tool.name);
    expect(names).toEqual(["web"]);
  });

  it("includes a demoted tool once the union carries its name", () => {
    const names = collectReplSearchableTools(baseCatalog, {
      ...baseContext,
      allowedToolNames: ["code", "web", "connector_status"],
    }).map((tool) => tool.name);
    expect(names.sort()).toEqual(["connector_status", "web"]);
  });

  it("keeps the connector and agent-type gates as defense in depth", () => {
    // Name present in allowedToolNames but wrong connector context.
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

    // agentTypes gate.
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
      allowedToolNames: ["code", "node_repl", "multi_tool_use_parallel", "web"],
    }).map((tool) => tool.name);
    expect(names).toEqual(["web"]);
  });
});

describe("appendDemotedCatalogToCode (external-engine parity)", () => {
  it("appends the workflow text + catalog to code only, when demoted tools are in scope", () => {
    const metadata = [
      { name: "code", description: CODE_DESCRIPTION },
      { name: "web", description: "Search and fetch the web." },
    ];
    const appended = appendDemotedCatalogToCode(
      metadata,
      baseCatalog,
      undefined,
    ) as Array<{ name: string; description: string }>;
    const code = appended.find((tool) => tool.name === "code");
    expect(code?.description).toContain(
      "Some tools are demoted from your direct tool list",
    );
    expect(code?.description).toContain("connector_status");
    expect(appended.find((tool) => tool.name === "web")?.description).toBe(
      "Search and fetch the web.",
    );
    // No code in the metadata → untouched. No demoted in scope → same.
    expect(
      appendDemotedCatalogToCode([metadata[1]!], baseCatalog, undefined),
    ).toEqual([metadata[1]]);
    expect(
      appendDemotedCatalogToCode(
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
      // A widened union: demoted connector_status is reachable even though
      // it is absent from the direct tool list.
      allowedToolNames: [
        "code",
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
