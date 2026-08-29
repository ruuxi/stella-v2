// The catalog JSON is a runtime data asset, not a bundled import: a packaged
// build has no `packages/runtime/` source tree, so it resolves through
// `STELLA_APP_RESOURCES_PATH` into the `runtime/` tree that
// `dev-electron-build.mjs` assembles and electron-builder ships as
// extraResources. These tests pin that packaged lookup path — the failure
// mode they guard is a shipped app where every OAuth connector throws on
// first use because the copy never landed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalAppDir = process.env.STELLA_APP_DIR;
const originalResourcesPath = process.env.STELLA_APP_RESOURCES_PATH;
const tempDirs: string[] = [];

const makeTempDir = () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-oauth-catalog-"));
  tempDirs.push(tempDir);
  return tempDir;
};

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

afterEach(() => {
  restoreEnv("STELLA_APP_DIR", originalAppDir);
  restoreEnv("STELLA_APP_RESOURCES_PATH", originalResourcesPath);
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
  vi.resetModules();
});

// Sequential: the catalog module memoizes on first access and both cases mutate
// the same process-wide env, so they cannot share a module registry.
describe.sequential("OAuth provider catalog resolution", () => {
  it("loads immutable metadata from the packaged Resources runtime tree", async () => {
    const root = makeTempDir();
    const resourcesPath = path.join(root, "Resources");
    const catalogPath = path.join(
      resourcesPath,
      "runtime",
      "kernel",
      "connectors",
      "oauth-provider-catalog.json",
    );
    mkdirSync(path.dirname(catalogPath), { recursive: true });
    writeFileSync(
      catalogPath,
      JSON.stringify([
        {
          id: "fixture",
          name: "Fixture",
          category: "test",
          auth: ["OAUTH2"],
          catalogToolCount: 0,
          description: "Fixture provider",
          sourceUrl: "https://example.invalid",
          tools: [],
        },
      ]),
    );
    process.env.STELLA_APP_DIR = root;
    process.env.STELLA_APP_RESOURCES_PATH = resourcesPath;
    vi.resetModules();

    const { getOAuthProviderCatalog } = await import(
      "@stella/runtime/kernel/connectors/oauth-provider-catalog"
    );

    expect(getOAuthProviderCatalog()).toEqual([
      expect.objectContaining({ id: "fixture" }),
    ]);
  });

  it("reports the exact packaged path when the required catalog is absent", async () => {
    const root = makeTempDir();
    const resourcesPath = path.join(root, "Resources");
    mkdirSync(resourcesPath, { recursive: true });
    process.env.STELLA_APP_DIR = root;
    process.env.STELLA_APP_RESOURCES_PATH = resourcesPath;
    vi.resetModules();

    const { getOAuthProviderCatalog } = await import(
      "@stella/runtime/kernel/connectors/oauth-provider-catalog"
    );

    expect(() => getOAuthProviderCatalog()).toThrow(
      `Failed to load oauth-provider-catalog.json (tried: ${path.join(
        resourcesPath,
        "runtime",
        "kernel",
        "connectors",
        "oauth-provider-catalog.json",
      )})`,
    );
  });
});
