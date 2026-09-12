import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  rememberStellaGatewayOrigin,
  resetGatewaySessionState,
} from "@stella/runtime/kernel/gateway-session";

const originalFetch = globalThis.fetch;
const deviceSigner = {
  alg: "ed25519" as const,
  rawPublicKey: new Uint8Array(32),
  sign: async () => "test-signature",
};
const authToken = `header.${Buffer.from(
  JSON.stringify({ iss: "https://issuer.example.test", sub: "user-1" }),
).toString("base64url")}.signature`;
const capabilityExchange = () => {
  const exchange = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          capability: "session-capability",
          expiresAt: Date.now() + 3_600_000,
          audience: "pro",
          budgetMicroCents: -1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  globalThis.fetch = exchange as unknown as typeof fetch;
  return exchange;
};

const makeRuntime = (args: { authToken: string | null; dataDir: string }) => ({
  stellaAppDir: "/tmp/does-not-matter-app-dir",
  stellaDataDir: args.dataDir,
  siteBaseUrl: args.authToken ? "https://site.example.test" : null,
  getAuthToken: () => args.authToken,
  hasConnectedAccount: () => Boolean(args.authToken),
  getDeviceSigner: () => deviceSigner,
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
  claudeCodeEngineActive = false;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-shot-test-"));
  resetGatewaySessionState();
  rememberStellaGatewayOrigin("https://site.example.test", "https://gateway.example.test");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("runOneShotCompletion", () => {
  it("keeps managed ChatGPT utilities off the native Codex path", async () => {
    const exchange = capabilityExchange();
    fs.writeFileSync(
      path.join(dataDir, "preferences.json"),
      JSON.stringify({ agentRuntimeEngine: "codex_cli" }),
    );
    const result = await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken, dataDir }),
    });
    expect(result.text).toBe("relay summary");
    expect(completeSimpleCalls).toHaveLength(1);
    // The managed route relays through the gateway with a session capability.
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(completeSimpleCalls[0]?.options).toMatchObject({
      apiKey: "session-capability",
    });
    expect(
      (completeSimpleCalls[0]?.model as { baseUrl: string }).baseUrl,
    ).toBe("https://gateway.example.test/v1/relay");
  });

  it("falls through to the engine when the gateway is not configured", async () => {
    resetGatewaySessionState();
    claudeCodeEngineActive = true;
    const result = await runOneShotCompletion({
      request,
      runtime: makeRuntime({ authToken, dataDir }),
    });
    expect(result.text).toBe("summarizing agent progress now");
    expect(claudeCodeCalls).toHaveLength(1);
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
