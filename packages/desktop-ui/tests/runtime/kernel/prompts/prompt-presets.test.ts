import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgentSystemPrompt } from "@stella/runtime/kernel/agents/home-agent-prompt";
import {
  deletePromptPreset,
  isCustomizablePromptAgentId,
  listPromptPresets,
  promptSelectionAgentId,
  readPromptPreset,
  savePromptPreset,
  slugifyPresetName,
} from "@stella/runtime/kernel/prompts/prompt-presets";
import {
  getPromptPresetSelection,
  setPromptPresetSelection,
} from "@stella/runtime/kernel/preferences/local-preferences";

const roots = new Set<string>();

const tempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
};

/** A bundled agent-metadata dir standing in for the shipped app bundle. */
const tempBundle = async () => {
  const dir = await tempDir("prompt-preset-bundle-");
  process.env.STELLA_AGENT_METADATA_DIR = dir;
  for (const id of ["orchestrator", "general"]) {
    await writeFile(
      path.join(dir, `${id}.md`),
      `---\nname: ${id}\ntools: Read\n---\nshipped ${id} prompt\n`,
    );
  }
  await writeFile(
    path.join(dir, "orchestrator-orchestrated.md"),
    "---\nname: orchestrator\ntools: Read\n---\nshipped coordinator prompt\n",
  );
  return dir;
};

