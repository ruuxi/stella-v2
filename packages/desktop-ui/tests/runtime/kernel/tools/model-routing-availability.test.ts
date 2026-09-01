/**
 * Model routing is part of the ordinary Stella experience. Legacy
 * developer-mode preferences and former grandfathering signals must not hide
 * model controls or the spawn_agent model selector.
 *
 * Adapted from main's model-routing-availability test: the shipped-prompt
 * subtest is omitted here because the agent-metadata markdown is owned by a
 * separate reconciliation slice. `orchestrator-direct-tools.test.ts` already
 * asserts the routing sentence reaches the built orchestrator prompt.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDesktopDatabasePath,
  initializeDesktopDatabase,
} from "@stella/runtime/kernel/storage/database-init";
import type { SqliteDatabase } from "@stella/runtime/kernel/storage/shared";
import { createToolHost } from "@stella/runtime/kernel/tools/host";
import { SPAWN_AGENT_MODEL_DESCRIPTION } from "@stella/runtime/kernel/tools/defs/task.js";
import { loadLocalPreferences } from "@stella/runtime/kernel/preferences/local-preferences";
import { getLlmCredentialStorePath } from "@stella/runtime/kernel/storage/llm-credentials";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";

const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");

type TestHostContext = {
  rootPath: string;
  db: SqliteDatabase;
  host: ReturnType<typeof createToolHost>;
};

const activeContexts = new Set<TestHostContext>();
const tempDirs = new Set<string>();

const makeTempDir = async (): Promise<string> => {
  const dir = path.join(
    os.tmpdir(),
    `stella-model-routing-availability-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.add(dir);
  return dir;
};

const createTestHost = async (
  legacyPreferences: Record<string, unknown>,
  withByokCredential = false,
): Promise<TestHostContext> => {
  const rootPath = await makeTempDir();
  await writeFile(
    path.join(rootPath, "preferences.json"),
    JSON.stringify(legacyPreferences),
  );
  if (withByokCredential) {
    await writeFile(
      getLlmCredentialStorePath(rootPath),
      JSON.stringify({
        version: 1,
        credentials: {
          openrouter: {
            provider: "openrouter",
            label: "OpenRouter",
            valueProtected: "legacy-value",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
    );
  }
  const db = new DatabaseSync(getDesktopDatabasePath(rootPath), {
    timeout: 5000,
  }) as unknown as SqliteDatabase;
  initializeDesktopDatabase(db);
  const host = createToolHost({
    stellaAppDir: rootPath,
    agentApi: {
      createAgent: async () => ({ threadId: "thread-1" }),
      getAgent: async () => null,
      cancelAgent: async () => ({ canceled: false }),
    },
  });
  const context = { rootPath, db, host };
  activeContexts.add(context);
  return context;
};

afterEach(async () => {
  for (const context of activeContexts) {
    await context.host.shutdown();
    context.db.close();
  }
  activeContexts.clear();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("model routing availability", () => {
  it.each([
    ["fresh users", {}],
    [
      "legacy users who explicitly disabled developer mode",
      { developerModeEnabled: false },
    ],
    [
      "legacy users who explicitly enabled developer mode",
      { developerModeEnabled: true },
    ],
    [
      "users grandfathered by a non-default engine",
      { agentRuntimeEngine: "codex_cli" },
    ],
    [
      "users grandfathered by a model override",
      { modelOverrides: { general: "openrouter/openai/gpt-5.6-sol" } },
    ],
    ["users grandfathered by a BYOK credential", {}, true],
  ])(
    "serves spawn_agent.model for %s",
    async (_label, preferences, withByokCredential = false) => {
      const { host, rootPath } = await createTestHost(
        preferences as Record<string, unknown>,
        withByokCredential as boolean,
      );
      const spawnAgent = host
        .getToolCatalog(AGENT_IDS.ORCHESTRATOR)
        .find((entry) => entry.name === "spawn_agent");

      expect(spawnAgent?.parameters.properties).toHaveProperty("model");
      expect(
        (spawnAgent?.parameters.properties?.model as { description?: string })
          .description,
      ).toBe(SPAWN_AGENT_MODEL_DESCRIPTION);
      expect(loadLocalPreferences(rootPath)).not.toHaveProperty(
        "developerModeEnabled",
      );
    },
  );
});

describe("model-control renderer availability", () => {
  const read = async (relative: string) =>
    readFile(path.join(repoRoot, relative), "utf-8");

  it("mounts the global Models control without a compatibility gate", async () => {
    const source = await read("packages/desktop-ui/src/routes/__root.tsx");
    expect(source).toContain(
      "<GlobalModelsControl visible={modelControlVisible} />",
    );
    expect(source).not.toContain("developerModeEnabled");
    expect(source).not.toContain("useDeveloperModeEnabled");
  });

  it("keeps composer model pinning and mentions available", async () => {
    const source = await read("packages/desktop-ui/src/app/chat/Composer.tsx");
    expect(source).toContain("const modelPinned = useComposerModelPinned();");
    expect(source).toContain("if (!suggestionsActive)");
    expect(source).not.toContain("developerModeEnabled");
  });

  it("keeps onboarding model selection available", async () => {
    const source = await read(
      "packages/desktop-ui/src/global/onboarding/OnboardingEnginePhase.jsx",
    );
    expect(source).toContain("Bring your own provider");
    expect(source).toContain("claude_code_local");
    expect(source).not.toContain("developerModeEnabled");
  });

  it("removes the obsolete setting and compatibility helpers", async () => {
    const settings = await read(
      "packages/desktop-ui/src/global/settings/tabs/GeneralTab.tsx",
    );
    const preferences = await read(
      "packages/runtime/kernel/preferences/local-preferences.ts",
    );
    expect(settings).not.toContain("settings.developerMode");
    expect(preferences).not.toContain("hasDeveloperModeSignals");
    expect(preferences).not.toContain("getDeveloperModeEnabled");
    expect(preferences).not.toContain("setDeveloperModeEnabled");
  });
});
