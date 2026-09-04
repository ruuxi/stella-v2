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
  batchWorldBlobUploads,
  listWorldProjection,
  pullWorldProjection,
  pushWorldProjection,
  readWorldMarker,
  withWorldSyncLock,
  WORLD_BLOB_BATCH_MAX_BYTES,
  WORLD_BLOB_BATCH_MAX_COUNT,
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
  await mkdir(path.join(root, "projects", "example"), { recursive: true });
  await mkdir(path.join(root, ".stella"));
  await writeFile(
    path.join(root, ".stella", "world-manifest"),
    `${JSON.stringify({ manifestId: "live:fixture", revision })}\n`,
  );
  await writeFile(
    path.join(root, "projects", "example", "source.txt"),
    "hello",
  );
  await symlink(
    "source.txt",
    path.join(root, "projects", "example", "source-link"),
  );
  return root;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("world projection sync", () => {
  test("hashes regular files and records symlinks", async () => {
    const projection = await listWorldProjection(await fixture());
    const entries = projection.entries.filter((entry) =>
      entry.path.startsWith("projects"),
    );
    expect(
      entries.map(({ path: entryPath, kind }) => [entryPath, kind]),
    ).toEqual([
      ["projects", "dir"],
      ["projects/example", "dir"],
      ["projects/example/source-link", "symlink"],
      ["projects/example/source.txt", "file"],
    ]);
    expect(
      entries.find((entry) => entry.path === "projects/example/source-link")
        ?.target,
    ).toBe("source.txt");
    expect(
      entries.find((entry) => entry.path === "projects/example/source.txt")
        ?.sha256,
    ).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  test("posts, uploads requested blobs, and repeats until no blob is missing", async () => {
    const root = await fixture();
    const calls: Array<{
      contentType: string;
      authorization: string;
      contentLength: string | null;
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
        contentLength: requestHeaders.get("content-length"),
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
      const chunks: Uint8Array[] = [];
      for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const digest = bytes.subarray(0, 32).toString("hex");
      const size = Number(
        new DataView(bytes.buffer, bytes.byteOffset + 32, 8).getBigUint64(0),
      );
      expect(size).toBe(5);
      expect(bytes.subarray(40)).toEqual(Buffer.from("hello"));
      return Response.json({ outcomes: [{ sha256: digest, accepted: true }] });
    }) as typeof fetch;

    await pushWorldProjection({ root, access });

    expect(calls.map((call) => call.contentType)).toEqual([
      "application/json",
      "application/vnd.stella.world-blobs",
      "application/json",
    ]);
    expect(calls.every((call) => call.authorization === "Bearer secret")).toBe(
      true,
    );
    expect(calls[1]?.contentLength).toBe("45");
    expect((await readWorldMarker(root)).revision).toBe(2);
  });

  test("fills batches by bytes and count and sends oversized blobs alone", () => {
    const upload = (name: string, size: number) => ({
      sha256: name.padStart(64, "0"),
      filePath: `/tmp/${name}`,
      size,
    });
    const batches = batchWorldBlobUploads([
      upload("1", WORLD_BLOB_BATCH_MAX_BYTES - 10),
      upload("2", 10),
      upload("3", 1),
      upload("4", WORLD_BLOB_BATCH_MAX_BYTES + 1),
      ...Array.from({ length: WORLD_BLOB_BATCH_MAX_COUNT + 1 }, (_, index) =>
        upload((index + 10).toString(16), 0),
      ),
    ]);

    expect(batches[0]).toMatchObject({
      kind: "batch",
      bytes: WORLD_BLOB_BATCH_MAX_BYTES,
      blobs: expect.any(Array),
    });
    expect(batches[1]).toMatchObject({ kind: "batch", bytes: 1 });
    expect(batches[2]).toMatchObject({
      kind: "oversize",
      blob: { size: WORLD_BLOB_BATCH_MAX_BYTES + 1 },
    });
    expect(batches[3]).toMatchObject({
      kind: "batch",
    });
    if (batches[3]?.kind !== "batch") throw new Error("expected batch");
    expect(batches[3].blobs).toHaveLength(WORLD_BLOB_BATCH_MAX_COUNT);
    if (batches[4]?.kind !== "batch") throw new Error("expected batch");
    expect(batches[4].blobs).toHaveLength(1);
  });

  test("retries one failed batch once before advancing the marker", async () => {
    const root = await fixture();
    let listingCalls = 0;
    let uploadCalls = 0;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const requestHeaders = new Headers(init?.headers);
      if (requestHeaders.get("content-type") === "application/json") {
        listingCalls += 1;
        return Response.json({
          missingBlobs:
            listingCalls === 1
              ? [
                  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                ]
              : [],
          revision: listingCalls,
        });
      }
      uploadCalls += 1;
      for await (const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
        // Drain each fresh retry stream.
      }
      if (uploadCalls === 1) return new Response("failed", { status: 503 });
      return Response.json({
        outcomes: [
          {
            sha256:
              "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            accepted: true,
          },
        ],
      });
    }) as typeof fetch;

    expect((await pushWorldProjection({ root, access })).revision).toBe(2);
    expect(uploadCalls).toBe(2);
    expect((await readWorldMarker(root)).revision).toBe(2);
  });

  test("does not advance its index or marker unless every blob is accepted", async () => {
    const root = await fixture();
    let uploadCalls = 0;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const requestHeaders = new Headers(init?.headers);
      if (requestHeaders.get("content-type") === "application/json") {
        return Response.json({
          missingBlobs: [
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          ],
          revision: 7,
        });
      }
      uploadCalls += 1;
      for await (const _chunk of init?.body as unknown as AsyncIterable<Uint8Array>) {
        // Drain each fresh retry stream.
      }
      return Response.json(
        {
          outcomes: [
            {
              sha256:
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
              accepted: false,
              error: "sha256 mismatch",
            },
          ],
        },
        { status: 422 },
      );
    }) as typeof fetch;

    await expect(pushWorldProjection({ root, access })).rejects.toThrow(
      "World blob upload failed with HTTP 422",
    );
    expect(uploadCalls).toBe(2);
    expect((await readWorldMarker(root)).revision).toBe(0);
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
    await writeFile(
      path.join(root, "projects", "example", "source.txt"),
      "changed",
    );
    await pushWorldProjection({ root, access, hashFile });
    expect(hashed.map((file) => path.basename(file))).toEqual(["source.txt"]);
  });

  test("addresses an isolated fork on every world sync request", async () => {
    const root = await fixture();
    const fork = `fork-${crypto.randomUUID()}`;
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.endsWith("/push")) {
        return Response.json({ missingBlobs: [], revision: 1 });
      }
      return Response.json({
        revision: 1,
        entries: [],
        deleted: [],
        resync: false,
      });
    }) as typeof fetch;

    const isolatedAccess = { ...access, fork };
    await pushWorldProjection({ root, access: isolatedAccess });
    await pullWorldProjection({ root, access: isolatedAccess });

    expect(urls.map((url) => url.pathname.split("/").at(-1))).toEqual([
      "push",
      "changes",
    ]);
    expect(urls.every((url) => url.searchParams.get("fork") === fork)).toBe(
      true,
    );
  });

  test("pull applies upserts and deletions without following symlinks", async () => {
    const root = await fixture(1);
    await writeFile(path.join(root, "projects", "example", "gone.txt"), "gone");
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
              path: "projects/example/latest",
              kind: "symlink",
              mode: 0o777,
              mtime: 2_000,
              size: 10,
              target: "source.txt",
            },
          ],
          deleted: ["projects/example/gone.txt"],
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
      await lstat(path.join(root, "projects", "example", "gone.txt")).catch(
        () => null,
      ),
    ).toBeNull();
    expect(
      await readlink(path.join(root, "projects", "example", "latest")),
    ).toBe("source.txt");
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
