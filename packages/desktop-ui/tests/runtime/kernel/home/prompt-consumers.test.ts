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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const writeSystemPrompt = async (home: string, id: string, content: string) => {
  await mkdir(path.join(home, "system", "prompts"), { recursive: true });
  await writeFile(
    path.join(home, "system", "prompts", `${id}.md`),
    content,
    "utf-8",
  );
};

const writeUserPrompt = async (home: string, id: string, content: string) => {
  await mkdir(path.join(home, "prompts"), { recursive: true });
  await writeFile(path.join(home, "prompts", `${id}.md`), content, "utf-8");
};

describe("home prompt consumers", () => {
  it("resolves memory review from the system mirror, user replacement winning", async () => {
    const home = await tempDir();
    expect(buildMemoryReviewSystemPrompt()).toBe("");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("");
    await writeSystemPrompt(home, "memory-review", "shipped memory review");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("shipped memory review");
    await writeUserPrompt(home, "memory-review", "my memory review");
    expect(buildMemoryReviewSystemPrompt(home)).toBe("my memory review");
  });

  it("resolves thread compaction from the system mirror", async () => {
    const home = await tempDir();
    expect(resolveThreadCompactionSystemPrompt()).toBe("");
    expect(resolveThreadCompactionSystemPrompt(home)).toBe("");
    await writeSystemPrompt(home, "thread-compaction", "shipped compaction");
    expect(resolveThreadCompactionSystemPrompt(home)).toBe(
      "shipped compaction",
    );
  });

  it("resolves generic fallback prompts from the system mirror", async () => {
    const home = await tempDir();
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR)).toBe("");
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR, home)).toBe("");
    await writeSystemPrompt(
      home,
      "fallback-orchestrator",
      "shipped orchestrator fallback",
    );
    await writeSystemPrompt(
      home,
      "fallback-subagent",
      "shipped subagent fallback",
    );
    expect(defaultPromptForAgentType(AGENT_IDS.ORCHESTRATOR, home)).toBe(
      "shipped orchestrator fallback",
    );
    expect(defaultPromptForAgentType("unknown-agent", home)).toBe(
      "shipped subagent fallback",
    );
  });
});

describe("personality composition", () => {
  it("composes live from the selected system preset", async () => {
    const home = await tempDir();
    expect(readOrSeedPersonality(home)).toBe("");

    await writeSystemPrompt(home, "personality-stella", "Stella voice");
    await writeSystemPrompt(
      home,
      "personality-professional",
      "Professional voice",
    );

    expect(resolvePersonalityPresetContent(home, "stella")).toBe(
      "Stella voice\n",
    );
    expect(readOrSeedPersonality(home)).toBe("Stella voice");

    // Reading never materializes a file — updates keep flowing.
    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).rejects.toThrow();
    await writeSystemPrompt(home, "personality-stella", "Updated Stella voice");
    expect(readOrSeedPersonality(home)).toBe("Updated Stella voice");
  });

  it("lets a hand-written PERSONALITY.md replace the preset until a new pick clears it", async () => {
    const home = await tempDir();
    await writeSystemPrompt(home, "personality-stella", "Stella voice");
    await writeSystemPrompt(
      home,
      "personality-professional",
      "Professional voice",
    );

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
