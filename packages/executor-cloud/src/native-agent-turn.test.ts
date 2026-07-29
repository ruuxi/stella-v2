import { describe, expect, it } from "bun:test";
import {
  buildClaudeChildEnv,
  resolveClaudeModelArgs,
  resolveClaudeReasoningArgs,
  resolveCodexReasoningEffort,
} from "./native-agent-turn.js";

describe("native engine reasoning selection", () => {
  it("preserves each CLI's own default", () => {
    expect(resolveClaudeModelArgs("default")).toEqual([]);
    expect(resolveClaudeModelArgs("claude-sonnet-4-6")).toEqual([
      "--model",
      "claude-sonnet-4-6",
    ]);
    expect(resolveClaudeReasoningArgs("default")).toEqual([]);
    expect(resolveCodexReasoningEffort("default")).toBeUndefined();
  });

  it("maps Stella's extended effort names to Claude Code", () => {
    expect(resolveClaudeReasoningArgs("none")).toEqual([
      "--thinking",
      "disabled",
    ]);
    expect(resolveClaudeReasoningArgs("minimal")).toEqual([
      "--effort",
      "low",
      "--thinking",
      "enabled",
    ]);
    expect(resolveClaudeReasoningArgs("xhigh")).toEqual([
      "--effort",
      "max",
      "--thinking",
      "enabled",
    ]);
  });

  it("passes explicit Codex effort through unchanged", () => {
    for (const effort of [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ] as const) {
      expect(resolveCodexReasoningEffort(effort)).toBe(effort);
    }
  });

  it("does not pass executor token variable names into Claude", () => {
    const env = buildClaudeChildEnv({
      initialEnv: {
        STELLA_TURN_TOKEN: "executor-token",
        STELLA_CODEX_TURN_TOKEN: "codex-token",
        KEEP_ME: "safe",
      },
      callbackBase: "https://example.convex.site",
      stateRoot: "/workspace/drive/.stella/claude",
      turnToken: "scoped-turn-token",
      reasoningEffort: "none",
    });
    expect(env.STELLA_TURN_TOKEN).toBeUndefined();
    expect(env.STELLA_CODEX_TURN_TOKEN).toBeUndefined();
    expect(env.KEEP_ME).toBe("safe");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("scoped-turn-token");
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe("unset");
  });
});
