import { describe, expect, test } from "bun:test";
import type { CloudSkillCatalogSnapshot } from "../src/cloud-home-store.js";
import {
  CLOUD_SKILL_SANDBOX_ROOT,
  materializeCloudSkillSnapshot,
} from "../src/cloud-skill-materializer.js";

const snapshot = (path = "SKILL.md"): CloudSkillCatalogSnapshot => ({
  ownerGeneration: "generation-1",
  agentType: "general",
  loadedAt: 123,
  entries: [
    {
      skillId: "skill/calendar",
      slug: "calendar",
      name: "Calendar",
      description: "Use the calendar",
      source: "desktop_sync",
      availability: "both",
      revision: 4,
      versionId: "version/4",
      manifestSha256: "1".repeat(64),
      treeSha256: "2".repeat(64),
      fileCount: 2,
      totalSizeBytes: 8,
      files: [
        {
          path,
          r2Key: "agent-home/private/never-export-this",
          sha256: "3".repeat(64),
          sizeBytes: 5,
          contentType: "text/markdown",
        },
        {
          path: "assets/icon.bin",
          r2Key: "agent-home/private/never-export-this-either",
          sha256: "4".repeat(64),
          sizeBytes: 3,
          contentType: "application/octet-stream",
        },
      ],
      updatedAt: 100,
    },
  ],
});

describe("cloud skill sandbox materialization", () => {
  test("writes exact pinned bytes under an ephemeral version root", async () => {
    const writes = new Map<string, Uint8Array>();
    const reads: string[] = [];
    const materialized = await materializeCloudSkillSnapshot({
      snapshot: snapshot(),
      home: {
        async readSkillFile(_snapshot, _skillId, path) {
          reads.push(path);
          return path === "SKILL.md"
            ? new TextEncoder().encode("skill")
            : new Uint8Array([0, 1, 2]);
        },
      },
      session: {
        async mkdir() {},
        async writeFile(path, content, options) {
          expect(options).toEqual({ encoding: "base64" });
          writes.set(
            path,
            Uint8Array.from(atob(content), (char) => char.charCodeAt(0)),
          );
          return { success: true };
        },
      },
      assertActive: () => undefined,
    });

    expect(reads).toEqual(["SKILL.md", "assets/icon.bin"]);
    expect(materialized.entries[0]!.root).toStartWith(
      `${CLOUD_SKILL_SANDBOX_ROOT}/skill-`,
    );
    expect(materialized.entries[0]!.root).toContain("/version-");
    expect(
      new TextDecoder().decode(
        writes.get(`${materialized.entries[0]!.root}/SKILL.md`),
      ),
    ).toBe("skill");
    expect(
      writes.get(`${materialized.entries[0]!.root}/assets/icon.bin`),
    ).toEqual(new Uint8Array([0, 1, 2]));
    expect(JSON.stringify(materialized)).not.toContain("agent-home/private");
  });

  test("rejects a traversal before any object read or sandbox write", async () => {
    let reads = 0;
    let writes = 0;
    await expect(
      materializeCloudSkillSnapshot({
        snapshot: snapshot("../../secret"),
        home: {
          async readSkillFile() {
            reads += 1;
            return new Uint8Array();
          },
        },
        session: {
          async mkdir() {},
          async writeFile() {
            writes += 1;
            return { success: true };
          },
        },
        assertActive: () => undefined,
      }),
    ).rejects.toThrow("unsafe file path");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  test("does not admit a sandbox write after Stop lands during an object read", async () => {
    let releaseRead!: () => void;
    let observeRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      observeRead = resolve;
    });
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let active = true;
    let writes = 0;
    const materialization = materializeCloudSkillSnapshot({
      snapshot: snapshot(),
      home: {
        async readSkillFile(_snapshot, _skillId, path) {
          observeRead();
          await readGate;
          return path === "SKILL.md"
            ? new TextEncoder().encode("skill")
            : new Uint8Array([0, 1, 2]);
        },
      },
      session: {
        async mkdir() {},
        async writeFile() {
          writes += 1;
          return { success: true };
        },
      },
      assertActive: () => {
        if (!active) throw new Error("stopped");
      },
    });

    await readStarted;
    active = false;
    releaseRead();

    await expect(materialization).rejects.toThrow("stopped");
    expect(writes).toBe(0);
  });
});
