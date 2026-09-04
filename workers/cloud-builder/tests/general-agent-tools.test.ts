import { describe, expect, test } from "bun:test";
import type { TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  GENERAL_AGENT_TOOL_DESCRIPTORS,
  GENERAL_AGENT_TOOL_NAMES,
  LEGACY_VIEW_IMAGE_TOOL_NAME,
  NO_JS_SANDBOX_MESSAGE,
  NO_WORKSPACE_ATTACHED_MESSAGE,
  PUBLISH_STELLA_INTERIOR_TOOL_NAME,
  UnknownGeneralAgentToolError,
  computeForTool,
  createResidentGeneralAgentTools,
  descriptorForTool,
  generalAgentToolNamesFor,
} from "../src/general-agent-tools.js";

const stubTool = (name: string): AgentTool => ({
  name,
  label: name,
  description: `stub ${name}`,
  parameters: { type: "object", properties: {} } as unknown as TSchema,
  execute: async (): Promise<AgentToolResult<unknown>> => ({
    content: [{ type: "text", text: `ran ${name}` }],
    details: null,
  }),
});

const doLocalStubs = (): ReadonlyMap<string, AgentTool> =>
  new Map(
    generalAgentToolNamesFor("do_local").map((name) => [name, stubTool(name)]),
  );

describe("general-agent capability table", () => {
  test("classifies the container half exactly as the design pins it", () => {
    expect([...generalAgentToolNamesFor("container")]).toEqual([
      "exec_command",
      "write_stdin",
      "Read",
      "apply_patch",
      LEGACY_VIEW_IMAGE_TOOL_NAME,
    ]);
  });

  test("classifies the do-local half exactly as the design pins it", () => {
    expect([...generalAgentToolNamesFor("do_local")]).toEqual([
      "web",
      "spawn_agent",
      "send_input",
      "pause_agent",
      "agent_status",
      PUBLISH_STELLA_INTERIOR_TOOL_NAME,
    ]);
  });

  test("places code, and only code, in the JS sandbox", () => {
    expect([...generalAgentToolNamesFor("js_sandbox")]).toEqual(["code"]);
    expect(computeForTool("code")).toBe("js_sandbox");
  });

  test("is closed over the names it advertises", () => {
    for (const name of GENERAL_AGENT_TOOL_NAMES) {
      expect(() => computeForTool(name)).not.toThrow();
    }
  });

  test("fails closed on a name it does not classify", () => {
    expect(() => computeForTool("spawn")).toThrow(UnknownGeneralAgentToolError);
    expect(() => computeForTool("Remember")).toThrow(
      UnknownGeneralAgentToolError,
    );
    expect(() => computeForTool("")).toThrow(UnknownGeneralAgentToolError);
  });

  /**
   * `view_image` routes but has no descriptor, because the container path has
   * no runtime definition for it either. Classifying it keeps a replayed
   * historical call from looking like an unknown tool; withholding the
   * descriptor keeps the resident catalog from advertising a tool the
   * container catalog does not have.
   */
  test("routes the legacy image name without advertising it", () => {
    expect(computeForTool(LEGACY_VIEW_IMAGE_TOOL_NAME)).toBe("container");
    expect(() => descriptorForTool(LEGACY_VIEW_IMAGE_TOOL_NAME)).toThrow(
      UnknownGeneralAgentToolError,
    );
    expect(
      GENERAL_AGENT_TOOL_DESCRIPTORS.some(
        (descriptor) => descriptor.name === LEGACY_VIEW_IMAGE_TOOL_NAME,
      ),
    ).toBe(false);
  });
});

