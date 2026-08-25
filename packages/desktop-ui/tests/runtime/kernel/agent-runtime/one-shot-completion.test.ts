import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Capture calls into the Claude Code agent runtime so we can assert the
// one-shot pipeline reaches the local engine without any resolvable route.
const claudeCodeCalls: Array<Record<string, unknown>> = [];
let claudeCodeEngineActive = false;
const closedSessionKeys: string[] = [];
const scheduledSessionCloses: Array<{ sessionKey: string; timeoutMs: number }> =
  [];
const codexCalls: Array<Record<string, unknown>> = [];

vi.mock(
  "@stella/runtime/kernel/integrations/claude-code-agent-runtime",
  () => ({
    shouldUseClaudeCodeAgentRuntime: () => claudeCodeEngineActive,
    runClaudeCodeAgentTextCompletion: async (args: Record<string, unknown>) => {
      claudeCodeCalls.push(args);
      return "summarizing agent progress now";
    },
  }),
);

vi.mock("@stella/runtime/kernel/integrations/codex-agent-runtime", () => ({
  runCodexAgentTurn: async (args: Record<string, unknown>) => {
    codexCalls.push(args);
    return { text: "codex utility summary" };
  },
}));

vi.mock(
  "@stella/runtime/kernel/integrations/claude-code-session-runtime",
  () => ({
    closeClaudeCodeSessionWhenIdle: (sessionKey: string) => {
      closedSessionKeys.push(sessionKey);
    },
    scheduleClaudeCodeSessionCloseWhenIdle: (
      sessionKey: string,
      timeoutMs: number,
    ) => {
      scheduledSessionCloses.push({ sessionKey, timeoutMs });
    },
  }),
);

const completeSimpleCalls: Array<Record<string, unknown>> = [];
vi.mock("@stella/runtime/ai/stream", () => ({
  completeSimple: async (
    model: unknown,
    context: unknown,
    options: unknown,
  ) => {
    completeSimpleCalls.push({ model, context, options });
    return { content: [{ type: "text", text: "relay summary" }] };
  },
  readAssistantText: () => "relay summary",
}));

import { runOneShotCompletion } from "@stella/runtime/kernel/agent-runtime/one-shot-completion";

const makeRuntime = (args: { authToken: string | null; dataDir: string }) => ({
  stellaAppDir: "/tmp/does-not-matter-app-dir",
  stellaDataDir: args.dataDir,
  siteBaseUrl: args.authToken ? "https://site.example.test" : null,
  getAuthToken: () => args.authToken,
  hasConnectedAccount: () => Boolean(args.authToken),
});

const request = {
  agentType: "utility_helper",
  model: "stella/light",
  fallbackAgentTypes: ["general"],
  systemPrompt: "narrate",
  userText: "Task: test\nCurrent activity: working",
  maxOutputTokens: 24,
  temperature: 0.4,
  reasoningEffort: "low" as const,
  utility: true,
};

let dataDir: string;

beforeEach(() => {
  claudeCodeCalls.length = 0;
  completeSimpleCalls.length = 0;
  closedSessionKeys.length = 0;
  scheduledSessionCloses.length = 0;
  codexCalls.length = 0;
  claudeCodeEngineActive = false;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-shot-test-"));
});

describe("runOneShotCompletion", () => {
  it("keeps managed ChatGPT utilities off the native Codex path", async () => {
    fs.writeFileSync(
      path.join(dataDir, "preferences.json"),
      JSON.stringify({ agentRuntimeEngine: "codex_cli" }),
    );
    const result = await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken: "token", dataDir }),
    });
    expect(result.text).toBe("relay summary");
    expect(completeSimpleCalls).toHaveLength(1);
    expect(codexCalls).toHaveLength(0);
  });

  it("preserves the native Codex utility path after explicit opt-in", async () => {
    fs.writeFileSync(
      path.join(dataDir, "preferences.json"),
      JSON.stringify({
        agentRuntimeEngine: "codex_cli",
        useNativeCodexRuntime: true,
      }),
    );
    const result = await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken: "token", dataDir }),
    });
    expect(result.text).toBe("codex utility summary");
    expect(codexCalls).toHaveLength(1);
    expect(codexCalls[0]?.utility).toBe(true);
    expect(completeSimpleCalls).toHaveLength(0);
  });

  it("uses the Claude Code engine when no LLM route resolves (signed-out CC user)", async () => {
    claudeCodeEngineActive = true;
    const result = await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(result.text).toBe("summarizing agent progress now");
    expect(claudeCodeCalls).toHaveLength(1);
    // The explicit stella/light pin must flow through so CC maps it to Haiku.
    expect(claudeCodeCalls[0]?.stellaModel).toBe("stella/light");
    expect(claudeCodeCalls[0]?.effortLevel).toBe("low");
    expect(completeSimpleCalls).toHaveLength(0);
  });

  it("splits CC preferences (data dir) from the CLI working directory (home)", async () => {
    claudeCodeEngineActive = true;
    await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(claudeCodeCalls).toHaveLength(1);
    // Preferences (claudeCodeModel, effort) resolve against the data dir…
    expect(claudeCodeCalls[0]?.stellaAppDir).toBe(dataDir);
    // …while a non-`frontend` local CLI agent runs from the user's home
    // directory, never inside the data dir or the app bundle.
    expect(claudeCodeCalls[0]?.cwd).toBe(os.homedir());
  });

  it("reuses and closes an explicitly lifecycle-scoped Claude session", async () => {
    claudeCodeEngineActive = true;
    const persistentRequest = {
      ...request,
      sessionKey: "utility:agent-1",
      sessionIdleTtlMs: 60_000,
    };
    await runOneShotCompletion({
      request: persistentRequest,
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(claudeCodeCalls[0]?.sessionKey).toBe("utility:agent-1");
    expect(scheduledSessionCloses).toEqual([
      { sessionKey: "utility:agent-1", timeoutMs: 60_000 },
    ]);

    await runOneShotCompletion({
      request: {
        agentType: "utility_helper",
        userText: "",
        sessionKey: "utility:agent-1",
        closeSession: true,
      },
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(closedSessionKeys).toEqual(["utility:agent-1"]);
    expect(claudeCodeCalls).toHaveLength(1);
  });

  it("still fails loudly when signed out on the native engine", async () => {
    await expect(
      runOneShotCompletion({
        request,
        runtime: makeRuntime({ authToken: null, dataDir }),
      }),
    ).rejects.toThrow();
    expect(claudeCodeCalls).toHaveLength(0);
  });
});
