import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { buildMemoryReviewSystemPrompt } from "@stella/runtime/kernel/agent-runtime/memory-review";
import {
  readOrSeedPersonality,
  resolvePersonalityPresetContent,
  writePersonality,
} from "@stella/runtime/kernel/personality/personality";
import { setPersonalityVoiceId } from "@stella/runtime/kernel/preferences/local-preferences";
import { defaultPromptForAgentType } from "@stella/runtime/kernel/runner/shared";
import { resolveThreadCompactionSystemPrompt } from "@stella/runtime/kernel/thread-runtime";

const roots = new Set<string>();

const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-prompt-consumers-"));
  roots.add(dir);
  return dir;
};

/** Point the bundled-prompt lookup at a controlled directory. */
const tempPromptsDir = async () => {
  const dir = await tempDir();
  process.env.STELLA_RUNTIME_PROMPTS_DIR = dir;
  return dir;
};

afterEach(async () => {
  delete process.env.STELLA_RUNTIME_PROMPTS_DIR;
  vi.restoreAllMocks();
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const writePrompt = async (dir: string, id: string, content: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.md`), content, "utf-8");
};

describe("bundled prompt consumers", () => {
  it("resolves memory review from the bundled prompts", async () => {
    const prompts = await tempPromptsDir();
    const home = await tempDir();
    expect(buildMemoryReviewSystemPrompt()).toBe("");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("");
    await writePrompt(prompts, "memory-review", "shipped memory review");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("shipped memory review");
  });

  it("resolves thread compaction from the bundled prompts", async () => {
    const prompts = await tempPromptsDir();
    expect(resolveThreadCompactionSystemPrompt()).toBe("");
    await writePrompt(prompts, "thread-compaction", "shipped compaction");
    expect(resolveThreadCompactionSystemPrompt()).toBe("shipped compaction");
  });

  it("resolves generic fallback prompts from the bundled prompts", async () => {
    const prompts = await tempPromptsDir();
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR)).toBe("");
    await writePrompt(
      prompts,
      "fallback-orchestrator",
      "shipped orchestrator fallback",
    );
    await writePrompt(
      prompts,
      "fallback-subagent",
      "shipped subagent fallback",
    );
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR)).toBe(
      "shipped orchestrator fallback",
    );
    expect(defaultPromptForAgentType("unknown-agent")).toBe(
      "shipped subagent fallback",
    );
  });

  it("ships the real bundled prompt set", () => {
    // Without the env override, the repo's own bundle is the source.
    expect(resolveThreadCompactionSystemPrompt()).not.toBe("");
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR)).not.toBe("");
    expect(defaultPromptForAgentType("unknown-agent")).not.toBe("");
  });
});

describe("personality composition", () => {
  it("composes live from the selected bundled preset", async () => {
    const prompts = await tempPromptsDir();
    const home = await tempDir();
    expect(readOrSeedPersonality(home)).toBe("");

    await writePrompt(prompts, "personality-stella", "Stella voice");
    await writePrompt(prompts, "personality-professional", "Professional voice");

    expect(resolvePersonalityPresetContent(home, "stella")).toBe(
      "Stella voice\n",
    );
    expect(readOrSeedPersonality(home)).toBe("Stella voice");

    // Reading never materializes a file — updates keep flowing.
    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).rejects.toThrow();
    await writePrompt(prompts, "personality-stella", "Updated Stella voice");
    expect(readOrSeedPersonality(home)).toBe("Updated Stella voice");
  });

  it("lets a hand-written PERSONALITY.md replace the preset until a new pick clears it", async () => {
    const prompts = await tempPromptsDir();
    const home = await tempDir();
    await writePrompt(prompts, "personality-stella", "Stella voice");
    await writePrompt(prompts, "personality-professional", "Professional voice");

    await writeFile(path.join(home, "PERSONALITY.md"), "my custom voice");
    expect(readOrSeedPersonality(home)).toBe("my custom voice");

    // Picking a preset is an explicit choice: it clears the replacement.
    setPersonalityVoiceId(home, "professional");
    expect(writePersonality(home, "professional")).toBe("Professional voice");
    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).rejects.toThrow();
    expect(readOrSeedPersonality(home)).toBe("Professional voice");
  });
});
