import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadHomeAgentSystemPrompt } from "@stella/runtime/kernel/agents/home-agent-prompt";

const roots = new Set<string>();

const tempDir = async (prefix: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.add(root);
  return root;
};

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

const writeSystemAgent = async (home: string, id: string, body: string) => {
  await mkdir(path.join(home, "system", "agents"), { recursive: true });
  await writeFile(
    path.join(home, "system", "agents", `${id}.md`),
    `---\nname: ${id}\ndescription: d\ntools: Read\nmaxAgentDepth: 1\n---\n${body}`,
  );
};

describe("loadHomeAgentSystemPrompt", () => {
  it("returns the system base body alone", async () => {
    const home = await tempDir("home-agent-prompt-");
    await writeSystemAgent(home, "general", "system base body\n");
    await expect(loadHomeAgentSystemPrompt(home, "general")).resolves.toBe(
      "system base body",
    );
  });

  it("appends a user overlay under the customizations heading", async () => {
    const home = await tempDir("home-agent-prompt-");
    await writeSystemAgent(home, "general", "system base body\n");
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(
      path.join(home, "agents", "general.md"),
      "Always answer in French.\n",
    );
    await expect(loadHomeAgentSystemPrompt(home, "general")).resolves.toBe(
      "system base body\n\n# User customizations\n\nAlways answer in French.",
    );
  });

  it("lets a .replace.md file win over base and overlay", async () => {
    const home = await tempDir("home-agent-prompt-");
    await writeSystemAgent(home, "general", "system base body\n");
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(path.join(home, "agents", "general.md"), "overlay\n");
    await writeFile(
      path.join(home, "agents", "general.replace.md"),
      "full replacement prompt\n",
    );
    await expect(loadHomeAgentSystemPrompt(home, "general")).resolves.toBe(
      "full replacement prompt",
    );
  });

  it("serves a standalone user agent with no system counterpart", async () => {
    const home = await tempDir("home-agent-prompt-");
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(
      path.join(home, "agents", "my-agent.md"),
      "---\nname: Mine\n---\nmy own agent prompt\n",
    );
    await expect(loadHomeAgentSystemPrompt(home, "my-agent")).resolves.toBe(
      "my own agent prompt",
    );
  });

  it("picks up edits live despite the signature cache", async () => {
    const home = await tempDir("home-agent-prompt-");
    await writeSystemAgent(home, "general", "first body\n");
    await expect(loadHomeAgentSystemPrompt(home, "general")).resolves.toBe(
      "first body",
    );
    // A later mtime guarantees a changed stat signature.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeSystemAgent(home, "general", "second body that is longer\n");
    await expect(loadHomeAgentSystemPrompt(home, "general")).resolves.toBe(
      "second body that is longer",
    );
  });

  it("returns undefined when nothing exists for the agent", async () => {
    const home = await tempDir("home-agent-prompt-");
    await expect(
      loadHomeAgentSystemPrompt(home, "general"),
    ).resolves.toBeUndefined();
  });
});
