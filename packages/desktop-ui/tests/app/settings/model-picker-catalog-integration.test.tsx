// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ModelRuntime } from "@stella/runtime/ai/model-runtime";

vi.mock("@/global/auth/services/auth-session", () => ({
  useDesktopAuthSession: () => ({ data: null, isPending: false, error: null }),
  getAuthSessionSnapshot: () => ({
    data: null,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/global/settings/hooks/model-catalog-updated-at", () => ({
  useModelCatalogUpdatedAt: () => 1,
  readModelCatalogUpdatedAtSnapshot: () => 1,
}));

vi.mock("@/shared/lib/use-convex-one-shot", () => ({
  usePersistentConvexOneShot: () => undefined,
}));

vi.mock("@/platform/http/service-request", () => ({
  createServiceRequest: async () => ({
    endpoint: "https://stella.test/api/models",
    headers: {},
  }),
}));

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-real-picker-catalog-"),
  );
  tempDirs.push(directory);
  return directory;
};

const remoteModel = (
  id: string,
  provider: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name: id,
  provider,
  api: "openai-responses",
  baseUrl: `https://${provider}.example.test/v1`,
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 256_000,
  maxTokens: 32_000,
  ...overrides,
});

const preferences = {
  defaultModels: {},
  modelOverrides: {
    orchestrator: "openai-codex/gpt-picker-phase-0",
    general: "openai-codex/gpt-picker-phase-0",
  },
  assistantPropagatedAgents: [],
  reasoningEfforts: {},
  stellaConversationModelOverrides: {},
  stellaConversationReasoningEfforts: {},
  agentRuntimeEngine: "codex_cli" as const,
  codexModel: "gpt-picker-phase-0",
  codexModelExplicit: true,
  codexReasoningEffort: "default" as const,
  claudeCodeModel: "default",
  claudeCodeReasoningEffort: "default" as const,
  maxAgentConcurrency: 24,
  imageGeneration: { provider: "stella" as const },
  realtimeVoice: { provider: "stella" as const },
};

const waitFor = async (assertion: () => void, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
  throw lastError;
};

const textCount = (container: Element, text: string): number =>
  Array.from(container.querySelectorAll("*")).filter(
    (node) => node.children.length === 0 && node.textContent === text,
  ).length;

