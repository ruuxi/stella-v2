import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  listWorldProjection,
  pullWorldProjection,
  pushWorldProjection,
  readWorldMarker,
  withWorldSyncLock,
} from "./world-sync.js";

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const access = {
  origin: "https://builder.example",
  name: "world",
  capability: "secret",
};

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async (revision = 0): Promise<string> => {
  const base = await mkdtemp(path.join(tmpdir(), "stella-world-sync-"));
  roots.push(base);
  const root = path.join(base, "world");
  await mkdir(path.join(root, "stella"), { recursive: true });
  await mkdir(path.join(root, ".stella"));
  await writeFile(
    path.join(root, ".stella", "world-manifest"),
    `${JSON.stringify({ manifestId: "live:fixture", revision })}\n`,
  );
  await writeFile(path.join(root, "stella", "source.txt"), "hello");
  await symlink("source.txt", path.join(root, "stella", "node_modules"));
  return root;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("world projection sync", () => {
  test("hashes regular files and records node_modules as a symlink", async () => {
    const projection = await listWorldProjection(await fixture());
    const entries = projection.entries.filter((entry) =>
      entry.path.startsWith("stella"),
    );
    expect(
      entries.map(({ path: entryPath, kind }) => [entryPath, kind]),
    ).toEqual([
      ["stella", "dir"],
      ["stella/node_modules", "symlink"],
      ["stella/source.txt", "file"],
    ]);
    expect(
      entries.find((entry) => entry.path === "stella/node_modules")?.target,
    ).toBe("source.txt");
    expect(
      entries.find((entry) => entry.path === "stella/source.txt")?.sha256,
    ).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  test("posts, uploads requested blobs, and repeats until no blob is missing", async () => {
    const root = await fixture();
    const calls: Array<{
      contentType: string;
      authorization: string;
      sha256: string | null;
    }> = [];
    let listingCalls = 0;
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const requestHeaders = new Headers(init?.headers);
      calls.push({
        contentType: requestHeaders.get("content-type") ?? "",
        authorization: requestHeaders.get("authorization") ?? "",
        sha256: requestHeaders.get("x-stella-world-blob-sha256"),
      });
      if (requestHeaders.get("content-type") === "application/json") {
        listingCalls += 1;
        const listing = JSON.parse(String(init?.body)) as {
          entries: Array<{ sha256?: string }>;
        };
        return Response.json({
          missingBlobs:
            listingCalls === 1
              ? [listing.entries.find((entry) => entry.sha256)?.sha256]
              : [],
          revision: listingCalls,
        });
      }
      for await (const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
        // Drain the file stream so cleanup can remove the fixture.
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    await pushWorldProjection({ root, access });

    expect(calls.map((call) => call.contentType)).toEqual([
      "application/json",
      "application/octet-stream",
      "application/json",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer secret")).toBe(
      true,
    );
    expect(calls[1]?.sha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect((await readWorldMarker(root)).revision).toBe(2);
  });

  test("reuses indexed hashes until size or mtime changes", async () => {
    const root = await fixture();
    let revision = 0;
    globalThis.fetch = (async () =>
      Response.json({
        missingBlobs: [],
        revision: ++revision,
      })) as unknown as typeof fetch;
    const hashed: string[] = [];
    const hashFile = async (filePath: string): Promise<string> => {
      hashed.push(filePath);
      return sha256(await readFile(filePath));
    };

    await pushWorldProjection({ root, access, hashFile });
    expect(hashed.map((file) => path.basename(file))).toEqual(["source.txt"]);
    hashed.length = 0;
    await pushWorldProjection({ root, access, hashFile });
    expect(hashed).toEqual([]);
    await writeFile(path.join(root, "stella", "source.txt"), "changed");
    await pushWorldProjection({ root, access, hashFile });
    expect(hashed.map((file) => path.basename(file))).toEqual(["source.txt"]);
  });

  test("pull applies upserts and deletions without following symlinks", async () => {
    const root = await fixture(1);
    await writeFile(path.join(root, "stella", "gone.txt"), "gone");
    const bytes = new TextEncoder().encode("from world");
    const digest = sha256(bytes);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/changes?since=1")) {
        return Response.json({
          revision: 2,
          entries: [
            {
              path: "generated",
              kind: "dir",
              mode: 0o750,
              mtime: 2_000,
              size: 0,
            },
            {
              path: "generated/result.txt",
              kind: "file",
              mode: 0o640,
              mtime: 2_000,
              size: bytes.byteLength,
              sha256: digest,
            },
            {
              path: "stella/latest",
              kind: "symlink",
              mode: 0o777,
              mtime: 2_000,
              size: 10,
              target: "source.txt",
            },
          ],
          deleted: ["stella/gone.txt"],
          resync: false,
        });
      }
      if (url.includes("/changes?since=2")) {
        return Response.json({
          revision: 2,
          entries: [],
          deleted: [],
          resync: false,
        });
      }
      if (url.endsWith(`/blob/${digest}`)) return new Response(bytes);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await pullWorldProjection({ root, access });

    expect(
      await readFile(path.join(root, "generated", "result.txt"), "utf8"),
    ).toBe("from world");
    expect(
      await lstat(path.join(root, "stella", "gone.txt")).catch(() => null),
    ).toBeNull();
    expect(await readlink(path.join(root, "stella", "latest"))).toBe(
      "source.txt",
    );
    expect((await readWorldMarker(root)).revision).toBe(2);
  });

  test("serializes every daemon through the container-wide flock", async () => {
    const root = await fixture();
    const events: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withWorldSyncLock(root, async () => {
      events.push("first-enter");
      firstEntered();
      await release;
      events.push("first-exit");
    });
    await entered;
    const second = withWorldSyncLock(root, async () => {
      events.push("second-enter");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["first-enter"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });
});
