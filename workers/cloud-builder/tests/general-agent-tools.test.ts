import { describe, expect, test } from "bun:test";
import type { TSchema } from "@sinclair/typebox";
import type {
  AgentTool,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  NO_JS_SANDBOX_MESSAGE,
  NO_WORKSPACE_ATTACHED_MESSAGE,
  UnknownGeneralAgentToolError,
  computeForTool,
  createResidentGeneralAgentTools,
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
  test("fails closed on a name it does not classify", () => {
    expect(() => computeForTool("spawn")).toThrow(UnknownGeneralAgentToolError);
    expect(() => computeForTool("Remember")).toThrow(
      UnknownGeneralAgentToolError,
    );
    expect(() => computeForTool("")).toThrow(UnknownGeneralAgentToolError);
  });
});

describe("pinned resident catalog", () => {
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
    expect(catalog.map((tool) => tool.name)).not.toContain("merge_workspace");
  });

  test("refuses to build a catalog missing a do-local implementation", () => {
    const partial = new Map(doLocalStubs());
    partial.delete("web");
    expect(() => createResidentGeneralAgentTools(partial)).toThrow(
      /missing its web implementation/u,
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

    for (const name of ["exec_command", "write_stdin"]) {
      const tool = catalog.find((entry) => entry.name === name);
      const result = await tool!.execute("call-1", {});
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: "from the workspace" },
      ]);
    }
    expect(seen).toEqual(["exec_command:call-1", "write_stdin:call-1"]);
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
