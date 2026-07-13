import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";

import { STELLA_PROMPT_DEFAULTS } from "../convex/stella_prompt_defaults.generated";
import {
  stellaPromptPublicationEtag,
  stellaPromptResponse,
} from "../convex/stella_prompts_http";
import {
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_COUNT,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  deriveStellaPromptRevision,
  nextStellaPromptPublishedAt,
  readBoundedPromptPublishBody,
  validateStellaPromptInputs,
} from "../convex/stella_prompt_contract";

describe("Stella prompt defaults", () => {
  it("matches every canonical markdown file byte-for-byte", async () => {
    expect(STELLA_PROMPT_DEFAULTS.prompts).toHaveLength(STELLA_PROMPT_COUNT);
    expect(STELLA_PROMPT_DEFAULTS.prompts.map((prompt) => prompt.id)).toEqual(
      [...STELLA_PROMPT_IDS].sort((a, b) => a.localeCompare(b)),
    );
    expect(STELLA_PROMPT_DEFAULTS.publishedAt).toBe(0);
    for (const prompt of STELLA_PROMPT_DEFAULTS.prompts) {
      const content = await readFile(
        path.join(
          import.meta.dirname,
          "..",
          "prompts",
          "stella-runtime",
          prompt.id,
        ),
        "utf-8",
      );
      const sha256 = createHash("sha256").update(content).digest("hex");
      expect(content).toBe(prompt.content);
      expect(sha256).toBe(prompt.sha256);
    }
    const expectedRevision = createHash("sha256")
      .update(
        STELLA_PROMPT_DEFAULTS.prompts
          .map((prompt) => `${prompt.id}:${prompt.sha256}`)
          .join("\n"),
      )
      .digest("hex");
    expect(STELLA_PROMPT_DEFAULTS.revision).toBe(expectedRevision);
  });

  it("keeps agent prompts backend-owned and free of capability-bearing frontmatter", async () => {
    for (const prompt of STELLA_PROMPT_DEFAULTS.prompts.filter((value) =>
      value.id.startsWith("agents/"),
    )) {
      expect(prompt.content.startsWith("---\n")).toBe(false);
      const source = await readFile(
        path.join(
          import.meta.dirname,
          "..",
          "prompts",
          "stella-runtime",
          prompt.id,
        ),
        "utf-8",
      );
      expect(source.startsWith("---\n")).toBe(false);
      expect(prompt.content).toBe(source);
    }
  });

  it("preserves the orchestrator's prompt ownership, access, and briefing invariants", () => {
    const orchestrator = STELLA_PROMPT_DEFAULTS.prompts.find(
      (prompt) => prompt.id === "agents/orchestrator.md",
    )?.content;
    expect(orchestrator).toBeDefined();

    const selfImprovement = orchestrator!.match(
      /# Self Improvement\n([\s\S]*?)\n# Setup and access/,
    )?.[1];
    expect(selfImprovement).toContain("~/.stella/");
    expect(selfImprovement).toContain("personal customizations");
    expect(selfImprovement).toContain("stella-backend/prompts/stella-runtime/");
    expect(selfImprovement).toMatch(/canonical source.*system-prompt bodies/);
    expect(selfImprovement).toMatch(/runtime\/extensions.*metadata/);

    const setup = orchestrator!.match(
      /# Setup and access\n([\s\S]*?)\n# Agent Prompts/,
    )?.[1];
    expect(setup).toMatch(/credentials, 2FA, consent, or judgment/);
    expect(setup).toContain("connector_status");
    expect(setup).toMatch(/without asking first/);
    expect(setup).toMatch(/optional, never a precondition/);
    expect(setup).toMatch(/cost.*explicit approval/s);

    const agentPrompts = orchestrator!.match(
      /# Agent Prompts\n([\s\S]*?)\n# Tools/,
    )?.[1];
    expect(agentPrompts).toMatch(/Per-spawn selection affects only that agent/);
    expect(agentPrompts).toMatch(/saved Claude Code.*full run pipeline/);
    expect(agentPrompts).toContain("Enrich the WHAT; never invent the HOW");
    expect(agentPrompts).toMatch(/intensity, scope, tone, exact overrides/);
    expect(agentPrompts).toContain("Vite + React");
  });

  it("teaches the Manager to understand natural-language status requests", () => {
    const manager = STELLA_PROMPT_DEFAULTS.prompts.find(
      (prompt) => prompt.id === "agents/manager.md",
    )?.content;
    expect(manager).toBeDefined();
    expect(manager).toContain("[Status]");
    expect(manager).toMatch(
      /incoming message asks for status or an update while the process is unfinished/,
    );
    expect(manager).toMatch(/briefly give current progress and blockers/s);
    expect(manager).toMatch(/yield without abandoning or completing/s);
    expect(manager).toMatch(/change instructions as steering.*apply/s);
    expect(manager).toContain("[Milestone]");
    expect(manager).toMatch(/sentinels are conditional.*do not emit either/s);
  });

  it("validates the publish set all-or-nothing and derives its revision", async () => {
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
        { id: "prompts/unexpected.md", content: "no" },
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

  it("rejects an oversized publish request before parsing JSON", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024) },
      body: "{}",
    });
    await expect(readBoundedPromptPublishBody(request)).resolves.toEqual({
      ok: false,
      error: "Request body is too large.",
    });
  });

  it("issues a monotonic publication time even when the server clock does not advance", () => {
    expect(nextStellaPromptPublishedAt([100, 100], 99)).toBe(101);
    expect(nextStellaPromptPublishedAt([], 200)).toBe(200);
  });

  it("uses the complete publication identity for A/B/A conditional requests", () => {
    const revisionA = "a".repeat(64);
    const oldA = stellaPromptPublicationEtag(10, revisionA);
    const currentA = stellaPromptPublicationEtag(20, revisionA);
    expect(oldA).not.toBe(currentA);

    const response = stellaPromptResponse(
      new Request("https://example.test/api/stella/prompts", {
        headers: { "If-None-Match": oldA },
      }),
      {
        prompts: STELLA_PROMPT_DEFAULTS.prompts,
        revision: revisionA,
        publishedAt: 20,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(currentA);

    const unchanged = stellaPromptResponse(
      new Request("https://example.test/api/stella/prompts", {
        headers: { "If-None-Match": currentA },
      }),
      {
        prompts: STELLA_PROMPT_DEFAULTS.prompts,
        revision: revisionA,
        publishedAt: 20,
      },
    );
    expect(unchanged.status).toBe(304);
  });
});
