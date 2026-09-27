import { afterEach, describe, expect, it } from "vitest";

import { getLoadedModelRegistry } from "@stella/contracts/model-registry";
import {
  clearApiProviders,
  getRegisteredApis,
} from "@stella/runtime/ai/api-registry";
import {
  registerBuiltInApiProviders,
  resetApiProviders,
} from "@stella/runtime/ai/providers/register-builtins";
import { registerCloudApiProviders } from "@stella/runtime/ai/providers/register-cloud";

const CLOUD_APIS = [
  "anthropic-messages",
  "openai-codex-responses",
  "openai-completions",
  "openai-responses",
];

const BUILTIN_APIS = [...CLOUD_APIS, "google-generative-ai"].sort();

describe("api provider registration", () => {
  afterEach(() => {
    resetApiProviders();
  });

  it("registers exactly the cloud adapter set", () => {
    clearApiProviders();
    registerCloudApiProviders();
    expect(getRegisteredApis().sort()).toEqual(CLOUD_APIS);
  });

  it("registers exactly the built-in adapter set", () => {
    clearApiProviders();
    registerBuiltInApiProviders();
    expect(getRegisteredApis().sort()).toEqual(BUILTIN_APIS);
  });

  it("catalogs only models whose api has a built-in adapter", () => {
    const catalogApis = new Set<string>();
    for (const models of Object.values(getLoadedModelRegistry())) {
      for (const model of Object.values(models)) {
        catalogApis.add(model.api);
      }
    }
    expect([...catalogApis].sort()).toEqual(BUILTIN_APIS);
  });
});
