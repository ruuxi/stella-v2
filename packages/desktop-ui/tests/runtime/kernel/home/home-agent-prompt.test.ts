import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadAgentSystemPrompt } from "@stella/runtime/kernel/agents/home-agent-prompt";

const roots = new Set<string>();

const tempMetadataDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-prompt-"));
  roots.add(root);
  process.env.STELLA_AGENT_METADATA_DIR = root;
  return root;
};

afterEach(async () => {
  delete process.env.STELLA_AGENT_METADATA_DIR;
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

const writeAgent = async (dir: string, id: string, body: string) => {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${id}.md`),
    `---\nname: ${id}\ndescription: d\ntools: Read\nmaxAgentDepth: 1\n---\n${body}`,
  );
};

describe("loadAgentSystemPrompt", () => {
  it("returns the bundled body with frontmatter stripped", async () => {
    const dir = await tempMetadataDir();
    await writeAgent(dir, "general", "bundled general body\n");
    await expect(loadAgentSystemPrompt("general")).resolves.toBe(
      "bundled general body",
    );
  });

  it("returns undefined for a capability-comment-only body", async () => {
    const dir = await tempMetadataDir();
    await writeAgent(dir, "general", "");
    await expect(loadAgentSystemPrompt("general")).resolves.toBeUndefined();
  });

  it("picks up edits live despite the signature cache", async () => {
    const dir = await tempMetadataDir();
    await writeAgent(dir, "general", "first body\n");
    await expect(loadAgentSystemPrompt("general")).resolves.toBe("first body");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeAgent(dir, "general", "second body that is longer\n");
    await expect(loadAgentSystemPrompt("general")).resolves.toBe(
      "second body that is longer",
    );
  });

  it("returns undefined for an unknown agent", async () => {
    await tempMetadataDir();
    await expect(loadAgentSystemPrompt("nope")).resolves.toBeUndefined();
  });

  it("reads the real bundled orchestrator prompt without an override", async () => {
    delete process.env.STELLA_AGENT_METADATA_DIR;
    await expect(loadAgentSystemPrompt("orchestrator")).resolves.toContain(
      "You are Stella, the user's personal AI assistant.",
    );
  });
});
