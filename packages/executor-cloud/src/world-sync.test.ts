import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listWorldProjection, pushWorldProjection } from "./world-sync.js";

const roots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const originalFetch = globalThis.fetch;

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-world-sync-"));
  roots.push(root);
  await mkdir(path.join(root, "stella"));
  await writeFile(path.join(root, "stella", "source.txt"), "hello");
  await symlink("source.txt", path.join(root, "stella", "node_modules"));
  return root;
};

describe("world projection sync", () => {
  test("hashes regular files and records symlinks without following them", async () => {
    const entries = await listWorldProjection(await fixture());
    expect(entries.map(({ path: entryPath, kind }) => [entryPath, kind])).toEqual([
      ["stella", "dir"],
      ["stella/node_modules", "symlink"],
      ["stella/source.txt", "file"],
    ]);
    expect(entries.find((entry) => entry.path === "stella/node_modules")?.target).toBe("source.txt");
    expect(entries.find((entry) => entry.path === "stella/source.txt")?.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("posts the listing, uploads requested blobs, and reposts until complete", async () => {
    const root = await fixture();
    const calls: Array<{ contentType: string; authorization: string; sha256: string | null }> = [];
    let listingCalls = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers);
      calls.push({
        contentType: requestHeaders.get("content-type") ?? "",
        authorization: requestHeaders.get("authorization") ?? "",
        sha256: requestHeaders.get("x-stella-world-blob-sha256"),
      });
      if (requestHeaders.get("content-type") === "application/json") {
        listingCalls += 1;
        const listing = JSON.parse(String(init?.body)) as { entries: Array<{ sha256?: string }> };
        return Response.json({ missingBlobs: listingCalls === 1 ? [listing.entries.find((entry) => entry.sha256)?.sha256] : [] });
      }
      for await (const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
        // Drain the file stream so the descriptor closes before cleanup.
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    await pushWorldProjection({
      root,
      access: { origin: "https://builder.example", name: "world", capability: "secret" },
    });

    expect(calls.map((call) => call.contentType)).toEqual([
      "application/json",
      "application/octet-stream",
      "application/json",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer secret")).toBe(true);
    expect(calls[1]?.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
