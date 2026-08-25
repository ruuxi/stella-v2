import { describe, expect, it } from "vitest";
import {
  AGENT_IDS,
  agentHasCapability,
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

  it("injects personality only for the orchestrator", () => {
    expect(agentHasCapability(AGENT_IDS.ORCHESTRATOR, "injectsPersonality")).toBe(
      true,
    );
    expect(agentHasCapability(AGENT_IDS.GENERAL, "injectsPersonality")).toBe(
      false,
    );
    expect(agentHasCapability(AGENT_IDS.EXPLORE, "injectsPersonality")).toBe(
      false,
    );
    expect(agentHasCapability(AGENT_IDS.FASHION, "injectsPersonality")).toBe(
      false,
    );
    expect(
      agentHasCapability(AGENT_IDS.OFFLINE_RESPONDER, "injectsPersonality"),
    ).toBe(false);
  });

  it("keeps historical Dream rows without exposing Dream as a built-in", () => {
    expect(normalizeRetiredAgentType("dream")).toBe(AGENT_IDS.GENERAL);
    expect(AGENT_IDS).not.toHaveProperty("DREAM");
  });
});