describe("pinned resident catalog", () => {
  test("advertises every descriptor in descriptor order", () => {
    const catalog = createResidentGeneralAgentTools(doLocalStubs());
    expect(catalog.map((tool) => tool.name)).toEqual(
      GENERAL_AGENT_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name),
    );
  });

  test("withholds all orchestration tools from a depth-2 agent", () => {
    const catalog = createResidentGeneralAgentTools(
      doLocalStubs(),
      undefined,
      undefined,
      { agentDepth: 2 },
    );
    expect(catalog.map((tool) => tool.name)).not.toContain("spawn_agent");
    expect(catalog.map((tool) => tool.name)).not.toContain("send_input");
    expect(catalog.map((tool) => tool.name)).not.toContain("pause_agent");
    expect(catalog.map((tool) => tool.name)).not.toContain("agent_status");
  });

  test("carries each descriptor's model-visible surface unchanged", () => {
    const catalog = createResidentGeneralAgentTools(doLocalStubs());
    for (const descriptor of GENERAL_AGENT_TOOL_DESCRIPTORS) {
      if (computeForTool(descriptor.name) !== "container") continue;
      const tool = catalog.find((entry) => entry.name === descriptor.name);
      expect(tool?.label).toBe(descriptor.label);
      expect(tool?.description).toBe(descriptor.description);
      expect(tool?.parameters).toEqual(descriptor.parameters);
    }
  });

  test("answers an unattached container call with a tool error, not a throw", async () => {
    const catalog = createResidentGeneralAgentTools(doLocalStubs());
    for (const name of generalAgentToolNamesFor("container")) {
      const tool = catalog.find((entry) => entry.name === name);
      if (!tool) continue;
      const result = await tool.execute("call-1", {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(JSON.stringify(result.content)).toContain(
        NO_WORKSPACE_ATTACHED_MESSAGE,
      );
    }
  });

  test("runs the do-local implementation the caller supplied", async () => {
    const catalog = createResidentGeneralAgentTools(doLocalStubs());
    const web = catalog.find((entry) => entry.name === "web");
    const result = await web!.execute("call-1", {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "ran web" }]);
  });

  test("refuses to build a catalog missing a do-local implementation", () => {
    const partial = new Map(doLocalStubs());
    partial.delete(PUBLISH_STELLA_INTERIOR_TOOL_NAME);
    expect(() => createResidentGeneralAgentTools(partial)).toThrow(
      /missing its publish_stella_interior implementation/u,
    );
  });

  test("routes each bridged tool through the ladder when one is supplied", async () => {
    const seen: string[] = [];
    const catalog = createResidentGeneralAgentTools(doLocalStubs(), {
      execute: async (request) => {
        seen.push(`${request.toolName}:${request.toolCallId}`);
        return {
          outcome: { kind: "ok", text: "from the workspace" },
          details: null,
        };
      },
    });

    for (const name of ["exec_command", "write_stdin", "Read", "apply_patch"]) {
      const tool = catalog.find((entry) => entry.name === name);
      const result = await tool!.execute("call-1", {});
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: "from the workspace" },
      ]);
    }
    expect(seen).toEqual([
      "exec_command:call-1",
      "write_stdin:call-1",
      "Read:call-1",
      "apply_patch:call-1",
    ]);
  });

  test("never sends code to the ladder; without a JS sandbox it refuses with its own reason", async () => {
    const catalog = createResidentGeneralAgentTools(doLocalStubs(), {
      execute: async () => {
        throw new Error("the ladder should never see code");
      },
    });

    const result = await catalog
      .find((entry) => entry.name === "code")!
      .execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(NO_JS_SANDBOX_MESSAGE);
    expect(JSON.stringify(result.content)).not.toContain(
      NO_WORKSPACE_ATTACHED_MESSAGE,
    );
  });

  test("runs code in the JS sandbox the caller supplied, with no container involved", async () => {
    let ladderCalls = 0;
    const catalog = createResidentGeneralAgentTools(
      doLocalStubs(),
      {
        execute: async () => {
          ladderCalls += 1;
          throw new Error("the ladder should never see code");
        },
      },
      new Map([
        [
          "code",
          {
            name: "code",
            label: "Code",
            description: "dynamic worker",
            parameters: { type: "object" } as never,
            execute: async (toolCallId: string) => ({
              content: [
                { type: "text" as const, text: `ran code ${toolCallId}` },
              ],
              details: null,
            }),
          },
        ],
      ]),
    );

    const code = catalog.find((entry) => entry.name === "code")!;
    const result = await code.execute("call-7", { code: "1+1" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "ran code call-7" }]);
    expect(ladderCalls).toBe(0);
    // Descriptor order is the model-visible order and must not move.
    expect(catalog.map((entry) => entry.name)).toEqual(
      GENERAL_AGENT_TOOL_DESCRIPTORS.map((entry) => entry.name),
    );
  });

  test("carries a bridged tool's failure back as a model-visible error", async () => {
    const catalog = createResidentGeneralAgentTools(doLocalStubs(), {
      execute: async () => ({
        outcome: { kind: "error", message: "exit 1" },
        details: null,
      }),
    });

    const result = await catalog
      .find((entry) => entry.name === "exec_command")!
      .execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "exit 1" }]);
  });
});
