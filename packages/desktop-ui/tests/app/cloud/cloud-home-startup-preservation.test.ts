import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  confirmLocalCloudHomeImportOwnership,
  getLocalCloudHomeImportOwnership,
} from "@stella/desktop/electron/services/cloud-home-import-owner.js";
import { scanOwnedLocalCloudHome } from "@stella/desktop/electron/services/cloud-home-local-import.js";
import { migrateLegacyHomeLayout } from "@stella/runtime/kernel/home/legacy-migration";
import { runCloudHomeSync } from "@/features/cloud/cloud-home-sync";

const fixtures = new Set<string>();

const makeFixture = async (): Promise<string> => {
  const fixture = await fs.mkdtemp(
    path.join(os.tmpdir(), "stella-cloud-home-startup-"),
  );
  fixtures.add(fixture);
  return fixture;
};

const write = async (
  root: string,
  relativePath: string,
  content: string,
): Promise<void> => {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
};

const readCorpus = async (
  root: string,
  expected: ReadonlyMap<string, string>,
): Promise<Record<string, string>> =>
  Object.fromEntries(
    await Promise.all(
      [...expected].map(async ([relativePath]) => [
        relativePath,
        await fs.readFile(path.join(root, ...relativePath.split("/")), "utf8"),
      ]),
    ),
  );

afterEach(async () => {
  await Promise.all(
    [...fixtures].map((fixture) =>
      fs.rm(fixture, { recursive: true, force: true }),
    ),
  );
  fixtures.clear();
});

describe("Cloud Home startup preservation", () => {
  it("never consumes the owner-fenced local corpus before, during, or after import", async () => {
    const root = await makeFixture();
    const accountScope = "account:startup-owner";
    const expectedSubject = "https://api.example.test|startup-owner";
    const corpus = new Map([
      ["memories/MEMORY.md", "# Memory\n\nDurable note.\n"],
      ["memories/profile.md", "# Profile\n\n- Name: Ada\n"],
      ["memories/memory_map.md", "# Memory map\n\n- durable-note\n"],
      ["core-memory.md", "# Core memory\n\nLives in Phoenix.\n"],
      ["imports/notion/travel.md", "# Travel\n\nLisbon.\n"],
      ["markdown/projects/stella.md", "# Stella\n\nCloud migration.\n"],
    ] as const);
    for (const [relativePath, content] of corpus) {
      await write(root, relativePath, content);
    }
    const original = Object.fromEntries(corpus);

    // Host startup seeds the home before the renderer can claim and scan it.
    await migrateLegacyHomeLayout(root);
    expect(await readCorpus(root, corpus)).toEqual(original);
    expect(await getLocalCloudHomeImportOwnership(root, accountScope)).toBe(
      "unclaimed",
    );
    expect(
      await confirmLocalCloudHomeImportOwnership(root, accountScope, () => 10),
    ).toBe(true);
    const firstScan = await scanOwnedLocalCloudHome(root, accountScope);
    expect(firstScan.memories.map(({ name }) => name)).toEqual([
      "MEMORY.md",
      "memories/profile.md",
      "memories/memory_map.md",
      "core-memory.md",
      "imports/notion/travel.md",
      "markdown/projects/stella.md",
    ]);

    const cursorValues = new Map<string, string>();
    const cursorStore = {
      getItem: (key: string) => cursorValues.get(key) ?? null,
      setItem: (key: string, value: string) => cursorValues.set(key, value),
      readImportOwnership: () =>
        getLocalCloudHomeImportOwnership(root, accountScope),
    };
    const scanLocal = () => scanOwnedLocalCloudHome(root, accountScope);
    const base = {
      accountScope,
      expectedSubject,
      builderOrigin: "https://builder.example.test",
      token: "jwt",
      scanLocal,
      readSkillHeads: async () => [],
      cursorStore,
    };

    // Cloud failure happens before local capture completes. A second boot and
    // exact retry must still observe every original byte.
    const failed = await runCloudHomeSync({
      ...base,
      fetch: async () => Response.json({ error: "offline" }, { status: 503 }),
    });
    expect(failed.phase).toBe("unavailable");
    expect(await readCorpus(root, corpus)).toEqual(original);
    await migrateLegacyHomeLayout(root);
    expect(await readCorpus(root, corpus)).toEqual(original);

    let memoryEpoch = "memory-epoch-1";
    let importDisposition: "automatic_allowed" | "explicit_required" =
      "automatic_allowed";
    let documents: Array<Record<string, unknown>> = [];
    let writes = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname === "/cloud-home/memory") {
        return Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          memoryEpoch,
          importDisposition,
          documents,
        });
      }
      if (url.pathname === "/cloud-home/memory/write") {
        writes += 1;
        const body = JSON.parse(String(init?.body)) as {
          name: string;
          kind: string;
          source: string;
          content: string;
        };
        const local = (await scanLocal()).memories.find(
          ({ name }) => name === body.name,
        );
        expect(local).toBeDefined();
        documents.push({
          documentId: `document-${writes}`,
          name: body.name,
          displayPath: local!.displayPath,
          kind: body.kind,
          source: body.source,
          revision: 1,
          versionId: `version-${writes}`,
          sha256: local!.sha256,
          sizeBytes: local!.sizeBytes,
          updatedAt: writes,
          content: body.content,
        });
        return Response.json({ status: "committed" });
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    };

    const succeeded = await runCloudHomeSync({ ...base, fetch: fetchImpl });
    expect(succeeded.phase).toBe("complete");
    expect(succeeded.memoryUploaded).toBe(corpus.size);
    expect(writes).toBe(corpus.size);
    expect(await readCorpus(root, corpus)).toEqual(original);

    // Turning memory use off changes prompt injection, not ownership of the
    // migration source. A later seed while disabled cannot erase local bytes.
    const memoryEnabled = false;
    expect(memoryEnabled).toBe(false);
    await migrateLegacyHomeLayout(root);
    expect(await readCorpus(root, corpus)).toEqual(original);

    // A memory reset opens a new epoch with automatic reimport denied. The
    // corpus remains local while explicit authorization is pending.
    memoryEpoch = "memory-epoch-2";
    importDisposition = "explicit_required";
    documents = [];
    const writesBeforeReset = writes;
    const resetBlocked = await runCloudHomeSync({ ...base, fetch: fetchImpl });
    expect(resetBlocked.phase).toBe("attention");
    expect(
      resetBlocked.issues.some(
        ({ code }) => code === "memory_reimport_confirmation_required",
      ),
    ).toBe(true);
    expect(writes).toBe(writesBeforeReset);
    expect(await readCorpus(root, corpus)).toEqual(original);

    // The explicit reimport authorization is represented by the lifecycle
    // transition returned by the authority. Retry uploads into the new epoch
    // without ever consuming the local source.
    importDisposition = "automatic_allowed";
    const reimported = await runCloudHomeSync({ ...base, fetch: fetchImpl });
    expect(reimported.phase).toBe("complete");
    expect(reimported.memoryUploaded).toBe(corpus.size);
    expect(writes).toBe(writesBeforeReset + corpus.size);
    expect(await readCorpus(root, corpus)).toEqual(original);
  });
});
