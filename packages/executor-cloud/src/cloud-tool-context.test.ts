import { describe, expect, test } from "bun:test";
import { resolveToolProcessIdentity } from "@stella/runtime/kernel/tools/shell.js";
import { cloudAgentToolContext } from "./cloud-tool-context.js";
import { CLOUD_TOOL_HOME } from "./cloud-process-isolation.js";
import { WORLD_ROOT, toolStateDir } from "./workspace-paths.js";

/**
 * The runtime's real identity guard, run against exactly the context the
 * cloud builds. Until `toolHomeRoot` existed this threw "Tool process home
 * must stay inside the workspace or its trusted tool-state directory" for
 * every cloud shell call, because the cloud keeps the tool home beside the
 * checkpointed world rather than inside it.
 */
describe("cloud tool context", () => {
  const context = cloudAgentToolContext({
    threadId: "thread-1",
    workspaceRoot: WORLD_ROOT,
    workspaceStateDir: toolStateDir(WORLD_ROOT),
    toolHome: CLOUD_TOOL_HOME,
    requestId: "call-1",
  });

  test("passes the runtime's identity guard with the tool home beside the world", () => {
    const identity = resolveToolProcessIdentity(context, "linux");
    expect(identity).toMatchObject({
      uid: 42_424,
      gid: 42_424,
      user: "stella-tools",
      home: "/workspace/.stella-tool-home",
    });
  });

  test("keeps execution placement and transcript storage independent", () => {
    expect(context.executionHost).toBe("sandbox");
    expect(context.storageMode).toBe("cloud");
    expect(context.toolWorkspaceRoot).toBe("/workspace/world");
    expect(context.stellaDataDir).toBe("/workspace/world/.stella");
    expect(context.toolHomeRoot).toBe("/workspace/.stella-tool-home");
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
