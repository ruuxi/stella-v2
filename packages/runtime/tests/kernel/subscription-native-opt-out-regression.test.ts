import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import { usesManagedSubscriptionHarness } from "@stella/runtime/kernel/agent-runtime/external-engines";
import {
  getSubscriptionHarnessEnabled,
  updateLocalModelPreferences,
} from "@stella/runtime/kernel/preferences/local-preferences";
import {
  buildAgentContext,
  captureEffectiveModelConfig,
  resolveSubscriptionHarnessRouteModel,
} from "@stella/runtime/kernel/runner/context";
import type { RunnerContext } from "@stella/runtime/kernel/runner/types";

const tempDirs: string[] = [];

const makeDataDir = (): string => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stella-native-opt-out-regression-"),
  );
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const resolvedRoute = (
  provider: "stella" | "openai-codex",
  id: string,
): ResolvedLlmRoute =>
  ({
    model: {
      id,
      name: id,
      provider,
      api: "openai-responses",
      baseUrl: "https://example.invalid",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    route: provider === "stella" ? "stella" : "oauth",
    getApiKey: () => "test-key",
  }) as ResolvedLlmRoute;

const contextFor = (stellaDataDir: string): RunnerContext =>
  ({
    stellaDataDir,
    stellaAppDir: stellaDataDir,
    deviceId: "native-opt-out-regression",
    runtimeStore: {
      loadThreadMessages: () => [],
      listActiveThreads: () => [],
      getOrchestratorReminderState: () => ({
        shouldInjectDynamicReminder: false,
        reminderTokensSinceLastInjection: 0,
      }),
    },
    state: { loadedAgents: [] },
  }) as unknown as RunnerContext;

describe("subscription harness durability", () => {
  it("fails legacy and explicit-native snapshots closed to native execution", () => {
    expect(usesManagedSubscriptionHarness(undefined)).toBe(false);
    expect(usesManagedSubscriptionHarness({})).toBe(false);
    expect(
      usesManagedSubscriptionHarness({ subscriptionHarnessEnabled: false }),
    ).toBe(false);
    expect(
      usesManagedSubscriptionHarness({ subscriptionHarnessEnabled: true }),
    ).toBe(true);
  });

  it("always keeps Codex on Stella's harness while Claude retains its opt-out", async () => {
    const stellaDataDir = makeDataDir();
    const context = contextFor(stellaDataDir);
    const codex = resolvedRoute("openai-codex", "gpt-5.6-sol");
    const stella = resolvedRoute("stella", "openai/gpt-5.6-sol");

    expect(getSubscriptionHarnessEnabled(stellaDataDir, "codex_cli")).toBe(
      true,
    );
    expect(
      getSubscriptionHarnessEnabled(stellaDataDir, "claude_code_local"),
    ).toBe(true);

    const harnessedCodex = await buildAgentContext(context, {
      conversationId: "harnessed-codex",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-harnessed-codex",
      configuredAgentEngine: "codex_cli",
      model: "openai-codex/gpt-5.6-sol",
      resolvedLlm: codex,
    });
    const harnessedClaude = await buildAgentContext(context, {
      conversationId: "harnessed-claude",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-harnessed-claude",
      configuredAgentEngine: "claude_code_local",
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(harnessedCodex.modelConfigSnapshot).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
    });
    expect(harnessedClaude.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
      subscriptionHarnessEnabled: true,
    });

    updateLocalModelPreferences(stellaDataDir, {
      useNativeClaudeCodeRuntime: true,
    });
    const nativeClaude = await buildAgentContext(context, {
      conversationId: "native-claude",
      agentType: AGENT_IDS.GENERAL,
      runId: "run-native-claude",
      configuredAgentEngine: "claude_code_local",
      model: "stella/default",
      resolvedLlm: stella,
    });
    expect(nativeClaude.modelConfigSnapshot).toMatchObject({
      engine: "claude_code_local",
      subscriptionHarnessEnabled: false,
    });
    expect(harnessedCodex.modelConfigSnapshot?.subscriptionHarnessEnabled).toBe(
      true,
    );
    expect(
      harnessedClaude.modelConfigSnapshot?.subscriptionHarnessEnabled,
    ).toBe(true);
  });

  it("migrates explicit-native and legacy-native Codex snapshots to Responses", async () => {
    const stellaDataDir = makeDataDir();
    const context = contextFor(stellaDataDir);
    updateLocalModelPreferences(stellaDataDir, {
      useNativeClaudeCodeRuntime: false,
    });
    const route = resolvedRoute("openai-codex", "gpt-5.6-sol");
    const explicitNative: AgentModelConfigSnapshot = {
      engine: "codex_cli",
      subscriptionHarnessEnabled: false,
      routeModel: "openai-codex/gpt-5.6-sol",
      engineModel: "gpt-5.6-sol",
    };
    const legacyNative: AgentModelConfigSnapshot = {
      engine: "codex_cli",
      routeModel: "openai-codex/gpt-5.4",
      engineModel: "gpt-5.4",
    };

    for (const [name, snapshot] of [
      ["explicit", explicitNative],
      ["legacy", legacyNative],
    ] as const) {
      const built = await buildAgentContext(context, {
        conversationId: `${name}-native`,
        agentType: AGENT_IDS.GENERAL,
        runId: `run-${name}-native`,
        modelConfigSnapshot: snapshot,
        model: snapshot.routeModel,
        resolvedLlm: route,
      });
      expect(built.modelConfigSnapshot).toEqual({
        ...snapshot,
        subscriptionHarnessEnabled: true,
        routeModel: `openai-codex/${snapshot.engineModel}`,
      });
    }
  });

  it("routes eligible Codex Generals through the in-process provider", () => {
    const stellaDataDir = makeDataDir();
    updateLocalModelPreferences(stellaDataDir, {
      codexModel: "gpt-5.6-sol",
      codexModelExplicit: true,
    });
    const common = {
      stellaDataDir,
      agentType: AGENT_IDS.GENERAL,
      configuredEngine: "codex_cli" as const,
      configuredModel: "openai-codex/gpt-5.6-sol",
    };

    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: true,
      }),
    ).toBe("openai-codex/gpt-5.6-sol");
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: true,
        spawnEngine: { engine: "default" },
      }),
    ).toBeUndefined();
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        agentType: AGENT_IDS.ORCHESTRATOR,
        subscriptionHarnessEnabled: true,
      }),
    ).toBeUndefined();

    const persistedHarness: AgentModelConfigSnapshot = {
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.6-luna",
      engineModel: "gpt-5.6-luna",
    };
    expect(
      resolveSubscriptionHarnessRouteModel({
        ...common,
        subscriptionHarnessEnabled: false,
        modelConfigSnapshot: persistedHarness,
      }),
    ).toBe("openai-codex/gpt-5.6-luna");
  });

  it("captures the exact resolved Codex harness model and mode", () => {
    const stellaDataDir = makeDataDir();
    expect(
      captureEffectiveModelConfig({
        stellaDataDir,
        engine: "codex_cli",
        subscriptionHarnessEnabled: true,
        configuredModel: "stella/light",
        resolvedLlm: resolvedRoute("openai-codex", "gpt-5.4-mini"),
      }),
    ).toMatchObject({
      engine: "codex_cli",
      subscriptionHarnessEnabled: true,
      routeModel: "openai-codex/gpt-5.4-mini",
      engineModel: "gpt-5.4-mini",
    });
  });
});
