import { describe, expect, test } from "bun:test";
import type { ToolMetadata } from "@stella/runtime/kernel/tools/types.js";
import { AGENT_ORCHESTRATION_TOOL_DESCRIPTORS } from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
import {
  APPLY_PATCH_TOOL_DESCRIPTION,
  APPLY_PATCH_TOOL_NAME,
  APPLY_PATCH_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/apply-patch-def.js";
import {
  CODE_TOOL_DESCRIPTION,
  CODE_TOOL_NAME,
  CODE_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/code-def.js";
import {
  EXEC_COMMAND_TOOL_DESCRIPTION,
  EXEC_COMMAND_TOOL_NAME,
  EXEC_COMMAND_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/exec-command-def.js";
import {
  READ_TOOL_DESCRIPTION,
  READ_TOOL_NAME,
  READ_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/read-def.js";
import {
  WRITE_STDIN_TOOL_DESCRIPTION,
  WRITE_STDIN_TOOL_NAME,
  WRITE_STDIN_TOOL_PARAMETERS,
} from "@stella/runtime/kernel/tools/defs/write-stdin-def.js";

type StaticDescriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const STATIC_DESCRIPTORS: readonly StaticDescriptor[] = [
  {
    name: EXEC_COMMAND_TOOL_NAME,
    description: EXEC_COMMAND_TOOL_DESCRIPTION,
    parameters: EXEC_COMMAND_TOOL_PARAMETERS,
  },
  {
    name: WRITE_STDIN_TOOL_NAME,
    description: WRITE_STDIN_TOOL_DESCRIPTION,
    parameters: WRITE_STDIN_TOOL_PARAMETERS,
  },
  {
    name: READ_TOOL_NAME,
    description: READ_TOOL_DESCRIPTION,
    parameters: READ_TOOL_PARAMETERS,
  },
  {
    name: APPLY_PATCH_TOOL_NAME,
    description: APPLY_PATCH_TOOL_DESCRIPTION,
    parameters: APPLY_PATCH_TOOL_PARAMETERS,
  },
  {
    name: CODE_TOOL_NAME,
    description: CODE_TOOL_DESCRIPTION,
    parameters: CODE_TOOL_PARAMETERS,
  },
  ...AGENT_ORCHESTRATION_TOOL_DESCRIPTORS,
];

const realDesktopGeneralCatalog = async (): Promise<ToolMetadata[]> => {
  process.env.XDG_RUNTIME_DIR = "/tmp/stella-catalog-parity-runtime";
  const { createToolHost } =
    await import("@stella/runtime/kernel/tools/host.js");
  const host = createToolHost({
    stellaAppDir: "/tmp/stella-catalog-parity-world",
    stellaDataDir: "/tmp/stella-catalog-parity-state",
    recoverStaleSecrets: false,
    enableShellShims: false,
    allowCloudCode: true,
    browserSessionFactory: (() => {
      throw new Error("the parity catalog never executes a tool");
    }) as never,
    webSearch: async () => ({ text: "" }),
  });
  try {
    return host.getToolCatalog("general", {});
  } finally {
    await host.shutdown();
  }
};

const realCloudCatalog = async (): Promise<ToolMetadata[]> => {
  const catalog = await realDesktopGeneralCatalog();
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  return [
    EXEC_COMMAND_TOOL_NAME,
    WRITE_STDIN_TOOL_NAME,
    APPLY_PATCH_TOOL_NAME,
    "web",
    READ_TOOL_NAME,
    CODE_TOOL_NAME,
  ]
    .map((name) => byName.get(name))
    .filter((tool): tool is ToolMetadata => Boolean(tool));
};

describe("cloud general-agent catalog parity", () => {
  test("the static descriptors match the executor's real tool-host metadata", async () => {
    const catalog = await realDesktopGeneralCatalog();
    const byName = new Map(catalog.map((tool) => [tool.name, tool]));
    for (const descriptor of STATIC_DESCRIPTORS) {
      const real = byName.get(descriptor.name);
      expect(
        real,
        `${descriptor.name} missing from the real catalog`,
      ).toBeTruthy();
      expect(real!.name).toBe(descriptor.name);
      expect(real!.label ?? real!.name).toBe(descriptor.name);
      expect(real!.description).toBe(descriptor.description);
      expect(real!.parameters).toEqual(descriptor.parameters);
      expect(JSON.stringify(real!.parameters)).toBe(
        JSON.stringify(descriptor.parameters),
      );
    }
  });

  test("the container half of the catalog is exactly these five names", async () => {
    const catalog = await realCloudCatalog();
    expect(catalog.map((tool) => tool.name)).toEqual([
      EXEC_COMMAND_TOOL_NAME,
      WRITE_STDIN_TOOL_NAME,
      APPLY_PATCH_TOOL_NAME,
      "web",
      READ_TOOL_NAME,
      CODE_TOOL_NAME,
    ]);
  });

  // `view_image` sits in the executor's pinned name list but has no runtime
  // definition, so the tool-host lookup drops it before the model ever sees
  // it. Pinned here so extracting a descriptor for it can never quietly add a
  // tool the container path does not have.
  test("view_image is absent from the real catalog", async () => {
    const catalog = await realCloudCatalog();
    expect(catalog.some((tool) => tool.name === "view_image")).toBe(false);
  });
});