afterEach(async () => {
  delete process.env.STELLA_AGENT_METADATA_DIR;
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe("prompt preset store", () => {
  it("creates, lists, reads, and deletes presets", async () => {
    const home = await tempDir("prompt-preset-home-");
    const created = await savePromptPreset(home, {
      agentId: "orchestrator",
      name: "My Prompt",
      content: "be terse",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.preset.id).toBe("my-prompt");

    await expect(listPromptPresets(home, "orchestrator")).resolves.toEqual([
      { id: "my-prompt", name: "My Prompt", agentId: "orchestrator" },
    ]);
    await expect(
      readPromptPreset(home, "orchestrator", "my-prompt"),
    ).resolves.toMatchObject({ name: "My Prompt", content: "be terse" });
    // Presets are per-agent.
    await expect(listPromptPresets(home, "general")).resolves.toEqual([]);

    await expect(
      deletePromptPreset(home, "orchestrator", "my-prompt"),
    ).resolves.toBe(true);
    await expect(listPromptPresets(home, "orchestrator")).resolves.toEqual([]);
  });

  it("uniquifies a new preset instead of overwriting a same-named one", async () => {
    const home = await tempDir("prompt-preset-home-");
    const first = await savePromptPreset(home, {
      agentId: "orchestrator",
      name: "Mine",
      content: "one",
    });
    const second = await savePromptPreset(home, {
      agentId: "orchestrator",
      name: "Mine",
      content: "two",
    });
    expect(first.ok && first.preset.id).toBe("mine");
    expect(second.ok && second.preset.id).toBe("mine-2");
    await expect(
      readPromptPreset(home, "orchestrator", "mine"),
    ).resolves.toMatchObject({ content: "one" });
  });

  it("updates in place when an id is supplied", async () => {
    const home = await tempDir("prompt-preset-home-");
    await savePromptPreset(home, {
      agentId: "orchestrator",
      name: "Mine",
      content: "one",
    });
    const updated = await savePromptPreset(home, {
      agentId: "orchestrator",
      id: "mine",
      name: "Renamed",
      content: "two",
    });
    expect(updated.ok).toBe(true);
    await expect(listPromptPresets(home, "orchestrator")).resolves.toEqual([
      { id: "mine", name: "Renamed", agentId: "orchestrator" },
    ]);
    await expect(
      readPromptPreset(home, "orchestrator", "mine"),
    ).resolves.toMatchObject({ content: "two" });
  });

  it("rejects empty content and traversal-style ids", async () => {
    const home = await tempDir("prompt-preset-home-");
    await expect(
      savePromptPreset(home, {
        agentId: "orchestrator",
        name: "Mine",
        content: "   ",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      savePromptPreset(home, {
        agentId: "orchestrator",
        id: "../../escape",
        name: "Mine",
        content: "x",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      readPromptPreset(home, "orchestrator", "../../../etc/passwd"),
    ).resolves.toBeNull();
  });

  it("maps agent types to a selection owner", () => {
    expect(promptSelectionAgentId("orchestrator")).toBe("orchestrator");
    // Both working-mode variants share one selection.
    expect(promptSelectionAgentId("orchestrator-orchestrated")).toBe(
      "orchestrator",
    );
    expect(promptSelectionAgentId("general")).toBe("general");
    expect(promptSelectionAgentId("fashion")).toBeNull();
    expect(isCustomizablePromptAgentId("explore")).toBe(false);
    expect(slugifyPresetName("Über Prompt!!")).toBe("uber-prompt");
  });
});

describe("prompt resolution", () => {
  it("uses the shipped prompt until a preset is selected", async () => {
    await tempBundle();
    const home = await tempDir("prompt-preset-home-");
    await expect(loadAgentSystemPrompt("orchestrator", home)).resolves.toBe(
      "shipped orchestrator prompt",
    );

    await savePromptPreset(home, {
      agentId: "orchestrator",
      name: "Mine",
      content: "my custom prompt",
    });
    // Saving alone changes nothing — selection is what switches it.
    await expect(loadAgentSystemPrompt("orchestrator", home)).resolves.toBe(
      "shipped orchestrator prompt",
    );

    setPromptPresetSelection(home, "orchestrator", "mine");
    expect(getPromptPresetSelection(home, "orchestrator")).toBe("mine");
    await expect(loadAgentSystemPrompt("orchestrator", home)).resolves.toBe(
      "my custom prompt",
    );

    // The selection also applies to the orchestrated working-mode variant…
    await expect(
      loadAgentSystemPrompt("orchestrator-orchestrated", home),
    ).resolves.toBe("my custom prompt");
    // …but never to an agent that isn't customizable.
    await expect(loadAgentSystemPrompt("general", home)).resolves.toBe(
      "shipped general prompt",
    );
  });

  it("falls back to the shipped prompt when the selected preset is gone", async () => {
    await tempBundle();
    const home = await tempDir("prompt-preset-home-");
    await savePromptPreset(home, {
      agentId: "orchestrator",
      name: "Mine",
      content: "my custom prompt",
    });
    setPromptPresetSelection(home, "orchestrator", "mine");
    await expect(loadAgentSystemPrompt("orchestrator", home)).resolves.toBe(
      "my custom prompt",
    );

    await deletePromptPreset(home, "orchestrator", "mine");
    await expect(loadAgentSystemPrompt("orchestrator", home)).resolves.toBe(
      "shipped orchestrator prompt",
    );
  });

  it("keeps the shipped prompt authoritative for the file it ships in", async () => {
    const bundle = await tempBundle();
    const home = await tempDir("prompt-preset-home-");
    await savePromptPreset(home, {
      agentId: "orchestrator",
      name: "Mine",
      content: "my custom prompt",
    });
    setPromptPresetSelection(home, "orchestrator", "mine");

    // An app update rewrites the bundled prompt; the preset file is untouched.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      path.join(bundle, "orchestrator.md"),
      "---\nname: orchestrator\ntools: Read\n---\nshipped orchestrator prompt v2\n",
    );
    await expect(
      readFile(path.join(home, "prompts", "orchestrator", "mine.md"), "utf-8"),
    ).resolves.toContain("my custom prompt");

    setPromptPresetSelection(home, "orchestrator", "default");
    await expect(loadAgentSystemPrompt("orchestrator", home)).resolves.toBe(
      "shipped orchestrator prompt v2",
    );
  });

  it("ignores a stray preset directory with no selection", async () => {
    await tempBundle();
    const home = await tempDir("prompt-preset-home-");
    await mkdir(path.join(home, "prompts", "orchestrator"), {
      recursive: true,
    });
    await writeFile(
      path.join(home, "prompts", "orchestrator", "rogue.md"),
      "---\nname: rogue\n---\nrogue prompt\n",
    );
    await expect(loadAgentSystemPrompt("orchestrator", home)).resolves.toBe(
      "shipped orchestrator prompt",
    );
  });
});
