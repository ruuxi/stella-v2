import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ModelRuntime } from "@stella/runtime/ai/model-runtime";
import {
  groupCatalogModelsByProvider,
  listLocalCatalogModels,
  mergeCatalogModels,
  normalizeRuntimeCatalogSnapshot,
  withStellaPresetFallbacks,
} from "@/global/settings/lib/model-catalog";
import { intersectChatGptModels } from "@/global/settings/lib/engine-model-routing";

const tempDirs: string[] = [];

const makeTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "stella-picker-catalog-integration-"),
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("model picker catalog integration", () => {
  it("keeps shared ChatGPT/Codex and provider models visible through refresh and restart", async () => {
    const stellaDataDir = await makeTempDir();
    const sharedCodexModelId = "gpt-catalog-only-shared";
    const invalidBuiltinCollisionId = "gpt-5.4";
    const responseByProvider = new Map<string, unknown>([
      [
        "openai-codex",
        {
          [sharedCodexModelId]: remoteModel(sharedCodexModelId, "openai-codex"),
          [invalidBuiltinCollisionId]: {
            ...remoteModel(invalidBuiltinCollisionId, "openai-codex"),
            api: undefined,
            name: "Malformed collision",
          },
        },
      ],
      [
        "anthropic",
        {
          "claude-catalog-only": remoteModel(
            "claude-catalog-only",
            "anthropic",
            { api: "anthropic-messages" },
          ),
        },
      ],
      [
        "azure-openai-responses",
        {
          "azure-catalog-only": remoteModel(
            "azure-catalog-only",
            "azure-openai-responses",
            { api: "azure-openai-responses", baseUrl: "" },
          ),
        },
      ],
      [
        "openrouter",
        {
          "openrouter-catalog-only": remoteModel(
            "openrouter-catalog-only",
            "openrouter",
            { api: "openai-completions" },
          ),
          "negative-cost-collision": remoteModel(
            "negative-cost-collision",
            "openrouter",
            {
              api: "openai-completions",
              cost: { input: -1, output: -1, cacheRead: 0, cacheWrite: 0 },
            },
          ),
        },
      ],
    ]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const provider = decodeURIComponent(
          new URL(String(input)).pathname.split("/").at(-1) ?? "",
        );
        const payload = responseByProvider.get(provider);
        return payload === undefined
          ? new Response("", { status: 404 })
          : Response.json(payload);
      });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pickerAvailability = (runtime: ModelRuntime) => {
      const managed = normalizeRuntimeCatalogSnapshot(runtime.getSnapshot());
      const direct = mergeCatalogModels(
        listLocalCatalogModels(),
        managed.directModels,
      );
      const allModels = mergeCatalogModels(
        withStellaPresetFallbacks([]),
        direct,
      );
      return {
        allModels,
        providers: new Set(
          groupCatalogModelsByProvider(allModels).map(
            (group) => group.provider,
          ),
        ),
        compatibleChatGptModels: intersectChatGptModels(allModels, [
          { id: sharedCodexModelId, hidden: false },
          { id: "codex-live-only", hidden: false },
        ]),
      };
    };

    const runtime = new ModelRuntime();
    await runtime.initialize({ stellaDataDir, allowNetwork: false });
    await runtime.getSnapshotForListing({ forceRefresh: true });

    const refreshed = pickerAvailability(runtime);
    expect(
      refreshed.compatibleChatGptModels.map((model) => model.modelId),
    ).toEqual([sharedCodexModelId]);
    for (const provider of [
      "stella",
      "local",
      "openai-codex",
      "anthropic",
      "openrouter",
    ]) {
      expect(refreshed.providers.has(provider)).toBe(true);
    }
    expect(
      refreshed.allModels.some(
        (model) => model.id === "anthropic/claude-catalog-only",
      ),
    ).toBe(true);
    expect(
      refreshed.allModels.some(
        (model) => model.id === "openrouter/openrouter-catalog-only",
      ),
    ).toBe(true);
    expect(
      refreshed.allModels.some(
        (model) => model.id === "openrouter/negative-cost-collision",
      ),
    ).toBe(false);
    expect(
      runtime.getModel("openai-codex", invalidBuiltinCollisionId)?.name,
    ).not.toBe("Malformed collision");
    expect(
      runtime.getModel("azure-openai-responses", "azure-catalog-only"),
    ).toMatchObject({
      api: "azure-openai-responses",
      baseUrl: "",
    });

    const stored = JSON.parse(
      await readFile(path.join(stellaDataDir, "models-store.json"), "utf8"),
    ) as Record<string, { models?: unknown[]; checkedAt?: number }>;
    expect(stored["openai-codex"]?.models).toHaveLength(1);
    expect(stored.openrouter?.models).toHaveLength(1);
    expect(stored["azure-openai-responses"]?.models).toHaveLength(1);
    expect(stored["openai-codex"]?.checkedAt).toEqual(expect.any(Number));

    const requestCountAfterRefresh = fetchSpy.mock.calls.length;
    const restarted = new ModelRuntime();
    await restarted.initialize({ stellaDataDir, allowNetwork: false });
    const restored = pickerAvailability(restarted);

    expect(fetchSpy).toHaveBeenCalledTimes(requestCountAfterRefresh);
    expect(
      restored.compatibleChatGptModels.map((model) => model.modelId),
    ).toEqual([sharedCodexModelId]);
    expect(
      restored.allModels.some(
        (model) => model.id === "anthropic/claude-catalog-only",
      ),
    ).toBe(true);
    expect(
      restored.allModels.some(
        (model) => model.id === "openrouter/openrouter-catalog-only",
      ),
    ).toBe(true);
  });
});
