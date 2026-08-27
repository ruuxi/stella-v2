import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  scanLocalCloudHome,
  scanOwnedLocalCloudHome,
} from "@stella/desktop/electron/services/cloud-home-local-import.js";
import {
  confirmLocalCloudHomeImportOwnership,
  getLocalCloudHomeImportOwnership,
} from "@stella/desktop/electron/services/cloud-home-import-owner.js";

const fixtures: string[] = [];

const makeFixture = async (): Promise<string> => {
  const fixture = await fs.mkdtemp(
    path.join(os.tmpdir(), "stella-cloud-home-import-"),
  );
  fixtures.push(fixture);
  return fixture;
};

const write = async (
  root: string,
  relative: string,
  content: string | Uint8Array,
) => {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
};

const directoryHash = (files: Array<[string, string]>): string => {
  const hash = createHash("sha256");
  for (const [relative, content] of [...files].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
};

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((fixture) => fs.rm(fixture, { recursive: true, force: true })),
  );
});

describe("Cloud Home local importer", () => {
  it("durably binds one fixture corpus to its first confirmed account", async () => {
    const root = await makeFixture();
    await write(root, "memories/profile.md", "# Profile\n");
    await expect(
      scanOwnedLocalCloudHome(root, "account:first-owner"),
    ).rejects.toThrow("not owned");
    expect(
      await getLocalCloudHomeImportOwnership(root, "account:first-owner"),
    ).toBe("unclaimed");
    expect(
      await confirmLocalCloudHomeImportOwnership(
        root,
        "account:first-owner",
        () => 10,
      ),
    ).toBe(true);

    // Re-opening the service models restart and sign-out/sign-in. Only the
    // digest persists; a second account cannot silently claim the same corpus.
    expect(
      await getLocalCloudHomeImportOwnership(root, "account:first-owner"),
    ).toBe("owned");
    expect(
      (await scanOwnedLocalCloudHome(root, "account:first-owner")).memories.map(
        (document) => document.name,
      ),
    ).toEqual(["memories/profile.md"]);
    expect(
      await confirmLocalCloudHomeImportOwnership(root, "account:first-owner"),
    ).toBe(true);
    expect(
      await getLocalCloudHomeImportOwnership(root, "account:second-owner"),
    ).toBe("other_owner");
    await expect(
      scanOwnedLocalCloudHome(root, "account:second-owner"),
    ).rejects.toThrow("not owned");
    expect(
      await confirmLocalCloudHomeImportOwnership(root, "account:second-owner"),
    ).toBe(false);

    const marker = await fs.readFile(
      path.join(root, ".cloud-home-import-owner.json"),
      "utf8",
    );
    expect(marker).not.toContain("first-owner");
    expect(marker).not.toContain("second-owner");
  });

  it("allows only one winner when two accounts confirm concurrently", async () => {
    const root = await makeFixture();
    const results = await Promise.all([
      confirmLocalCloudHomeImportOwnership(root, "account:one"),
      confirmLocalCloudHomeImportOwnership(root, "account:two"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const states = await Promise.all([
      getLocalCloudHomeImportOwnership(root, "account:one"),
      getLocalCloudHomeImportOwnership(root, "account:two"),
    ]);
    expect(states.sort()).toEqual(["other_owner", "owned"]);
  });

  it("fails closed instead of replacing a corrupt durable owner marker", async () => {
    const root = await makeFixture();
    await write(root, ".cloud-home-import-owner.json", "not-json");
    expect(
      await getLocalCloudHomeImportOwnership(root, "account:first-owner"),
    ).toBe("corrupt");
    expect(
      await confirmLocalCloudHomeImportOwnership(root, "account:first-owner"),
    ).toBe(false);
    expect(
      await fs.readFile(
        path.join(root, ".cloud-home-import-owner.json"),
        "utf8",
      ),
    ).toBe("not-json");
  });

  it("scans a real temporary Stella fixture deterministically without exposing its root", async () => {
    const root = await makeFixture();
    await write(root, "memories/MEMORY.md", "# Memory\n\nDurable note.\n");
    await write(root, "memories/profile.md", "# User Profile\n\n- Name: Ada\n");
    await write(root, "core-memory.md", "Local context\n");
    await write(root, "imports/notion/travel.md", "# Travel\n\nLisbon\n");
    await write(root, "markdown/projects/stella.md", "# Stella\n");
    await write(
      root,
      "skills/custom-research/SKILL.md",
      "---\nname: Custom research\ndescription: Research with the user's saved process.\n---\n\nUse primary sources.\n",
    );
    await write(
      root,
      "skills/custom-research/references/checklist.txt",
      "Verify dates.\n",
    );

    const first = await scanLocalCloudHome(root);
    const second = await scanLocalCloudHome(root);

    expect(second).toEqual(first);
    expect(first.memories.map((document) => document.name)).toEqual([
      "MEMORY.md",
      "memories/profile.md",
      "core-memory.md",
      "imports/notion/travel.md",
      "markdown/projects/stella.md",
    ]);
    expect(
      first.memories.every((document) =>
        /^[0-9a-f]{64}$/.test(document.sha256),
      ),
    ).toBe(true);
    expect(first.skills).toHaveLength(1);
    expect(first.skills[0]).toMatchObject({
      slug: "custom-research",
      name: "Custom research",
      availability: "both",
      fileCount: 2,
    });
    expect(first.skills[0]?.files.map((file) => file.path)).toEqual([
      "references/checklist.txt",
      "SKILL.md",
    ]);
    expect(first.skills[0]?.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(first)).not.toContain(root);
  });

  it("skips untouched bundled skills but uploads a locally diverged package", async () => {
    const root = await makeFixture();
    const pristine =
      "---\nname: Bundled\ndescription: Shipped package.\n---\n\nShipped.\n";
    const customized =
      "---\nname: Customized\ndescription: Locally changed package.\n---\n\nChanged.\n";
    await write(root, "skills/pristine/SKILL.md", pristine);
    await write(root, "skills/customized/SKILL.md", customized);
    await write(
      root,
      "skills/.bundled-manifest.json",
      `${JSON.stringify({
        version: 2,
        entries: {
          pristine: {
            lastSyncedHash: directoryHash([["SKILL.md", pristine]]),
            sourceRevision: "test",
            customized: false,
          },
          customized: {
            lastSyncedHash: "0".repeat(64),
            sourceRevision: "test",
            customized: false,
          },
        },
      })}\n`,
    );

    const scan = await scanLocalCloudHome(root);
    expect(scan.skills.map((skill) => skill.slug)).toEqual(["customized"]);
  });

  it("rejects symbolic links and hard links without reading outside the fixture", async () => {
    const root = await makeFixture();
    const outside = await makeFixture();
    await write(outside, "secret.md", "outside secret");
    await fs.mkdir(path.join(root, "imports", "outside"), { recursive: true });
    await fs.symlink(
      path.join(outside, "secret.md"),
      path.join(root, "imports", "outside", "secret.md"),
    );
    await write(root, "memories/profile-source.md", "hard-linked profile");
    await fs.mkdir(path.join(root, "memories"), { recursive: true });
    await fs.link(
      path.join(root, "memories", "profile-source.md"),
      path.join(root, "memories", "profile.md"),
    );

    const scan = await scanLocalCloudHome(root);
    expect(scan.memories).toEqual([]);
    expect(
      scan.warnings.some((warning) => warning.code === "unsafe_file"),
    ).toBe(true);
    expect(JSON.stringify(scan)).not.toContain("outside secret");
    expect(JSON.stringify(scan)).not.toContain(root);
    expect(JSON.stringify(scan)).not.toContain(outside);
  });
});
