import { describe, expect, test } from "bun:test";
import { resolveToolProcessIdentity } from "@stella/runtime/kernel/tools/shell.js";
import { cloudAgentToolContext } from "./cloud-tool-context.js";
import { CLOUD_TOOL_HOME } from "./cloud-process-isolation.js";
import { WORLD_ROOT, toolStateDir } from "./workspace-paths.js";

describe("cloud tool context", () => {
  const context = cloudAgentToolContext({
    threadId: "thread-1",
    workspaceRoot: WORLD_ROOT,
    workspaceStateDir: toolStateDir(WORLD_ROOT),
    toolHome: CLOUD_TOOL_HOME,
    requestId: "call-1",
  });

  test("still refuses a home outside every trusted root", () => {
    expect(() =>
      resolveToolProcessIdentity(
        {
          ...context,
          toolProcessIdentity: { ...context.toolProcessIdentity!, home: "/tmp" },
        },
        "linux",
      ),
    ).toThrow("must stay inside the workspace");
    expect(() =>
      resolveToolProcessIdentity(
        { ...context, toolHomeRoot: undefined },
        "linux",
      ),
    ).toThrow("must stay inside the workspace");
  });
});
