import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  migrateLegacyHomeLayout,
  retireAutomaticMemoryArtifacts,
} from "@stella/runtime/kernel/home/legacy-migration";

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

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** The old whole-directory hash: sorted rel paths + contents, NUL-joined. */
const dirHash = (files: Record<string, string>) => {
  const h = createHash("sha256");
  for (const rel of Object.keys(files).sort()) {
    h.update(rel);
    h.update("\0");
    h.update(files[rel]!);
    h.update("\0");
  }
  return h.digest("hex");
};

const manifest = (entries: Record<string, { lastSyncedHash: string }>) =>
  `${JSON.stringify({ version: 2, entries }, null, 2)}\n`;

describe("migrateLegacyHomeLayout", () => {
  it("deletes unmodified entries, converts modified agents to .replace.md, keeps forks", async () => {
    const home = await tempDir("legacy-migration-");

    // Agents: one pristine, one customized, one user-owned (no record).
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(path.join(home, "agents", "general.md"), "shipped general");
    await writeFile(
      path.join(home, "agents", "orchestrator.md"),
      "customized orchestrator",
    );
    await writeFile(path.join(home, "agents", "my-agent.md"), "mine");
    await writeFile(
      path.join(home, "agents", ".bundled-manifest.json"),
      manifest({
        general: { lastSyncedHash: hash("shipped general") },
        orchestrator: { lastSyncedHash: hash("shipped orchestrator") },
      }),
    );

    // Prompts: one pristine, one customized.
    await mkdir(path.join(home, "prompts"), { recursive: true });
    await writeFile(
      path.join(home, "prompts", "fallback-orchestrator.md"),
      "shipped fallback",
    );
    await writeFile(
      path.join(home, "prompts", "thread-compaction.md"),
      "customized compaction",
    );
    await writeFile(
      path.join(home, "prompts", ".bundled-manifest.json"),
      manifest({
        "fallback-orchestrator": {
          lastSyncedHash: hash("shipped fallback"),
        },
        "thread-compaction": { lastSyncedHash: hash("shipped compaction") },
      }),
    );

    // Skills: one pristine, one forked, one user-owned.
    await mkdir(path.join(home, "skills", "pdf"), { recursive: true });
    await writeFile(path.join(home, "skills", "pdf", "SKILL.md"), "pdf");
    await mkdir(path.join(home, "skills", "browser"), { recursive: true });
    await writeFile(
      path.join(home, "skills", "browser", "SKILL.md"),
      "forked browser",
    );
    await mkdir(path.join(home, "skills", "gmail"), { recursive: true });
    await writeFile(path.join(home, "skills", "gmail", "SKILL.md"), "mine");
    await writeFile(
      path.join(home, "skills", ".bundled-manifest.json"),
      manifest({
        pdf: { lastSyncedHash: dirHash({ "SKILL.md": "pdf" }) },
        browser: { lastSyncedHash: dirHash({ "SKILL.md": "stock browser" }) },
      }),
    );

    // Personality: customized.
    await writeFile(path.join(home, "PERSONALITY.md"), "my personality");
    await writeFile(
      path.join(home, ".personality-manifest.json"),
      manifest({ PERSONALITY: { lastSyncedHash: hash("stock personality") } }),
    );

    await migrateLegacyHomeLayout(home);

    // Pristine entries are gone; the system mirror provides them now.
    await expect(
      readFile(path.join(home, "agents", "general.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(home, "prompts", "fallback-orchestrator.md"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(home, "skills", "pdf", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();

    // Customized agent became a full replacement.
    await expect(
      readFile(path.join(home, "agents", "orchestrator.replace.md"), "utf-8"),
    ).resolves.toBe("customized orchestrator");
    await expect(
      readFile(path.join(home, "agents", "orchestrator.md"), "utf-8"),
    ).rejects.toThrow();

    // Customized prompt/skill/personality stay in place as replacements/forks.
    await expect(
      readFile(path.join(home, "prompts", "thread-compaction.md"), "utf-8"),
    ).resolves.toBe("customized compaction");
    await expect(
      readFile(path.join(home, "skills", "browser", "SKILL.md"), "utf-8"),
    ).resolves.toBe("forked browser");
    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).resolves.toBe("my personality");

    // User-owned entries untouched.
    await expect(
      readFile(path.join(home, "agents", "my-agent.md"), "utf-8"),
    ).resolves.toBe("mine");
    await expect(
      readFile(path.join(home, "skills", "gmail", "SKILL.md"), "utf-8"),
    ).resolves.toBe("mine");

    // Manifests are gone.
    await expect(
      readFile(path.join(home, "agents", ".bundled-manifest.json"), "utf-8"),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(home, ".personality-manifest.json"), "utf-8"),
    ).rejects.toThrow();
  });

  it("removes an unmodified PERSONALITY.md so live composition takes over", async () => {
    const home = await tempDir("legacy-migration-");
    await writeFile(path.join(home, "PERSONALITY.md"), "stock personality");
    await writeFile(
      path.join(home, ".personality-manifest.json"),
      manifest({ PERSONALITY: { lastSyncedHash: hash("stock personality") } }),
    );

    await migrateLegacyHomeLayout(home);

    await expect(
      readFile(path.join(home, "PERSONALITY.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("is a no-op on an already-migrated home", async () => {
    const home = await tempDir("legacy-migration-");
    await mkdir(path.join(home, "agents"), { recursive: true });
    await writeFile(path.join(home, "agents", "orchestrator.md"), "overlay");

    await migrateLegacyHomeLayout(home);

    await expect(
      readFile(path.join(home, "agents", "orchestrator.md"), "utf-8"),
    ).resolves.toBe("overlay");
  });

  it("idempotently removes only retired automatic-memory artifacts", async () => {
    const home = await tempDir("retired-memory-migration-");
    await mkdir(path.join(home, "memories"), { recursive: true });
    await mkdir(path.join(home, "threads"), { recursive: true });
    await mkdir(path.join(home, "transcripts"), { recursive: true });

    const retired = [
      path.join(home, "DREAM.md"),
      path.join(home, "memories", "MEMORY.md"),
      path.join(home, "memories", "memory_map.md"),
      path.join(home, "memories", "memory_summary.md"),
    ];
    await Promise.all(
      retired.map((filePath) => writeFile(filePath, "retired artifact")),
    );
    const retained = new Map([
      [path.join(home, "core-memory.md"), "core memory"],
      [path.join(home, "memories", "profile.md"), "durable profile"],
      [path.join(home, "threads", "thread-42.json"), "thread result"],
      [path.join(home, "transcripts", "conv-7.jsonl"), "transcript"],
      [path.join(home, "memories", "thread-pointers.md"), "thread-42"],
      [path.join(home, "unrelated.txt"), "leave me alone"],
    ]);
    await Promise.all(
      [...retained].map(([filePath, content]) => writeFile(filePath, content)),
    );

    await retireAutomaticMemoryArtifacts(home);
    await retireAutomaticMemoryArtifacts(home);

    await Promise.all(
      retired.map((filePath) =>
        expect(readFile(filePath, "utf-8")).rejects.toThrow(),
      ),
    );
    await Promise.all(
      [...retained].map(([filePath, content]) =>
        expect(readFile(filePath, "utf-8")).resolves.toBe(content),
      ),
    );
  });
});
