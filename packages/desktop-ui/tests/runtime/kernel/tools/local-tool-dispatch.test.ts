import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TOOL_IDS } from "@stella/contracts/agent-runtime";
import {
  ensureDreamMemoryLayout,
  memoryIndexPath,
} from "@stella/runtime/kernel/memory/dream-storage";
import { dispatchLocalTool } from "@stella/runtime/kernel/tools/local-tool-dispatch";

const activeRoots = new Set<string>();

const createRoot = async (): Promise<string> => {
  const rootPath = await mkdtemp(
    path.join(tmpdir(), "stella-local-tool-dispatch-"),
  );
  activeRoots.add(rootPath);
  return rootPath;
};

afterEach(async () => {
  for (const rootPath of activeRoots) {
    await rm(rootPath, { recursive: true, force: true });
  }
  activeRoots.clear();
});

describe("dispatchLocalTool", () => {
  it("redacts Dream reads before returning memory files to the model", async () => {
    const rootPath = await createRoot();
    const extensionDir = path.join(rootPath, "memories_extensions", "manual");
    await mkdir(extensionDir, { recursive: true });
    const notePath = path.join(extensionDir, "note.md");
    await writeFile(
      notePath,
      "OPENAI_API_KEY=sk-testsecret12345678901234567890\n",
      "utf-8",
    );

    const result = await dispatchLocalTool(
      TOOL_IDS.READ,
      { file_path: notePath },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );

    expect(result.handled).toBe(true);
    const text = result.handled ? result.text : "";
    expect(text).not.toContain("sk-testsecret12345678901234567890");
    expect(text).toContain("OPENAI_API_KEY=");
    expect(text).toContain("***");
  });

  it("redacts Dream StrReplace writes before updating durable memory", async () => {
    const rootPath = await createRoot();
    const memoriesDir = path.join(rootPath, "memories");
    await mkdir(memoriesDir, { recursive: true });
    const memoryPath = path.join(memoriesDir, "MEMORY.md");
    await writeFile(memoryPath, "## Active\nold\n", "utf-8");

    const result = await dispatchLocalTool(
      TOOL_IDS.STR_REPLACE,
      {
        file_path: memoryPath,
        old_string: "old",
        new_string: "OPENAI_API_KEY=sk-testsecret12345678901234567890",
      },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );

    expect(result.handled).toBe(true);
    const updated = await readFile(memoryPath, "utf-8");
    expect(updated).not.toContain("sk-testsecret12345678901234567890");
    expect(updated).toContain("OPENAI_API_KEY=");
    expect(updated).toContain("***");
  });

  it("allows Dream to edit the routing index but keeps profile.md Remember-owned", async () => {
    const rootPath = await createRoot();
    await ensureDreamMemoryLayout(rootPath);
    const indexPath = memoryIndexPath(rootPath);
    const profilePath = path.join(rootPath, "memories", "profile.md");
    await writeFile(profilePath, "# User Profile\n- The user goes by Bob\n");

    const indexResult = await dispatchLocalTool(
      TOOL_IDS.STR_REPLACE,
      {
        file_path: indexPath,
        old_string: "- No routing entries recorded yet.",
        new_string: "- 2026-07-18 — Stella v2; source: memory",
      },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );
    expect(
      JSON.parse(indexResult.handled ? indexResult.text : "{}"),
    ).toMatchObject({ success: true });
    await expect(readFile(indexPath, "utf-8")).resolves.toContain("Stella v2");

    const profileResult = await dispatchLocalTool(
      TOOL_IDS.STR_REPLACE,
      {
        file_path: profilePath,
        old_string: "Bob",
        new_string: "Robert",
      },
      {
        conversationId: "c1",
        dream: { stellaDataDir: rootPath },
      },
    );
    expect(
      JSON.parse(profileResult.handled ? profileResult.text : "{}"),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining("memory_index.md"),
    });
    await expect(readFile(profilePath, "utf-8")).resolves.toContain("Bob");
  });

  it("passes usage priority signals through the Dream list payload", async () => {
    const rootPath = await createRoot();
    const result = await dispatchLocalTool(
      TOOL_IDS.DREAM,
      { action: "list" },
      {
        conversationId: "dream",
        dream: { stellaDataDir: rootPath },
        store: {
          dreamInboxStore: {
            listUnprocessed: () => [
              {
                id: 2,
                kind: "thread_summary",
                sourceKey: "thread-used:run-used",
                threadId: "thread-used",
                runId: "run-used",
                agentType: "general",
                title: "Frequently recalled work",
                content: "Used work",
                metadata: null,
                sourceUpdatedAt: 2_000,
                processedByDreamAt: null,
                usageCount: 4,
                lastUsage: 5_000,
              },
              {
                id: 1,
                kind: "thread_summary",
                sourceKey: "thread-old:run-old",
                threadId: "thread-old",
                runId: "run-old",
                agentType: "general",
                title: "Older unused work",
                content: "Unused work",
                metadata: null,
                sourceUpdatedAt: 1_000,
                processedByDreamAt: null,
                usageCount: 0,
                lastUsage: null,
              },
            ],
          } as never,
        },
      },
    );

    const payload = JSON.parse(result.handled ? result.text : "{}") as {
      items: Array<Record<string, unknown>>;
    };
    expect(payload.items).toMatchObject([
      {
        threadId: "thread-used",
        usage_count: 4,
        last_usage: 5_000,
      },
      { threadId: "thread-old", usage_count: 0 },
    ]);
    expect(payload.items[1]).not.toHaveProperty("last_usage");
  });
});
