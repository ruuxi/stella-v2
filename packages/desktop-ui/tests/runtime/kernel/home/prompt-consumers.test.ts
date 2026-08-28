import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { buildMemoryReviewSystemPrompt } from "@stella/runtime/kernel/agent-runtime/memory-review";
import { readOrSeedPersonality } from "@stella/runtime/kernel/personality/personality";
import { defaultPromptForAgentType } from "@stella/runtime/kernel/runner/shared";
import { resolveThreadCompactionSystemPrompt } from "@stella/runtime/kernel/thread-runtime";

const roots = new Set<string>();

const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-prompt-consumers-"));
  roots.add(dir);
  return dir;
};

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

  it("ships the real bundled prompt set", async () => {
    expect(resolveThreadCompactionSystemPrompt()).not.toBe("");
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR)).not.toBe("");
    expect(defaultPromptForAgentType("unknown-agent")).not.toBe("");
    expect(readOrSeedPersonality(await tempDir())).not.toBe("");
  });
});

describe("personality composition", () => {
  it("composes live from the bundled personality prompt", async () => {
    const prompts = await tempPromptsDir();
    const home = await tempDir();
    expect(readOrSeedPersonality(home)).toBe("");

    await writePrompt(prompts, "personality", "Stella voice");

    expect(readOrSeedPersonality(home)).toBe("Stella voice");

    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).rejects.toThrow();
    await writePrompt(prompts, "personality", "Updated Stella voice");
    expect(readOrSeedPersonality(home)).toBe("Updated Stella voice");
  });

  it("lets a hand-written PERSONALITY.md replace the bundled prompt", async () => {
    const prompts = await tempPromptsDir();
    const home = await tempDir();
    await writePrompt(prompts, "personality", "Stella voice");

    await writeFile(path.join(home, "PERSONALITY.md"), "my custom voice");
    expect(readOrSeedPersonality(home)).toBe("my custom voice");
  });
});
