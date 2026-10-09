import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveLlmRoute,
  resolveLlmRouteForCatalogEnrichment,
} from "@stella/runtime/kernel/model-routing";
import {
  invalidateStellaModelCatalogCache,
  withStellaModelCatalogMetadata,
} from "@stella/runtime/kernel/stella-model-catalog";
import { getFileEditToolFamily } from "@stella/runtime/kernel/tools/file-edit-policy";
import {
  getRememberedStellaGatewayOrigin,
  rememberStellaGatewayOrigin,
  resetGatewaySessionState,
} from "@stella/runtime/kernel/gateway-session";

const originalFetch = globalThis.fetch;
const GATEWAY = "https://gateway.example.test";
const BACKEND = "https://backend.example.test";

const site = (token: string) => ({
  baseUrl: "https://stella.example.test",
  getAuthToken: () => token,
});

describe("Stella model catalog metadata", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateStellaModelCatalogCache();
    resetGatewaySessionState();
    vi.restoreAllMocks();
  });

  it("resolves backend default selections through catalog defaults", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          gateway: { origin: GATEWAY },
          data: [],
          defaults: [
            {
              agentType: "general",
              model: "stella/standard",
              resolvedModel: "openai/gpt-5.5",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site: site("token-default"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-default"),
      deviceId: "device-a",
    });

    expect(enriched.model.id).toBe("stella/default");
    expect(enriched.toolPolicyModel).toMatchObject({
      id: "openai/gpt-5.5",
      provider: "openai",
      api: "openai",
    });
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: enriched.toolPolicyModel ?? enriched.model,
      }),
    ).toBe("apply_patch");
  });

  it("keeps the safe managed fallback when targeted metadata is unavailable", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          gateway: { origin: GATEWAY },
          data: [],
          defaults: [
            {
              agentType: "general",
              model: "stella/default",
              resolvedModel: "accounts/fireworks/models/deepseek-v4-flash-0731",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site: site("token-fireworks-fallback"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-fireworks-fallback"),
      deviceId: "device-fireworks-fallback",
    });

    expect(enriched.model).toMatchObject({
      api: "openai-responses",
      provider: "fireworks",
      contextWindow: 80_000,
      maxTokens: 16_384,
    });
  });

  it("resolves opaque Stella aliases from catalog upstreamModel", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          gateway: { origin: GATEWAY },
          data: [
            {
              id: "stella/soda",
              name: "Soda",
              provider: "stella",
              api: "openai-completions",
              upstreamModel: "openai/gpt-5.5",
            },
          ],
          defaults: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/soda",
      agentType: "general",
      site: site("token-soda"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-soda"),
      deviceId: "device-b",
    });

    expect(enriched.model.id).toBe("stella/soda");
    expect(enriched.model.api).toBe("openai-completions");
    expect(enriched.toolPolicyModel?.id).toBe("openai/gpt-5.5");
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: enriched.toolPolicyModel ?? enriched.model,
      }),
    ).toBe("apply_patch");
  });

  it("lets an explicit catalog upstream outrank an unavailable local namespace", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            gateway: { origin: GATEWAY },
            data: [
              {
                id: "stella/gpt-5.6-sol",
                name: "GPT-5.6 Sol",
                provider: "stella",
                upstreamModel: "openai/gpt-5.6-sol",
              },
            ],
            defaults: [],
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRouteForCatalogEnrichment({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/gpt-5.6-sol",
      agentType: "general",
      site: site("token-catalog-override"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-catalog-override"),
      deviceId: "device-catalog-override",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enriched.model.id).toBe("stella/gpt-5.6-sol");
    expect(
      (
        enriched.model as typeof enriched.model & {
          upstreamModelId?: string;
        }
      ).upstreamModelId,
    ).toBe("gpt-5.6-sol");
    expect(enriched.toolPolicyModel?.id).toBe("openai/gpt-5.6-sol");
  });

  it("resolves the backend gpt-5.5 selection through its catalog upstream", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            gateway: { origin: GATEWAY },
            data: [
              {
                id: "stella/gpt-5.5",
                name: "GPT-5.5",
                provider: "stella",
                upstreamModel: "openai/gpt-5.5",
              },
            ],
            defaults: [],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const route = resolveLlmRouteForCatalogEnrichment({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/gpt-5.5",
      agentType: "general",
      site: site("token-gpt-5.5"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-gpt-5.5"),
      deviceId: "device-gpt-5.5",
    });

    expect(enriched.toolPolicyModel?.id).toBe("openai/gpt-5.5");
    expect(
      (
        enriched.model as typeof enriched.model & {
          upstreamModelId?: string;
        }
      ).upstreamModelId,
    ).toBe("gpt-5.5");
  });

  it("fails after one catalog lookup when no override can resolve the model", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ gateway: { origin: GATEWAY }, data: [], defaults: [] }), {
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRouteForCatalogEnrichment({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/gpt-5.6-sol",
      agentType: "general",
      site: site("token-catalog-miss"),
      reasoningEffort: "high",
    });

    await expect(
      withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
        route,
        agentType: "general",
        site: site("token-catalog-miss"),
        deviceId: "device-catalog-miss",
        reasoningEffort: "high",
      }),
    ).rejects.toThrow(/codex\/gpt-5\.6-sol:high/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses catalog protocol for explicit Stella passthrough ids when the gateway is known", async () => {
    rememberStellaGatewayOrigin("https://stella.example.test", GATEWAY);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            gateway: { origin: GATEWAY },
            data: [
              {
                id: "stella/anthropic/claude-opus-4.6",
                name: "Claude Opus 4.6",
                provider: "stella",
                api: "openai-completions",
                upstreamModel: "anthropic/claude-opus-4.6",
              },
            ],
            defaults: [],
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/anthropic/claude-opus-4.6",
      agentType: "general",
      site: site("token-passthrough"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-passthrough"),
      deviceId: "device-a",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enriched.model.api).toBe("openai-completions");
    expect(enriched.toolPolicyModel).toMatchObject({
      id: "anthropic/claude-opus-4.6",
      provider: "anthropic",
      api: "anthropic",
    });
    expect(
      getFileEditToolFamily({
        agentType: "general",
        model: enriched.toolPolicyModel ?? enriched.model,
      }),
    ).toBe("write_edit");
  });

  it("fetches the catalog once for a passthrough id when the gateway origin is not yet known", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ gateway: { origin: GATEWAY }, data: [], defaults: [] }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: "stella/anthropic/claude-opus-4.6",
      agentType: "general",
      site: site("token-passthrough-cold"),
    });
    expect(route.model.baseUrl).toBe(
      "https://model-gateway.unconfigured.invalid/v1/relay",
    );
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-passthrough-cold"),
      deviceId: "device-a",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enriched.model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
    expect(getRememberedStellaGatewayOrigin("https://stella.example.test")).toBe(GATEWAY);
  });

  it("fails closed when the catalog does not advertise a gateway origin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [],
            defaults: [
              {
                agentType: "general",
                model: "stella/standard",
                resolvedModel: "openai/gpt-5.5",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site: site("token-no-gateway"),
    });
    await expect(
      withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
        route,
        agentType: "general",
        site: site("token-no-gateway"),
        deviceId: "device-no-gateway",
      }),
    ).rejects.toThrow(/model gateway is not configured/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/Catalog fetch failed: .*gateway\.origin/),
    );
    await expect(route.getApiKey()).rejects.toThrow(/model gateway is not configured/i);
  });

  it("relays every enriched route through the catalog-advertised gateway", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          gateway: { origin: `${GATEWAY}/` },
          data: [],
          defaults: [
            {
              agentType: "general",
              model: "stella/standard",
              resolvedModel: "openai/gpt-5.5",
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const route = resolveLlmRoute({
      stellaAppDir: "/tmp/stella",
      modelName: undefined,
      agentType: "general",
      site: site("token-relay"),
    });
    const enriched = await withStellaModelCatalogMetadata({
      backendUrl: BACKEND,
      route,
      agentType: "general",
      site: site("token-relay"),
      deviceId: "device-relay",
    });

    expect(enriched.model.baseUrl).toBe(`${GATEWAY}/v1/relay`);
  });
});
