import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_LEGACY_IDS,
} from "@stella/contracts/stella-prompts";
import {
  parseRemotePromptManifest,
  resolvePromptManifest,
  type RemotePromptManifest,
} from "@stella/runtime/kernel/home/prompt-manifest-sync";

const roots = new Set<string>();

const tempDir = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-manifest-"));
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

const manifestForIds = (
  ids: readonly string[],
  publishedAt: number,
  overrides: Record<string, string> = {},
): RemotePromptManifest => {
  const prompts = ids.map((id) => {
    const content = overrides[id] ?? `default body for ${id}\n`;
    return { id, content, sha256: hash(content) };
  });
  const revision = hash(
    [...prompts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );
  return { schemaVersion: 2, revision, publishedAt, prompts };
};

const manifest = (
  publishedAt: number,
  overrides: Record<string, string> = {},
): RemotePromptManifest =>
  manifestForIds(STELLA_PROMPT_IDS, publishedAt, overrides);

const writeSystemRevision = async (
  home: string,
  revision: string,
  publishedAt: number,
) => {
  await mkdir(path.join(home, "system"), { recursive: true });
  await writeFile(
    path.join(home, "system", "revision.json"),
    JSON.stringify({
      version: 1,
      key: `test-${publishedAt}`,
      revision,
      publishedAt,
      mirroredAt: 0,
    }),
  );
};

const okResponse = (value: RemotePromptManifest) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { ETag: `"${value.publishedAt}-${value.revision}"` },
  });

describe("parseRemotePromptManifest", () => {
  it("accepts a canonical manifest idempotently", () => {
    const valid = manifest(1);
    expect(parseRemotePromptManifest(valid)).toEqual(valid);
    expect(parseRemotePromptManifest(parseRemotePromptManifest(valid))).toEqual(
      valid,
    );
  });

  it("tolerates unknown ids from a different backend version", () => {
    const withExtra = manifestForIds(
      [...STELLA_PROMPT_IDS, "agents/some_future_agent.md", "prompts/retired-thing.md"],
      1,
    );
    expect(parseRemotePromptManifest(withExtra)).toEqual(withExtra);
  });

  it("rejects a missing canonical entry, a bad hash, and a bad revision", () => {
    const valid = manifest(1);
    const missingLegacy = manifestForIds(
      STELLA_PROMPT_IDS.filter((id) => id !== STELLA_PROMPT_LEGACY_IDS[0]),
      1,
    );
    expect(parseRemotePromptManifest(missingLegacy)).toBeNull();
    expect(
      parseRemotePromptManifest({
        ...valid,
        prompts: valid.prompts.map((prompt, index) =>
          index === 0 ? { ...prompt, sha256: "0".repeat(64) } : prompt,
        ),
      }),
    ).toBeNull();
    expect(
      parseRemotePromptManifest({ ...valid, revision: "0".repeat(64) }),
    ).toBeNull();
  });
});

describe("resolvePromptManifest", () => {
  it("fetches fresh, persists the cache, and serves 304 from it", async () => {
    const home = await tempDir();
    const remote = manifest(1);
    const fresh = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => okResponse(remote),
    });
    expect(fresh).toEqual({
      source: "fresh-remote",
      manifest: remote,
      endpoint: "https://example.test/api/stella/prompts",
    });
    await expect(
      readFile(path.join(home, "cache", "prompt-manifest.json"), "utf-8"),
    ).resolves.toContain(remote.revision);

    const notModified = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async (_url, init) => {
        expect(
          new Headers(init?.headers as HeadersInit).get("If-None-Match"),
        ).toBe(`"1-${remote.revision}"`);
        return new Response(null, { status: 304 });
      },
    });
    expect(notModified.source).toBe("fresh-remote");
    expect(notModified.manifest).toEqual(remote);
  });

  it("falls back to the cache when the network fails", async () => {
    const home = await tempDir();
    const remote = manifest(1);
    await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => okResponse(remote),
    });
    const offline = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(offline.source).toBe("cached-remote");
    expect(offline.manifest).toEqual(remote);
  });

  it("refuses a rollback older than the applied system revision", async () => {
    const home = await tempDir();
    const current = manifest(5);
    await writeSystemRevision(home, current.revision, 5);

    const older = manifest(3);
    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => okResponse(older),
    });
    expect(result.source).toBe("unavailable");
    expect(result.manifest).toBeNull();
  });

  it("never lets an offline-seeded system revision block a real publication", async () => {
    const home = await tempDir();
    await writeSystemRevision(home, "offline", 0);
    const remote = manifest(1);
    const result = await resolvePromptManifest({
      stellaDataDir: home,
      siteUrl: "https://example.test",
      fetchImpl: async () => okResponse(remote),
    });
    expect(result.source).toBe("fresh-remote");
  });

  it("reports unavailable with no endpoint and no cache", async () => {
    const home = await tempDir();
    const result = await resolvePromptManifest({ stellaDataDir: home });
    expect(result).toEqual({ source: "unavailable", manifest: null });
  });
});
