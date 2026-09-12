/**
 * Remote system prompts: the Convex publication is the source of truth for
 * agent and auxiliary prompt bodies; the bundle is the fallback. Covers the
 * conditional fetch (200 / 304 / failure), the disk cache that seeds a cold
 * start, and both consumers preferring the served body.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "@stella/contracts/stella-prompts";
import {
  configureRemotePrompts,
  getRemotePromptBody,
  getRemotePromptRevision,
  parseRemotePromptManifest,
  publicationEtag,
  remotePromptsReady,
  resetRemotePromptsForTests,
  revalidateRemotePrompts,
} from "@stella/runtime/kernel/prompts/remote-prompts";
import { loadAgentSystemPrompt } from "@stella/runtime/kernel/agents/home-agent-prompt";
import { readRuntimePrompt } from "@stella/runtime/kernel/prompts/home-prompts";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const buildManifest = (
  overrides: Partial<Record<(typeof STELLA_PROMPT_IDS)[number], string>> = {},
  publishedAt = 1_000,
) => {
  const prompts = STELLA_PROMPT_IDS.map((id) => {
    const content = overrides[id] ?? `served body for ${id}`;
    return { id, content, sha256: sha256(content) };
  });
  const revision = sha256(
    [...prompts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );
  return {
    schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
    revision,
    publishedAt,
    prompts,
  };
};

const roots = new Set<string>();
const tempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stella-remote-prompts-"));
  roots.add(dir);
  return dir;
};

type FetchCall = { url: string; ifNoneMatch: string | null };

const fakeFetch = (
  handler: (call: FetchCall) => Response | Promise<Response>,
  calls: FetchCall[] = [],
) => {
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      ifNoneMatch: headers.get("if-none-match"),
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
};

beforeEach(() => {
  resetRemotePromptsForTests();
});

afterEach(async () => {
  resetRemotePromptsForTests();
  delete process.env.STELLA_AGENT_METADATA_DIR;
  delete process.env.STELLA_RUNTIME_PROMPTS_DIR;
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("remote prompts", () => {
  it("adopts a valid publication and revalidates with If-None-Match", async () => {
    const dataDir = await tempDir();
    const manifest = buildManifest();
    let status = 200;
    const { impl, calls } = fakeFetch(() =>
      status === 304
        ? new Response(null, { status: 304 })
        : Response.json(manifest),
    );
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://site.example",
      fetchImpl: impl,
    });
    expect(getRemotePromptBody("agents/orchestrator.md")).toBeUndefined();
    expect(await revalidateRemotePrompts()).toBe("fresh");
    expect(calls[0]?.url).toBe("https://site.example/api/stella/prompts");
    expect(calls[0]?.ifNoneMatch).toBeNull();
    expect(getRemotePromptBody("agents/orchestrator.md")).toBe(
      "served body for agents/orchestrator.md",
    );
    expect(getRemotePromptRevision()).toBe(manifest.revision);

    status = 304;
    resetRemotePromptsForTests();
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://site.example",
      fetchImpl: impl,
    });
    await remotePromptsReady();
    // The disk cache seeds the cold start before any network round trip.
    expect(getRemotePromptBody("prompts/personality.md")).toBe(
      "served body for prompts/personality.md",
    );
    expect(await revalidateRemotePrompts()).toBe("not-modified");
    expect(calls[1]?.ifNoneMatch).toBe(publicationEtag(manifest));
    const cached = JSON.parse(
      await readFile(
        path.join(dataDir, "cache", "prompt-manifest.json"),
        "utf-8",
      ),
    ) as { endpoint: string; manifest: unknown };
    expect(cached.endpoint).toBe("https://site.example/api/stella/prompts");
    expect(parseRemotePromptManifest(cached.manifest)?.revision).toBe(
      manifest.revision,
    );
  });

  it("keeps the current bodies when the backend fails or serves junk", async () => {
    const dataDir = await tempDir();
    const good = buildManifest({ "agents/general.md": "first" });
    let mode: "good" | "broken" | "junk" = "good";
    const { impl } = fakeFetch(() => {
      if (mode === "broken") throw new Error("offline");
      if (mode === "junk") return Response.json({ nope: true });
      return Response.json(good);
    });
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://site.example",
      fetchImpl: impl,
    });
    expect(await revalidateRemotePrompts()).toBe("fresh");
    resetRemotePromptsForTests();
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://site.example",
      fetchImpl: impl,
    });
    await remotePromptsReady();
    mode = "broken";
    expect(await revalidateRemotePrompts()).toBe("unavailable");
    expect(getRemotePromptBody("agents/general.md")).toBe("first");
    resetRemotePromptsForTests();
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://site.example",
      fetchImpl: impl,
    });
    await remotePromptsReady();
    mode = "junk";
    expect(await revalidateRemotePrompts()).toBe("unavailable");
    expect(getRemotePromptBody("agents/general.md")).toBe("first");
  });

  it("does nothing without a site URL and ignores a cache from another backend", async () => {
    const dataDir = await tempDir();
    const { impl, calls } = fakeFetch(() => Response.json(buildManifest()));
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://one.example",
      fetchImpl: impl,
    });
    expect(await revalidateRemotePrompts()).toBe("fresh");
    resetRemotePromptsForTests();
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://two.example",
      fetchImpl: impl,
    });
    await remotePromptsReady();
    expect(getRemotePromptBody("agents/orchestrator.md")).toBeUndefined();
    resetRemotePromptsForTests();
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => null,
      fetchImpl: impl,
    });
    expect(await revalidateRemotePrompts()).toBe("unconfigured");
    expect(calls).toHaveLength(1);
  });

  it("agent and auxiliary prompt readers prefer the served body over the bundle", async () => {
    const dataDir = await tempDir();
    const metadataDir = path.join(await tempDir(), "agent-metadata");
    const promptsDir = path.join(await tempDir(), "prompts");
    await mkdir(metadataDir, { recursive: true });
    await mkdir(promptsDir, { recursive: true });
    await writeFile(
      path.join(metadataDir, "orchestrator.md"),
      "---\nname: Orchestrator\ntools: web\n---\nbundled orchestrator body\n",
      "utf-8",
    );
    await writeFile(
      path.join(promptsDir, "thread-compaction.md"),
      "bundled compaction\n",
      "utf-8",
    );
    process.env.STELLA_AGENT_METADATA_DIR = metadataDir;
    process.env.STELLA_RUNTIME_PROMPTS_DIR = promptsDir;

    expect(await loadAgentSystemPrompt("orchestrator", dataDir)).toBe(
      "bundled orchestrator body",
    );
    expect(readRuntimePrompt("thread-compaction")).toBe("bundled compaction");

    const { impl } = fakeFetch(() =>
      Response.json(
        buildManifest({
          "agents/orchestrator.md": "served orchestrator body",
          "prompts/thread-compaction.md": "served compaction",
        }),
      ),
    );
    configureRemotePrompts({
      stellaDataDir: dataDir,
      getSiteUrl: () => "https://site.example",
      fetchImpl: impl,
    });
    expect(await revalidateRemotePrompts()).toBe("fresh");
    expect(await loadAgentSystemPrompt("orchestrator", dataDir)).toBe(
      "served orchestrator body",
    );
    expect(readRuntimePrompt("thread-compaction")).toBe("served compaction");
    expect(readRuntimePrompt("fallback-subagent")).toBe(
      "served body for prompts/fallback-subagent.md",
    );
  });
});