describe("real model picker catalog integration", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("recovers from runner absence and keeps both real picker surfaces available through dual refresh and restart", async () => {
    const stellaDataDir = await makeTempDir();
    await writeFile(
      path.join(stellaDataDir, "models.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {},
          anthropic: {},
          "azure-openai-responses": {},
          openrouter: {},
        },
      }),
    );

    let phase = 0;
    const providerPayload = (provider: string): unknown => {
      if (provider === "openai-codex") {
        const id = `gpt-picker-phase-${phase}`;
        return {
          [id]: remoteModel(id, provider, {
            api: "openai-codex-responses",
          }),
          "gpt-5.4": {
            ...remoteModel("gpt-5.4", provider),
            name: "Malformed collision",
            api: undefined,
          },
        };
      }
      if (provider === "anthropic") {
        const id = `claude-picker-phase-${phase}`;
        return {
          [id]: remoteModel(id, provider, { api: "anthropic-messages" }),
        };
      }
      if (provider === "azure-openai-responses") {
        return {
          "azure-picker-empty-base": remoteModel(
            "azure-picker-empty-base",
            provider,
            { api: "azure-openai-responses", baseUrl: "" },
          ),
        };
      }
      if (provider === "openrouter") {
        const id = `openrouter-picker-phase-${phase}`;
        return {
          [id]: remoteModel(id, provider, { api: "openai-completions" }),
          "openrouter-invalid-negative": remoteModel(
            "openrouter-invalid-negative",
            provider,
            {
              api: "openai-completions",
              cost: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ),
        };
      }
      return undefined;
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.origin === "https://stella.test") {
        return Response.json({ data: [], defaults: [] });
      }
      const provider = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const payload = providerPayload(provider);
      return payload === undefined
        ? new Response("", { status: 404 })
        : Response.json(payload);
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    let activeRuntime = new ModelRuntime();
    await activeRuntime.initialize({
      stellaDataDir,
      allowNetwork: true,
      catalogBaseUrl: "https://catalog.test",
    });
    const protectedBuiltin = activeRuntime.getModel("openai-codex", "gpt-5.4");
    expect(protectedBuiltin).toBeDefined();
    expect(protectedBuiltin?.name).not.toBe("Malformed collision");

    let runnerUnavailable = true;
    let successfulListings = 0;
    let forcedRuntimeListings = 0;
    let codexListings = 0;
    let savedPreferences = structuredClone(preferences);
    const catalogListeners = new Set<(snapshot: unknown) => void>();
    const availabilityListeners = new Set<
      (snapshot: { connected: boolean; ready: boolean }) => void
    >();
    const attachRuntimePublication = (runtime: ModelRuntime) =>
      runtime.onCatalogChanged((snapshot) => {
        for (const listener of catalogListeners) listener(snapshot);
      });
    attachRuntimePublication(activeRuntime);

    const listLlmModels = vi.fn(
      async (options?: { forceRefresh?: boolean }) => {
        if (runnerUnavailable) {
          throw new Error("Stella runtime is not ready to list models.");
        }
        if (options?.forceRefresh) forcedRuntimeListings += 1;
        const snapshot = await activeRuntime.getSnapshotForListing(options);
        successfulListings += 1;
        return snapshot;
      },
    );
    const listCodexModels = vi.fn(async () => {
      codexListings += 1;
      return {
        models: [{ id: `gpt-picker-phase-${phase}`, hidden: false }],
      };
    });

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      agent: {
        onAvailability: (
          listener: (snapshot: { connected: boolean; ready: boolean }) => void,
        ) => {
          availabilityListeners.add(listener);
          return () => availabilityListeners.delete(listener);
        },
      },
      system: {
        listLlmModels,
        onLlmModelsUpdated: (listener: (snapshot: unknown) => void) => {
          catalogListeners.add(listener);
          return () => catalogListeners.delete(listener);
        },
        listCodexModels,
        listClaudeCodeModels: vi.fn(async () => ({ models: [] })),
        getLocalModelPreferences: vi.fn(async () => savedPreferences),
        setLocalModelPreferences: vi.fn(async (patch: object) => {
          savedPreferences = { ...savedPreferences, ...patch };
          return savedPreferences;
        }),
        listLlmCredentials: vi.fn(async () => []),
        listLlmOAuthProviders: vi.fn(async () => []),
        listLlmOAuthCredentials: vi.fn(async () => []),
        validateLlmOAuthCredential: vi.fn(async () => ({
          connected: true,
          needsReauth: false,
        })),
      },
    };

    const [
      { AgentModelPicker },
      { EngineTabContent },
      modelCatalogModule,
      codexModule,
    ] = await Promise.all([
      import("@/global/settings/AgentModelPicker"),
      import("@/shell/display/EngineTabContent"),
      import("@/global/settings/hooks/use-model-catalog"),
      import("@/global/settings/hooks/use-codex-model-catalog"),
    ]);

    const renderPickers = async () => {
      await act(async () => {
        root.render(
          <>
            <section data-testid="agent-picker">
              <AgentModelPicker />
            </section>
            <section data-testid="engine-picker">
              <EngineTabContent />
            </section>
          </>,
        );
      });
    };

    await renderPickers();
    await waitFor(() => expect(listLlmModels).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Stella runtime is not ready to list models.",
      ),
    );
    expect(successfulListings).toBe(0);
    expect(codexListings).toBe(1);

    runnerUnavailable = false;
    await act(async () => {
      for (const listener of availabilityListeners) {
        listener({ connected: true, ready: true });
      }
    });
    await waitFor(() => expect(successfulListings).toBe(1));
    await waitFor(() =>
      expect(textCount(container, "gpt-picker-phase-0")).toBeGreaterThanOrEqual(
        2,
      ),
    );
    expect(forcedRuntimeListings).toBe(1);
    expect(container.textContent).toContain("Stella Standard");
    expect(container.textContent).toContain("llama3.2");
    expect(container.textContent).toContain("claude-picker-phase-0");
    expect(container.textContent).toContain("openrouter-picker-phase-0");
    expect(container.textContent).toContain("azure-picker-empty-base");
    expect(container.textContent).toContain("GPT-5.4");

    phase = 1;
    const agentRefresh = container.querySelector(
      "[data-testid='agent-picker'] .agent-model-picker-refresh",
    ) as HTMLButtonElement | null;
    expect(agentRefresh).not.toBeNull();
    const forcedBeforeAgent = forcedRuntimeListings;
    const codexBeforeAgent = codexListings;
    await act(async () => agentRefresh?.click());
    await waitFor(() =>
      expect(forcedRuntimeListings).toBe(forcedBeforeAgent + 1),
    );
    await waitFor(() => expect(codexListings).toBe(codexBeforeAgent + 1));
    await waitFor(() =>
      expect(textCount(container, "gpt-picker-phase-1")).toBeGreaterThanOrEqual(
        2,
      ),
    );
    expect(container.textContent).toContain("claude-picker-phase-1");

    phase = 2;
    const engineRefresh = container.querySelector(
      "[data-testid='engine-picker'] .engine-runtime-model-panel__refresh",
    ) as HTMLButtonElement | null;
    expect(engineRefresh).not.toBeNull();
    const forcedBeforeEngine = forcedRuntimeListings;
    const codexBeforeEngine = codexListings;
    await act(async () => engineRefresh?.click());
    await waitFor(() =>
      expect(forcedRuntimeListings).toBe(forcedBeforeEngine + 1),
    );
    await waitFor(() => expect(codexListings).toBe(codexBeforeEngine + 1));
    await waitFor(() =>
      expect(textCount(container, "gpt-picker-phase-2")).toBeGreaterThanOrEqual(
        2,
      ),
    );

    expect(activeRuntime.getModel("openai-codex", "gpt-5.4")).toEqual(
      protectedBuiltin,
    );
    expect(
      activeRuntime.getModel(
        "azure-openai-responses",
        "azure-picker-empty-base",
      ),
    ).toMatchObject({ api: "azure-openai-responses", baseUrl: "" });
    expect(
      activeRuntime.getModel("openrouter", "openrouter-invalid-negative"),
    ).toBeUndefined();

    const storedBeforeRestart = JSON.parse(
      await readFile(path.join(stellaDataDir, "models-store.json"), "utf8"),
    ) as Record<string, { models?: unknown[]; checkedAt?: number }>;
    expect(storedBeforeRestart["openai-codex"]?.models).toHaveLength(1);
    expect(storedBeforeRestart.anthropic?.models).toHaveLength(1);
    expect(storedBeforeRestart["azure-openai-responses"]?.models).toHaveLength(
      1,
    );
    expect(storedBeforeRestart.openrouter?.models).toHaveLength(1);
    expect(storedBeforeRestart.openrouter?.checkedAt).toEqual(
      expect.any(Number),
    );

    await act(async () => root.unmount());
    modelCatalogModule.resetModelCatalogStoresForTests();
    codexModule.resetCodexModelCatalogStoreForTests();
    const restarted = new ModelRuntime();
    await restarted.initialize({ stellaDataDir, allowNetwork: false });
    activeRuntime = restarted;
    attachRuntimePublication(restarted);
    root = createRoot(container);
    await renderPickers();

    await waitFor(() =>
      expect(textCount(container, "gpt-picker-phase-2")).toBeGreaterThanOrEqual(
        2,
      ),
    );
    expect(container.textContent).toContain("Stella Standard");
    expect(container.textContent).toContain("llama3.2");
    expect(container.textContent).toContain("claude-picker-phase-2");
    expect(container.textContent).toContain("openrouter-picker-phase-2");
    expect(container.textContent).toContain("azure-picker-empty-base");
    expect(container.textContent).toContain("GPT-5.4");
    expect(restarted.getModel("openai-codex", "gpt-5.4")).toEqual(
      protectedBuiltin,
    );
    expect(
      restarted.getModel("azure-openai-responses", "azure-picker-empty-base"),
    ).toMatchObject({ api: "azure-openai-responses", baseUrl: "" });
    expect(
      restarted.getModel("anthropic", "claude-picker-phase-2"),
    ).toBeDefined();
    expect(
      restarted.getModel("openrouter", "openrouter-picker-phase-2"),
    ).toBeDefined();
  }, 30_000);
});
