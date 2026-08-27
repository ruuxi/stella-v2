import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  getLocalCliWorkingDirectory,
  isLocalCliAgentId,
  normalizeRetiredAgentType,
} from "@stella/contracts/agent-runtime";

describe("agent runtime contracts", () => {
  it("keeps the orchestrator on the local CLI runtime", () => {
    expect(getLocalCliWorkingDirectory(AGENT_IDS.ORCHESTRATOR)).toBe(
      "frontend",
    );
    expect(isLocalCliAgentId(AGENT_IDS.ORCHESTRATOR)).toBe(true);
  });

  it("keeps the general agent on the local CLI runtime", () => {
    expect(getLocalCliWorkingDirectory(AGENT_IDS.GENERAL)).toBe("frontend");
    expect(isLocalCliAgentId(AGENT_IDS.GENERAL)).toBe(true);
  });

  it("reinterprets the retired manager type as General", () => {
    expect(normalizeRetiredAgentType("manager")).toBe(AGENT_IDS.GENERAL);
    expect(AGENT_IDS).not.toHaveProperty("MANAGER");
  });
});
