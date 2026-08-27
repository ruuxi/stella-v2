import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { STELLA_PROMPT_DEFAULTS } from "../convex/stella_prompt_defaults.generated";
import {
  STELLA_PROMPT_COUNT,
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  deriveStellaPromptRevision,
  nextStellaPromptPublishedAt,
  readBoundedPromptPublishBody,
  validateStellaPromptInputs,
} from "../convex/stella_prompt_contract";
import {
  stellaPromptPublicationEtag,
  stellaPromptResponse,
} from "../convex/stella_prompts_http";
import {
  STELLA_PROMPT_IDS as RUNTIME_PROMPT_IDS,
  STELLA_PROMPT_SCHEMA_VERSION as RUNTIME_PROMPT_SCHEMA_VERSION,
} from "../../contracts/stella-prompts";
import { parseRemotePromptManifest } from "../../runtime/kernel/home/prompt-manifest-sync";
import {
  STELLA_PROMPT_SOURCE_ENTRIES,
  backendCloudPromptSourceRoot,
  buildStellaPromptDefaults,
  repositoryRoot,
  runtimePromptBody,
  runtimePromptSourceRoot,
} from "../scripts/stella-prompt-defaults";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const revisionFor = (
  prompts: readonly { id: string; sha256: string }[],
): string =>
  hash(
    [...prompts]
      .sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      )
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );

describe("Stella prompt defaults", () => {
  it("regenerates the checked-in module byte-for-byte without timestamps", async () => {
    const first = await buildStellaPromptDefaults();
    const second = await buildStellaPromptDefaults();
    const checkedIn = await readFile(
      path.join(
        import.meta.dirname,
        "..",
        "convex",
        "stella_prompt_defaults.generated.ts",
      ),
      "utf-8",
    );

    expect(second.source).toBe(first.source);
    expect(checkedIn).toBe(first.source);
    expect(first.snapshot.publishedAt).toBe(0);
    expect(
      first.snapshot.prompts.every((prompt) => prompt.updatedAt === 0),
    ).toBe(true);
    expect(first.source).not.toMatch(/generatedAt|Date\.now|new Date/);
  });

  it("keeps one exact current roster across sources and both contracts", async () => {
    const sourceIds = STELLA_PROMPT_SOURCE_ENTRIES.map(({ id }) => id).sort();
    const backendIds = [...STELLA_PROMPT_IDS].sort();
    const runtimeIds = [...RUNTIME_PROMPT_IDS].sort();
    const files = [
      ...(await readdir(path.join(runtimePromptSourceRoot, "agent-metadata")))
        .filter((name) => name.endsWith(".md") && name !== "README.md")
        .map((name) => `agents/${name}`),
      ...(await readdir(path.join(runtimePromptSourceRoot, "prompts")))
        .filter((name) => name.endsWith(".md"))
        .map((name) => `prompts/${name}`),
    ].sort();

    expect(sourceIds).toEqual(backendIds);
    expect(runtimeIds).toEqual(backendIds);
    expect(files).toEqual(backendIds);
    expect(STELLA_PROMPT_DEFAULTS.prompts.map(({ id }) => id)).toEqual(
      backendIds,
    );
    expect(backendIds).toHaveLength(STELLA_PROMPT_COUNT);

    for (const id of backendIds) {
      await expect(
        readFile(path.join(backendCloudPromptSourceRoot, id), "utf-8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }

    for (const retired of [
      "agents/orchestrator-orchestrated.md",
      "agents/manager.md",
      "agents/schedule.md",
      "agents/dream.md",
      "agents/install_update.md",
      "prompts/dream-scheduled.md",
      "prompts/chronicle-summarizer.md",
      "prompts/memory-review.md",
    ]) {
      expect(backendIds).not.toContain(retired);
    }
  });

  it("publishes the orchestrated-only prompt and strips capability frontmatter", () => {
    const orchestrator = STELLA_PROMPT_DEFAULTS.prompts.find(
      ({ id }) => id === "agents/orchestrator.md",
    )?.content;
    expect(orchestrator).toContain("user-facing coordinator");
    expect(orchestrator).toContain(
      "Execution happens through background agents",
    );
    expect(orchestrator).not.toContain(
      "Complete requests directly with your own tools",
    );
    expect(orchestrator).toContain(
      "Signed-in conversations, memory, Cloud Drive, and account settings are cloud-authoritative",
    );
    expect(orchestrator).toContain(
      "Local agents, local files, and device-runtime artifacts stay on the user's machine",
    );
    expect(orchestrator).not.toContain(
      "Stella doesn't keep their stuff on its servers",
    );

    for (const prompt of STELLA_PROMPT_DEFAULTS.prompts) {
      expect(prompt.content.startsWith("---\n")).toBe(false);
      expect(prompt.content).not.toContain("orchestrator-orchestrated");
      expect(prompt.content).not.toContain("node_repl");
    }
  });

  it("fails closed on malformed frontmatter and non-canonical body whitespace", () => {
    expect(() =>
      runtimePromptBody(
        "---\nname: Missing separator\n---\nBody\n",
        "agent-metadata",
        "agents/general.md",
      ),
    ).toThrow("one blank separator line");
    expect(() =>
      runtimePromptBody(
        "---\nname: Extra separator\n---\n\n\nBody\n",
        "agent-metadata",
        "agents/general.md",
      ),
    ).toThrow("no surrounding blank lines");
    expect(() =>
      runtimePromptBody(
        " Body with leading whitespace\n",
        "prompt",
        "prompts/thread-compaction.md",
      ),
    ).toThrow("no surrounding blank lines");
  });

  it("derives canonical bytes, hashes, and revision from runtime sources", async () => {
    expect(STELLA_PROMPT_DEFAULTS.prompts).toHaveLength(STELLA_PROMPT_COUNT);
    for (const prompt of STELLA_PROMPT_DEFAULTS.prompts) {
      const entry = STELLA_PROMPT_SOURCE_ENTRIES.find(
        ({ id }) => id === prompt.id,
      );
      expect(entry).toBeDefined();
      const raw = await readFile(
        path.join(repositoryRoot, entry!.runtimeSource.relativePath),
        "utf-8",
      );
      const exactRuntimeBody =
        entry!.runtimeSource.kind === "agent-metadata"
          ? raw.slice(raw.indexOf("\n---\n\n") + "\n---\n\n".length)
          : raw;
      const content = runtimePromptBody(
        raw,
        entry!.runtimeSource.kind,
        entry!.id,
      );
      expect(raw.indexOf("\n---\n\n") >= 0).toBe(
        entry!.runtimeSource.kind === "agent-metadata",
      );
      expect(content).toBe(exactRuntimeBody);
      expect(prompt.content).toBe(content);
      expect(prompt.sha256).toBe(hash(content));
      expect(prompt.sourceRevision).toBe("backend-default");
      expect(prompt.updatedAt).toBe(0);
    }
    expect(STELLA_PROMPT_DEFAULTS.revision).toBe(
      revisionFor(STELLA_PROMPT_DEFAULTS.prompts),
    );
  });

  it("validates the canonical set all-or-nothing", async () => {
    const prompts = STELLA_PROMPT_DEFAULTS.prompts.map(({ id, content }) => ({
      id,
      content,
    }));
    expect(validateStellaPromptInputs(prompts)).toEqual({ ok: true, prompts });
    expect(await deriveStellaPromptRevision(prompts)).toBe(
      STELLA_PROMPT_DEFAULTS.revision,
    );
    expect(validateStellaPromptInputs(prompts.slice(1)).ok).toBe(false);
    expect(
      validateStellaPromptInputs([...prompts.slice(0, -1), prompts[0]!]).ok,
    ).toBe(false);
    expect(
      validateStellaPromptInputs([
        ...prompts.slice(0, -1),
        { id: "agents/orchestrator-orchestrated.md", content: "retired" },
      ]).ok,
    ).toBe(false);
    expect(
      validateStellaPromptInputs([
        {
          ...prompts[0]!,
          content: "x".repeat(STELLA_PROMPT_MAX_CONTENT_BYTES + 1),
        },
        ...prompts.slice(1),
      ]).ok,
    ).toBe(false);
  });

  it("accepts only the exact current runtime manifest", () => {
    const manifest = {
      schemaVersion: RUNTIME_PROMPT_SCHEMA_VERSION,
      revision: STELLA_PROMPT_DEFAULTS.revision,
      publishedAt: 0,
      prompts: STELLA_PROMPT_DEFAULTS.prompts.map(
        ({ id, sha256, content }) => ({
          id,
          sha256,
          content,
        }),
      ),
    };
    expect(parseRemotePromptManifest(manifest)).toEqual(manifest);

    const retiredPrompt = {
      id: "agents/orchestrator-orchestrated.md",
      content: "retired direct prompt\n",
      sha256: hash("retired direct prompt\n"),
    };
    const stalePrompts = [...manifest.prompts, retiredPrompt];
    expect(
      parseRemotePromptManifest({
        ...manifest,
        revision: revisionFor(stalePrompts),
        prompts: stalePrompts,
      }),
    ).toBeNull();
  });

  it("bounds publish bodies and preserves publication identity", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024) },
      body: "{}",
    });
    await expect(readBoundedPromptPublishBody(request)).resolves.toEqual({
      ok: false,
      error: "Request body is too large.",
    });
    expect(nextStellaPromptPublishedAt([100, 100], 99)).toBe(101);

    const revision = "a".repeat(64);
    const oldEtag = stellaPromptPublicationEtag(10, revision);
    const currentEtag = stellaPromptPublicationEtag(20, revision);
    const response = stellaPromptResponse(
      new Request("https://example.test/api/stella/prompts", {
        headers: { "If-None-Match": oldEtag },
      }),
      {
        prompts: STELLA_PROMPT_DEFAULTS.prompts,
        revision,
        publishedAt: 20,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(currentEtag);
  });
});
