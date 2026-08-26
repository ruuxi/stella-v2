/**
 * Developer-mode gate — the single flag that hides every power-user surface
 * from the default experience at ASSEMBLY level (not CSS):
 *
 *   - spawn_agent's `model` parameter is omitted from the served tool schema
 *     when the flag is off, and byte-identical to today's schema when on;
 *   - the engine-routing guidance fenced in the shipped orchestrator prompts
 *     is stripped from the assembled system prompt when off and untouched
 *     (markers removed) when on;
 *   - grandfathering: with no explicit choice stored, the flag derives from
 *     existing power-user signals (BYOK credentials, non-default engine,
 *     model overrides) so an update never hides surfaces already in use.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
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
import {
  SPAWN_AGENT_MODEL_DESCRIPTION,
  withoutSpawnAgentModelParam,
} from "@stella/runtime/kernel/tools/defs/task.js";
import {
  getDeveloperModeEnabled,
  hasDeveloperModeSignals,
  loadLocalPreferences,
  saveLocalPreferences,
  setDeveloperModeEnabled,
  updateLocalModelPreferences,
} from "@stella/runtime/kernel/preferences/local-preferences";
import { getLlmCredentialStorePath } from "@stella/runtime/kernel/storage/llm-credentials";
import {
  applyDeveloperModePromptGate,
  DEV_MODE_PROMPT_END,
  DEV_MODE_PROMPT_START,
} from "@stella/runtime/kernel/agents/prompt-dev-mode";
import { loadAgentSystemPrompt } from "@stella/runtime/kernel/agents/home-agent-prompt";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";

const ROUTING_SENTENCE =
  "The authoritative model and engine selector list is in the `spawn_agent.model` field description. Do not invent aliases.";

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
    `stella-dev-mode-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  tempDirs.add(dir);
  return dir;
};

const createTestHost = async (): Promise<TestHostContext> => {
  const rootPath = await makeTempDir();
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

type SpawnAgentSchema = {
  name: string;
  parameters: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

const spawnAgentFromCatalog = (
  host: ReturnType<typeof createToolHost>,
): SpawnAgentSchema => {
  const tool = host
    .getToolCatalog(AGENT_IDS.ORCHESTRATOR)
    .find((entry) => entry.name === "spawn_agent") as
    | SpawnAgentSchema
    | undefined;
  if (!tool) throw new Error("spawn_agent missing from catalog");
  return tool;
};

describe("developer-mode tool schema gate", () => {
  it("omits the spawn_agent model parameter when developer mode is off", async () => {
    const { host, rootPath } = await createTestHost();
    setDeveloperModeEnabled(rootPath, false);
    const tool = spawnAgentFromCatalog(host);
    expect(tool.parameters.properties).toBeDefined();
    expect(Object.keys(tool.parameters.properties!)).toEqual([
      "description",
      "prompt",
    ]);
    expect(tool.parameters.required).toEqual(["description", "prompt"]);
  });

  it("defaults to off (schema omitted) on a fresh data dir with no signals", async () => {
    const { host } = await createTestHost();
    const tool = spawnAgentFromCatalog(host);
    expect(tool.parameters.properties).not.toHaveProperty("model");
  });

  it("serves today's full schema when developer mode is on", async () => {
    const { host, rootPath } = await createTestHost();
    setDeveloperModeEnabled(rootPath, true);
    const tool = spawnAgentFromCatalog(host);
    expect(tool.parameters.properties).toHaveProperty("model");
    const model = tool.parameters.properties!.model as {
      description?: string;
    };
    expect(model.description).toBe(SPAWN_AGENT_MODEL_DESCRIPTION);
  });

  it("re-gates per call when the flag flips without a host rebuild", async () => {
    const { host, rootPath } = await createTestHost();
    setDeveloperModeEnabled(rootPath, true);
    expect(spawnAgentFromCatalog(host).parameters.properties).toHaveProperty(
      "model",
    );
    setDeveloperModeEnabled(rootPath, false);
    expect(
      spawnAgentFromCatalog(host).parameters.properties,
    ).not.toHaveProperty("model");
  });

  it("leaves non-spawn tools untouched by the schema filter", () => {
    const other = {
      name: "send_input",
      description: "x",
      parameters: { properties: { model: { type: "string" } } },
    };
    expect(withoutSpawnAgentModelParam(other)).toBe(other);
  });
});

describe("developer-mode prompt gate", () => {
  const metadataDir = path.join(
    repoRoot,
    "packages/runtime/extensions/stella-runtime/agent-metadata",
  );

  it("fences the routing guidance in the shipped orchestrator prompt", async () => {
      const agentId = "orchestrator";
      process.env.STELLA_AGENT_METADATA_DIR = metadataDir;
      try {
        const shipped = await loadAgentSystemPrompt(agentId);
        expect(shipped).toBeDefined();
        expect(shipped).toContain(DEV_MODE_PROMPT_START);
        expect(shipped).toContain(ROUTING_SENTENCE);

        const off = applyDeveloperModePromptGate(shipped!, false);
        expect(off).not.toContain(ROUTING_SENTENCE);
        expect(off).not.toContain("spawn_agent.model");
        expect(off).not.toContain(DEV_MODE_PROMPT_START);
        expect(off).not.toContain(DEV_MODE_PROMPT_END);
        expect(off).not.toMatch(/\n{3,}/);

        const on = applyDeveloperModePromptGate(shipped!, true);
        expect(on).toContain(ROUTING_SENTENCE);
        expect(on).not.toContain(DEV_MODE_PROMPT_START);
        expect(on).not.toContain(DEV_MODE_PROMPT_END);
        // Byte-for-byte today's prompt: exactly the shipped body minus the
        // two marker lines.
        expect(on).toBe(
          shipped!
            .split("\n")
            .filter(
              (line) =>
                line.trim() !== DEV_MODE_PROMPT_START &&
                line.trim() !== DEV_MODE_PROMPT_END,
            )
            .join("\n"),
        );
      } finally {
        delete process.env.STELLA_AGENT_METADATA_DIR;
      }
    });

  it("passes marker-free prompts through untouched", () => {
    const body = "Line one.\n\nLine two.";
    expect(applyDeveloperModePromptGate(body, false)).toBe(body);
    expect(applyDeveloperModePromptGate(body, true)).toBe(body);
  });
});

describe("developer-mode renderer gate contract", () => {
  // The repo's tests don't render React surfaces; like the other layout
  // contract tests, assert the gates exist in source so the Models control,
  // composer mini picker, and mention menu stay mount-gated (not CSS-hidden).
  const read = async (relative: string) => {
    const { readFile } = await import("node:fs/promises");
    return readFile(path.join(repoRoot, relative), "utf-8");
  };

  it("mount-gates the global Models control", async () => {
    const source = await read(
      "packages/desktop-ui/src/routes/__root.tsx",
    );
    expect(source).toContain("useDeveloperModeEnabled()");
    expect(source).toMatch(
      /developerModeEnabled \? \(\s*<GlobalModelsControl/,
    );
  });

  it("gates the composer mini picker and model mention menu", async () => {
    const source = await read(
      "packages/desktop-ui/src/app/chat/Composer.tsx",
    );
    expect(source).toContain(
      "useComposerModelPinned() && developerModeEnabled",
    );
    expect(source).toContain("!suggestionsActive || !developerModeEnabled");
  });
});

describe("developer-mode grandfathering", () => {
  it("is off for a fresh install with no power-user signals", async () => {
    const dir = await makeTempDir();
    expect(hasDeveloperModeSignals(dir)).toBe(false);
    expect(getDeveloperModeEnabled(dir)).toBe(false);
  });

  it("auto-enables when a non-default engine is configured", async () => {
    const dir = await makeTempDir();
    updateLocalModelPreferences(dir, { agentRuntimeEngine: "codex_cli" });
    expect(getDeveloperModeEnabled(dir)).toBe(true);
  });

  it("auto-enables when a model override exists", async () => {
    const dir = await makeTempDir();
    updateLocalModelPreferences(dir, {
      modelOverrides: { general: "openrouter/openai/gpt-5.6-sol" },
    });
    expect(getDeveloperModeEnabled(dir)).toBe(true);
  });

  it("auto-enables when a BYOK credential is stored", async () => {
    const dir = await makeTempDir();
    await writeFile(
      getLlmCredentialStorePath(dir),
      JSON.stringify({
        version: 1,
        credentials: {
          openrouter: {
            provider: "openrouter",
            label: "OpenRouter",
            valueProtected: "irrelevant",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
    );
    expect(getDeveloperModeEnabled(dir)).toBe(true);
  });

  it("lets an explicit choice win over derived signals", async () => {
    const dir = await makeTempDir();
    updateLocalModelPreferences(dir, { agentRuntimeEngine: "codex_cli" });
    setDeveloperModeEnabled(dir, false);
    expect(getDeveloperModeEnabled(dir)).toBe(false);
    setDeveloperModeEnabled(dir, true);
    expect(getDeveloperModeEnabled(dir)).toBe(true);
  });

  it("persists the explicit flag tri-state through save/load", async () => {
    const dir = await makeTempDir();
    // Never-set stays derived (absent from disk).
    saveLocalPreferences(dir, loadLocalPreferences(dir));
    expect(
      typeof loadLocalPreferences(dir).developerModeEnabled,
    ).not.toBe("boolean");
    setDeveloperModeEnabled(dir, true);
    expect(loadLocalPreferences(dir).developerModeEnabled).toBe(true);
  });
});
