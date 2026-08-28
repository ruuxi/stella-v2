import { describe, expect, test } from "bun:test";
import { classifyAgentFailureDiagnostic } from "../src/agent-failure-diagnostic.js";
import { CLOUD_MODEL_DIAGNOSTIC_SENTINELS } from "@stella/contracts/cloud-model-diagnostic";

describe("agent failure diagnostic", () => {
  test.each([
    ["Cannot read properties of undefined (reading 'engine')", "execution_missing"],
    ["Cloud tool directory has an invalid mode.", "tool_state_boundary"],
    ["Turn broker handoff is invalid or expired.", "broker_handoff"],
    ["ENOENT: /workspace/turn-input.json", "turn_input"],
    ["Cloud workspace root has an invalid owner or mode.", "workspace_boundary"],
    ["Cloud privilege probe failed (1): setpriv refused", "privilege_probe"],
    ["authoritative agent conversation history rejected", "conversation_history"],
    ["The cloud model resolver returned an invalid response.", "model_resolution"],
    ["Turn credential broker response was ambiguous", "broker_response"],
    ["Captured session wrapper did not complete successfully.", "capture_wrapper"],
    ["Captured session exit code was unreadable.", "capture_exit"],
  ] as const)("classifies %s", (detail, expected) => {
    expect(classifyAgentFailureDiagnostic(detail)).toBe(expected);
  });

  test("unknown details never flow into the bounded code", () => {
    const secret = "credential-canary-never-return";
    const code = classifyAgentFailureDiagnostic(`provider exploded: ${secret}`);
    expect(code).toBe("unknown");
    expect(code).not.toContain(secret);
  });

  test("accepts exact model sentinels and rejects near matches", () => {
    for (const [code, sentinel] of Object.entries(
      CLOUD_MODEL_DIAGNOSTIC_SENTINELS,
    )) {
      expect(classifyAgentFailureDiagnostic(`error: ${sentinel}`)).toBe(code);
      expect(classifyAgentFailureDiagnostic(`error: prefix-${sentinel}`)).toBe(
        "unknown",
      );
      expect(classifyAgentFailureDiagnostic(`error: ${sentinel}-suffix`)).toBe(
        "unknown",
      );
    }
  });
});
