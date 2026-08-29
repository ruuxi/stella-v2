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
      "code",
    ]);
  });

  test("classifies the do-local half exactly as the design pins it", () => {
    expect([...generalAgentToolNamesFor("do_local")]).toEqual([
      "web",
      PUBLISH_STELLA_INTERIOR_TOOL_NAME,
    ]);
  });

  test("places nothing in the JS sandbox yet", () => {
    expect([...generalAgentToolNamesFor("js_sandbox")]).toEqual([]);
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
});
