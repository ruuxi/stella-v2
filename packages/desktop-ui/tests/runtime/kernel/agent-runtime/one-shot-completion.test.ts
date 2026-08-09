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
const accessibleApiKeyProviders = new Set<string>();
const accessibleOAuthProviders = new Set<string>();

vi.mock(
  "@stella/runtime/kernel/integrations/claude-code-agent-runtime",
  () => ({
    CLAUDE_CODE_LIGHT_MODEL: "haiku",
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

vi.mock("@stella/runtime/kernel/storage/local-llm-credential-access", () => ({
  hasAccessibleLocalLlmApiKey: (_dataDir: string, provider: string) =>
    accessibleApiKeyProviders.has(provider),
  hasAccessibleLocalLlmOAuthCredential: (_dataDir: string, provider: string) =>
    accessibleOAuthProviders.has(provider),
  getAccessibleLocalLlmApiKey: async (_dataDir: string, provider: string) =>
    accessibleApiKeyProviders.has(provider) ? "local-api-key" : null,
  getAccessibleLocalLlmOAuthApiKey: async (
    _dataDir: string,
    provider: string,
  ) => (accessibleOAuthProviders.has(provider) ? "chatgpt-oauth-token" : null),
}));

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

const makeRuntime = (args: {
  authToken: string | null;
  dataDir: string;
  forbidStellaAccountAccess?: boolean;
}) => {
  const forbidden = () => {
    throw new Error("Stella account state must not be read");
  };
  return {
    stellaAppDir: "/tmp/does-not-matter-app-dir",
    stellaDataDir: args.dataDir,
    siteBaseUrl: args.authToken ? "https://site.example.test" : null,
    getAuthToken: args.forbidStellaAccountAccess
      ? forbidden
      : () => args.authToken,
    hasConnectedAccount: args.forbidStellaAccountAccess
      ? forbidden
      : () => Boolean(args.authToken),
    requestRuntimeAuthRefresh: args.forbidStellaAccountAccess
      ? async () => forbidden()
      : undefined,
  };
};

const request = {
  agentType: "progress_summary",
  model: "stella/light",
  fallbackAgentTypes: ["general"],
  systemPrompt: "narrate",
  userText: "Task: test\nCurrent activity: working",
  maxOutputTokens: 24,
  temperature: 1.0,
  reasoningEffort: "none" as const,
  utility: true,
};

const withSnapshot = (
  modelConfigSnapshot: NonNullable<
    Parameters<typeof runOneShotCompletion>[0]["request"]["modelConfigSnapshot"]
  >,
) => ({ ...request, modelConfigSnapshot });

const codexRequest = withSnapshot({
  engine: "codex_cli",
  routeModel: "stella/openai/gpt-5.6-sol",
  engineModel: "gpt-5.6-sol",
});
const claudeRequest = withSnapshot({
  engine: "claude_code_local",
  routeModel: "stella/anthropic/claude-sonnet-4-6",
  engineModel: "sonnet",
});
const stellaRequest = withSnapshot({
  engine: "default",
  routeModel: "stella/openai/gpt-5.6-sol",
});

let dataDir: string;

beforeEach(() => {
  claudeCodeCalls.length = 0;
  completeSimpleCalls.length = 0;
  closedSessionKeys.length = 0;
  scheduledSessionCloses.length = 0;
  codexCalls.length = 0;
  accessibleApiKeyProviders.clear();
  accessibleOAuthProviders.clear();
  accessibleOAuthProviders.add("openai-codex");
  claudeCodeEngineActive = false;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-shot-test-"));
});

describe("runOneShotCompletion", () => {
  it("uses a stateless direct OpenAI Luna request for Codex utility work", async () => {
    const result = await runOneShotCompletion({
      request: codexRequest,
      runtime: makeRuntime({
        authToken: null,
        dataDir,
        forbidStellaAccountAccess: true,
      }),
    });
    expect(result.text).toBe("relay summary");
    expect(codexCalls).toHaveLength(0);
    expect(completeSimpleCalls).toHaveLength(1);
    expect(completeSimpleCalls[0]?.model).toMatchObject({
      id: "gpt-5.6-luna",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
    });
    expect(completeSimpleCalls[0]?.context).toMatchObject({
      systemPrompt: "narrate",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: codexRequest.userText }],
        },
      ],
    });
    expect(completeSimpleCalls[0]?.options).toMatchObject({
      disableReasoning: true,
      maxTokens: 24,
      temperature: 1.0,
    });
  });

  it("uses the Claude Code engine when no LLM route resolves (signed-out CC user)", async () => {
    claudeCodeEngineActive = true;
    const result = await runOneShotCompletion({
      request: claudeRequest,
      runtime: makeRuntime({
        authToken: null,
        dataDir,
        forbidStellaAccountAccess: true,
      }),
    });
    expect(result.text).toBe("summarizing agent progress now");
    expect(claudeCodeCalls).toHaveLength(1);
    // The explicit stella/light pin must flow through so CC maps it to Haiku.
    expect(claudeCodeCalls[0]?.stellaModel).toBe(
      "stella/anthropic/claude-sonnet-4-6",
    );
    expect(claudeCodeCalls[0]?.modelOverride).toBe("haiku");
    expect(claudeCodeCalls[0]?.effortLevel).toBe("low");
    expect(completeSimpleCalls).toHaveLength(0);
  });

  it("splits CC preferences (data dir) from the CLI working directory (home)", async () => {
    claudeCodeEngineActive = true;
    await runOneShotCompletion({
      request: claudeRequest,
      runtime: makeRuntime({
        authToken: null,
        dataDir,
        forbidStellaAccountAccess: true,
      }),
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
      modelConfigSnapshot: claudeRequest.modelConfigSnapshot,
      sessionKey: "progress-summary:agent-1",
      sessionIdleTtlMs: 60_000,
    };
    await runOneShotCompletion({
      request: persistentRequest,
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(claudeCodeCalls[0]?.sessionKey).toBe("progress-summary:agent-1");
    expect(scheduledSessionCloses).toEqual([
      { sessionKey: "progress-summary:agent-1", timeoutMs: 60_000 },
    ]);

    await runOneShotCompletion({
      request: {
        agentType: "progress_summary",
        userText: "",
        sessionKey: "progress-summary:agent-1",
        closeSession: true,
      },
      runtime: makeRuntime({ authToken: null, dataDir }),
    });
    expect(closedSessionKeys).toEqual(["progress-summary:agent-1"]);
    expect(claudeCodeCalls).toHaveLength(1);
  });

  it("still fails loudly when signed out on the native engine", async () => {
    await expect(
      runOneShotCompletion({
        request: stellaRequest,
        runtime: makeRuntime({ authToken: null, dataDir }),
      }),
    ).rejects.toThrow();
    expect(claudeCodeCalls).toHaveLength(0);
  });

  it("uses a captured direct-provider route without Stella fallback", async () => {
    accessibleApiKeyProviders.add("openrouter");
    const directRequest = withSnapshot({
      engine: "default",
      routeModel: "openrouter/anthropic/claude-opus-4.6",
    });

    await runOneShotCompletion({
      request: directRequest,
      runtime: makeRuntime({
        authToken: null,
        dataDir,
        forbidStellaAccountAccess: true,
      }),
    });

    expect(completeSimpleCalls).toHaveLength(1);
    expect(completeSimpleCalls[0]?.model).toMatchObject({
      provider: "openrouter",
      id: "anthropic/claude-opus-4.6",
    });
  });

  it("does not fall through to Stella when Codex credentials are missing", async () => {
    accessibleOAuthProviders.delete("openai-codex");

    await expect(
      runOneShotCompletion({
        request: codexRequest,
        runtime: makeRuntime({
          authToken: null,
          dataDir,
          forbidStellaAccountAccess: true,
        }),
      }),
    ).rejects.toThrow(/credential/i);

    expect(completeSimpleCalls).toHaveLength(0);
  });

  it("rejects a progress summary without an immutable model snapshot", async () => {
    await expect(
      runOneShotCompletion({
        request,
        runtime: makeRuntime({ authToken: null, dataDir }),
      }),
    ).rejects.toThrow(/model configuration snapshot/i);
  });
});
