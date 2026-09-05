import { afterEach, describe, expect, test } from "bun:test";
import {
  STELLA_PROMPT_IDS as PROMPT_IDS,
  STELLA_PROMPT_SCHEMA_VERSION,
} from "@stella/contracts/stella-prompts";

import {
  CanonicalPromptUnavailableError,
  buildCloudSystemPrompt,
  refreshCanonicalPrompts,
  type CanonicalPromptSnapshot,
  type CanonicalPromptLoadResult,
} from "../src/cloud-prompt.js";
import { sha256Hex } from "../src/hash.js";

const originalFetch = globalThis.fetch;

const publication = async (publishedAt = 1_000) => {
  const prompts = await Promise.all(
    PROMPT_IDS.map(async (id) => {
      const content = `${id}\ncanonical body for ${id}\n`;
      return { id, content, sha256: await sha256Hex(content) };
    }),
  );
  const revision = await sha256Hex(
    [...prompts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((prompt) => `${prompt.id}:${prompt.sha256}`)
      .join("\n"),
  );
  const etag = `"${publishedAt}-${revision}"`;
  return {
    body: {
      schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
      revision,
      publishedAt,
      prompts,
    },
    revision,
    etag,
    response: () =>
      Response.json(
        {
          schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
          revision,
          publishedAt,
          prompts,
        },
        { headers: { etag } },
      ),
  };
};

const load = async (now = 2_000) => {
  const remote = await publication();
  globalThis.fetch = (async () => remote.response()) as typeof fetch;
  const result = await refreshCanonicalPrompts(
    "https://convex.example/",
    null,
    now,
  );
  return { remote, result, snapshot: result.snapshot };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("canonical cloud prompts", () => {
  test("accepts only the exact schema, digest catalog, revision and ETag", async () => {
    const { remote, result, snapshot } = await load();

    expect(result.disposition).toBe("fresh");
    expect(snapshot).toMatchObject({
      cacheVersion: 1,
      endpoint: "https://convex.example",
      schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
      revision: remote.revision,
      etag: remote.etag,
      fetchedAt: 2_000,
    });
    expect(snapshot.promptDigests).toHaveLength(PROMPT_IDS.length);
    expect(PROMPT_IDS).toHaveLength(8);
    expect(PROMPT_IDS).not.toContain("agents/orchestrator-orchestrated.md");
    expect(PROMPT_IDS).not.toContain("agents/manager.md");
    expect(snapshot.orchestratorBody).toBe(
      "agents/orchestrator.md\ncanonical body for agents/orchestrator.md\n",
    );
  });

  test("keeps the canonical cache ETag when Convex rewrites a gzipped 200", async () => {
    const remote = await publication();
    globalThis.fetch = (async () =>
      Response.json(remote.body, {
        headers: {
          etag: `W/"${remote.body.publishedAt}-${remote.revision}-gzip"`,
        },
      })) as typeof fetch;

    const result = await refreshCanonicalPrompts(
      "https://convex.example",
      null,
      2_000,
    );
    expect(result).toMatchObject({
      disposition: "fresh",
      snapshot: { etag: remote.etag, revision: remote.revision },
    });

    globalThis.fetch = (async () =>
      Response.json(remote.body, {
        headers: { etag: `W/"${remote.revision}-unrelated"` },
      })) as typeof fetch;
    await expect(
      refreshCanonicalPrompts("https://convex.example", null, 2_000),
    ).rejects.toMatchObject({ reason: "stale_etag" });
  });

  test("blocks a cold fetch failure and a cold digest mismatch", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(
      refreshCanonicalPrompts("https://convex.example", null, 5_000),
    ).rejects.toMatchObject({
      code: "CLOUD_CONTEXT_UNAVAILABLE",
      component: "canonical_prompt",
      reason: "fetch_failed",
    });

    const remote = await publication();
    remote.body.prompts[0]!.sha256 = "0".repeat(64);
    globalThis.fetch = (async () =>
      Response.json(remote.body, {
        headers: { etag: remote.etag },
      })) as typeof fetch;
    await expect(
      refreshCanonicalPrompts("https://convex.example", null, 5_000),
    ).rejects.toBeInstanceOf(CanonicalPromptUnavailableError);
    await expect(
      refreshCanonicalPrompts("https://convex.example", null, 5_000),
    ).rejects.toMatchObject({ reason: "prompt_digest_mismatch" });
  });

  test("rejects a retired prompt even when its digest catalog is self-consistent", async () => {
    const remote = await publication();
    const prompts = remote.body.prompts.map((prompt, index) =>
      index === 0 ? { ...prompt, id: "agents/manager.md" } : prompt,
    );
    const revision = await sha256Hex(
      [...prompts]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((prompt) => `${prompt.id}:${prompt.sha256}`)
        .join("\n"),
    );
    globalThis.fetch = (async () =>
      Response.json(
        {
          schemaVersion: STELLA_PROMPT_SCHEMA_VERSION,
          revision,
          publishedAt: 1_000,
          prompts,
        },
        { headers: { etag: `"1000-${revision}"` } },
      )) as typeof fetch;

    await expect(
      refreshCanonicalPrompts("https://convex.example", null, 5_000),
    ).rejects.toMatchObject({ reason: "invalid_prompt_catalog" });
  });

  test("uses a validated LKG on refresh failure without renewing its age", async () => {
    const { snapshot } = await load(10_000);
    let ifNoneMatch: string | null = null;
    globalThis.fetch = (async (_input, init) => {
      ifNoneMatch = new Headers(init?.headers).get("if-none-match");
      return Response.json({ error: "offline" }, { status: 503 });
    }) as typeof fetch;

    const recovered = await refreshCanonicalPrompts(
      "https://convex.example",
      snapshot,
      10_000 + 6 * 60_000,
    );

    expect(recovered).toMatchObject({
      disposition: "cache_recovery",
      refreshErrorCode: "http_503",
    });
    expect(recovered.snapshot.fetchedAt).toBe(10_000);
    expect(ifNoneMatch).toBe(snapshot.etag);
  });

  test("reuses an integrity-checked publication for 60 seconds without sliding its expiry", async () => {
    const { snapshot } = await load(10_000);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(null, {
        status: 304,
        headers: { etag: snapshot.etag },
      });
    }) as typeof fetch;
    const cached = await refreshCanonicalPrompts(
      "https://convex.example",
      snapshot,
      69_999,
    );
    expect(cached.disposition).toBe("cache_fresh");
    expect(cached.snapshot.fetchedAt).toBe(10_000);
    expect(requests).toBe(0);
    const refreshed = await refreshCanonicalPrompts(
      "https://convex.example",
      cached.snapshot,
      70_000,
    );
    expect(refreshed.disposition).toBe("cache_not_modified");
    expect(requests).toBe(1);
  });

  test("a validated stale prompt returns before background revalidation finishes", async () => {
    const { snapshot } = await load(10_000);
    let finish: (response: Response) => void = () => { throw new Error("fetch has not started"); };
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const background: Array<() => Promise<CanonicalPromptLoadResult>> = [];
    const current = await refreshCanonicalPrompts("https://convex.example", snapshot, 70_000, undefined, work => { background.push(work); });
    expect(current.disposition).toBe("cache_revalidating");
    expect(current.snapshot.fetchedAt).toBe(10_000);
    expect(background).toHaveLength(1);
    const refreshed = background[0]!();
    // Let digest validation finish and the pending network fetch start.
    await new Promise(resolve => setTimeout(resolve, 1));
    finish(new Response(null, { status: 304, headers: { etag: snapshot.etag } }));
    expect((await refreshed).snapshot.fetchedAt).toBe(70_000);
    expect(current.snapshot.fetchedAt).toBe(10_000);
  });

  test("background mode cannot use corrupt, wrong-endpoint, future or hard-expired prompts", async () => {
    const { snapshot } = await load(10_000);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    let background = 0;
    const cases = [
      { value: { ...snapshot, personalityBody: "corrupt" }, now: 80_000 },
      { value: { ...snapshot, endpoint: "https://wrong.example" }, now: 80_000 },
      { value: { ...snapshot, fetchedAt: 90_000 }, now: 80_000 },
      { value: snapshot, now: 10_000 + 24 * 60 * 60_000 + 1 },
    ];
    for (const item of cases) await expect(refreshCanonicalPrompts("https://convex.example", item.value, item.now,
      undefined, () => { background++; })).rejects.toMatchObject({ code: "CLOUD_CONTEXT_UNAVAILABLE" });
    expect(background).toBe(0);
  });

  test("revalidates a cached publication on exact 304", async () => {
    const { snapshot } = await load(10_000);
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 304,
        headers: { etag: snapshot.etag },
      })) as typeof fetch;

    const result = await refreshCanonicalPrompts(
      "https://convex.example",
      snapshot,
      10_000 + 6 * 60_000,
    );
    expect(result.disposition).toBe("cache_not_modified");
    expect(result.snapshot.fetchedAt).toBe(10_000 + 6 * 60_000);
  });

  test("blocks corrupt, wrong-endpoint and hard-stale caches when offline", async () => {
    const { snapshot } = await load(10_000);
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const cases: unknown[] = [
      { ...snapshot, orchestratorBody: `${snapshot.orchestratorBody}tampered` },
      { ...snapshot, endpoint: "https://other.example" },
      snapshot,
    ];
    const times = [20_000, 20_000, 10_000 + 24 * 60 * 60_000 + 1];
    for (let index = 0; index < cases.length; index += 1) {
      await expect(
        refreshCanonicalPrompts(
          "https://convex.example",
          cases[index],
          times[index]!,
        ),
      ).rejects.toMatchObject({ code: "CLOUD_CONTEXT_UNAVAILABLE" });
    }
  });

  test("repairs a corrupt cache after reconnect and rejects rollback into LKG", async () => {
    const first = await load(10_000);
    const newer = await publication(2_000);
    globalThis.fetch = (async () => newer.response()) as typeof fetch;
    const repaired = await refreshCanonicalPrompts(
      "https://convex.example",
      { ...first.snapshot, personalitySha256: "0".repeat(64) },
      20_000,
    );
    expect(repaired).toMatchObject({
      disposition: "fresh",
      snapshot: { revision: newer.revision, publishedAt: 2_000 },
    });

    const older = await publication(1_000);
    globalThis.fetch = (async () => older.response()) as typeof fetch;
    const rollback = await refreshCanonicalPrompts(
      "https://convex.example",
      repaired.snapshot,
      20_000 + 6 * 60_000,
    );
    expect(rollback).toMatchObject({
      disposition: "cache_recovery",
      refreshErrorCode: "publication_rollback",
      snapshot: { revision: newer.revision },
    });
  });

  test("cloud session overlay lists agent_status with the other agent tools", () => {
    const prompt = buildCloudSystemPrompt({
      canonicalBody: "canonical",
      personalityBody: null,
      localeDirective: undefined,
      residentSection: "",
      skillSection: "",
      memoryEnabled: true,
    });
    expect(prompt).toContain(
      "code, spawn_agent, send_input, pause_agent, agent_status, merge_workspace, web, Recall, Remember, Schedule",
    );
    expect(prompt).toContain("check on it with agent_status");
  });

  test("memory-off system prompt exposes no Recall/Remember tool contract", () => {
    const prompt = buildCloudSystemPrompt({
      canonicalBody: "canonical",
      personalityBody: null,
      localeDirective: undefined,
      residentSection: "",
      skillSection: "",
      memoryEnabled: false,
    });
    expect(prompt).toContain("The owner has disabled cloud memory");
    expect(prompt).not.toContain("web, Recall, Remember, Schedule");
  });
});
