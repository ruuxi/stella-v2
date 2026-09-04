import { describe, expect, test } from "bun:test";
import { attachedToolPaths } from "@stella/executor-cloud/attached-tool-protocol";
import { agentTurnSessionId, worldSandboxId } from "../src/workspace.js";

describe("owner world sandbox identity", () => {
  test("two turns share the container but get distinct sessions and daemon directories", async () => {
    const [firstContainer, secondContainer] = await Promise.all([
      worldSandboxId("owner-1"),
      worldSandboxId("owner-1"),
    ]);
    const firstSession = agentTurnSessionId("turn-a");
    const secondSession = agentTurnSessionId("turn-b");
    const firstDaemon = attachedToolPaths({
      turnId: "turn-a",
      attemptGeneration: 1,
    }).directory;
    const secondDaemon = attachedToolPaths({
      turnId: "turn-b",
      attemptGeneration: 1,
    }).directory;

    expect(firstContainer).toBe(secondContainer);
    expect(firstContainer).toMatch(/^world-[0-9a-f]{40}$/u);
    expect(firstSession).toBe("agent-run-turn-a");
    expect(secondSession).toBe("agent-run-turn-b");
    expect(firstSession).not.toBe(secondSession);
    expect(firstDaemon).toBe("/workspace/attached/turn-a-1");
    expect(secondDaemon).toBe("/workspace/attached/turn-b-1");
  });
});
