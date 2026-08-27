import { describe, expect, it } from "vitest";

import {
  appendDemotedCatalogToCode,
  collectDemotedToolNames,
  createPiTools,
  getProviderToolMetadata,
} from "@stella/runtime/kernel/agent-runtime/tool-adapters";
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
  it("removes demoted tools from the direct list only when code is active", () => {
    const withCode = makeTools({ toolsAllowlist: ["code", "web"] });
    expect(withCode.map((tool) => tool.name).sort()).toEqual(["code", "web"]);

    const withoutRepl = makeTools({ toolsAllowlist: ["web"] });
    // Never-strand fallback: demoted tools surface directly, with their
    // real schema and description, for agents without code.
    expect(withoutRepl.map((tool) => tool.name).sort()).toEqual([
      "connector_status",
      "web",
    ]);
    const connectorStatus = withoutRepl.find(
      (tool) => tool.name === "connector_status",
    );
    expect(connectorStatus?.description).toBe(
      "Check whether a Stella Store connector is connected.",
    );
    expect(connectorStatus?.parameters).toMatchObject({
      required: ["connector"],
    });
  });

  it("applies the same deferred list and safe fallback to metadata-only provider routes", () => {
    const withCode = getProviderToolMetadata({
      toolsAllowlist: ["code", "web"],
      toolCatalog: baseCatalog,
    });
    expect(withCode.map((tool) => tool.name)).toEqual(["code", "web"]);
    expect(withCode[0]?.description).toContain("tools.connector_status(");

    const withoutRepl = getProviderToolMetadata({
      toolsAllowlist: ["web"],
      toolCatalog: baseCatalog,
    });
    expect(withoutRepl.map((tool) => tool.name)).toEqual([
      "web",
      "connector_status",
    ]);
    expect(withoutRepl[1]?.parameters).toEqual(
      baseCatalog.find((tool) => tool.name === "connector_status")?.parameters,
    );
  });

  it("keeps approval-required demoted tools direct and out of code", async () => {
    const protectedTool: ToolMetadata = {
      name: "publish_release",
      description: "Publish a release.",
      parameters: { type: "object", additionalProperties: false },
      approval: { required: true },
      demoted: {},
    };
    const catalog = [...baseCatalog, protectedTool];
    const captured: CapturedCall[] = [];
    const tools = makeTools({
      toolsAllowlist: ["code"],
      toolCatalog: catalog,
      captured,
    });

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "code",
      "publish_release",
    ]);
    expect(
      tools.find((tool) => tool.name === "code")?.description,
    ).not.toContain("publish_release");
    await tools
      .find((tool) => tool.name === "code")!
      .execute("call-code", {
        code: "1 + 1",
      });
    expect(captured[0]?.allowedToolNames).not.toContain("publish_release");

    const providerTools = getProviderToolMetadata({
      toolsAllowlist: ["code"],
      toolCatalog: catalog,
    });
    expect(providerTools.map((tool) => tool.name).sort()).toEqual([
      "code",
      "publish_release",
    ]);
    expect(
      providerTools.find((tool) => tool.name === "code")?.description,
    ).not.toContain("publish_release");
  });

  it("embeds a COMPLETE signature catalog into code's description", () => {
    const tools = makeTools({ toolsAllowlist: ["code", "web"] });
    const code = tools.find((tool) => tool.name === "code");
    expect(code?.description.startsWith(CODE_DESCRIPTION)).toBe(true);
    expect(code?.description).toContain(
      "Some tools are demoted from your direct tool list",
    );
    // the example connector tool is connector-gated out, so only connector_status is in scope.
    expect(code?.description).toContain(
      "## Demoted tools (COMPLETE — all 1 shown; call via tools.<name> inside code)",
    );
    expect(code?.description).toContain(
      "tools.connector_status(input: { connector: string }): Promise<unknown>",
    );
    expect(code?.description).not.toContain("example_react_message");

    // The web tool's description is untouched.
    expect(tools.find((tool) => tool.name === "web")?.description).toBe(
      "Search and fetch the web.",
    );
  });

  it("keeps the code description byte-identical when no demoted tool is in scope", () => {
    const tools = makeTools({
      toolsAllowlist: ["code", "web"],
      toolCatalog: baseCatalog.filter((tool) => !tool.demoted),
    });
    expect(tools.find((tool) => tool.name === "code")?.description).toBe(
      CODE_DESCRIPTION,
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
      toolsAllowlist: ["code"],
      toolCatalog: [baseCatalog[0]!, ...bulky],
    });
    const description = tools.find((tool) => tool.name === "code")?.description;
    expect(description).toContain("## Demoted tools (PARTIAL — ");
    expect(description).toContain(
      "find the rest with await tools.$search({ query })",
    );
  });

  it("widens allowedToolNames with context-visible demoted names only when code is active", async () => {
    const captured: CapturedCall[] = [];
    const tools = makeTools({
      toolsAllowlist: ["code", "web"],
      captured,
    });
    await tools
      .find((tool) => tool.name === "web")!
      .execute("call-1", {
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
    await withoutRepl
      .find((tool) => tool.name === "web")!
      .execute("call-2", {
        query: "hi",
      });
    // Without code the demoted tool is itself in the active set, so
    // the union collapses to the active names.
    expect(capturedNoRepl[0]?.allowedToolNames?.sort()).toEqual([
      "connector_status",
      "web",
    ]);
  });

  it("applies the requiredConnectorProvider gate to catalog, union, and direct fallback", async () => {
    // Connector turn with code: connector tools join the catalog and the union.
    const captured: CapturedCall[] = [];
    const connectorTools = makeTools({
      toolsAllowlist: ["code", "web"],
      connectorProvider: "example_connector",
      captured,
    });
    const code = connectorTools.find((tool) => tool.name === "code");
    expect(code?.description).toContain(
      "## Demoted tools (COMPLETE — all 2 shown",
    );
    expect(code?.description).toContain("example_react_message");
    await connectorTools
      .find((tool) => tool.name === "web")!
      .execute("call-1", {
        query: "hi",
      });
    expect(captured[0]?.allowedToolNames).toContain("example_react_message");

    // Connector turn without code: direct fallback includes the connector tool.
    const connectorDirect = makeTools({
      toolsAllowlist: ["web"],
      connectorProvider: "example_connector",
    });
    expect(connectorDirect.map((tool) => tool.name).sort()).toEqual([
      "connector_status",
      "example_react_message",
      "web",
    ]);

    // Non-connector turn without code: the gate hides the connector tool even
    // from the direct fallback.
    const nonConnectorDirect = makeTools({ toolsAllowlist: ["web"] });
    expect(
      nonConnectorDirect.some((tool) => tool.name === "example_react_message"),
    ).toBe(false);
  });

  it("never pulls demoted tools into the empty-allowlist STELLA_LOCAL_TOOLS fallback", async () => {
    const captured: CapturedCall[] = [];
    const tools = makeTools({ toolsAllowlist: [], captured });
    // The fallback surface is the minimal device-tool list; demoted tools
    // must not surface there directly nor join allowedToolNames.
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
    expect(
      collectDemotedToolNames(baseCatalog, "example_connector").sort(),
    ).toEqual(["connector_status", "example_react_message"]);
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
      // The widened union from createPiTools: demoted connector_status is
      // reachable even though it is absent from the direct tool list.
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
