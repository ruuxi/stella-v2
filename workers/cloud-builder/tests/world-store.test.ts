import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import { WorldSqlStore } from "../src/world/store.js";
import {
  WORLD_BLOB_BATCH_MAX_BYTES,
  WORLD_BLOB_FRAME_HEADER_BYTES,
  WORLD_CHANGE_LOG_MAX_ROWS,
} from "../src/world/types.js";
import { sha256BytesHex } from "../src/hash.js";
import { handleEdit, handleRead } from "@stella/runtime/kernel/tools/file.js";
import { handleGrep } from "@stella/runtime/kernel/tools/search.js";
import { handleApplyPatch } from "@stella/runtime/kernel/tools/apply-patch.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const blobFrame = (sha256: string, bytes: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(
    WORLD_BLOB_FRAME_HEADER_BYTES + bytes.byteLength,
  );
  for (let index = 0; index < 32; index += 1) {
    frame[index] = Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16);
  }
  new DataView(frame.buffer).setBigUint64(32, BigInt(bytes.byteLength), false);
  frame.set(bytes, WORLD_BLOB_FRAME_HEADER_BYTES);
  return frame;
};

const fragmentedStream = (
  bytes: Uint8Array,
  fragmentBytes = bytes.byteLength,
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += fragmentBytes) {
        controller.enqueue(bytes.slice(offset, offset + fragmentBytes));
      }
      controller.close();
    },
  });

if (!("FixedLengthStream" in globalThis)) {
  Object.defineProperty(globalThis, "FixedLengthStream", {
    configurable: true,
    value: class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor(_length: number) {
        const stream = new TransformStream<Uint8Array, Uint8Array>();
        this.readable = stream.readable;
        this.writable = stream.writable;
      }
    },
  });
}

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(
    key: string,
    value: Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<null> {
    const bytes =
      value instanceof Uint8Array
        ? value.slice()
        : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
    return null;
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ) {
    const value = this.objects.get(key);
    if (!value) return null;
    const range = options?.range;
    const bytes = range
      ? value.slice(range.offset, range.offset + range.length)
      : value;
    return {
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

const stores: Array<ReturnType<typeof openSqlStorageFake>> = [];

const createWorld = (): WorldSqlStore => {
  const fake = openSqlStorageFake();
  stores.push(fake);
  const world = new WorldSqlStore(
    fake.sql,
    new MemoryBucket() as unknown as R2Bucket,
    () => 1_700_000_000_000,
  );
  world.initialize();
  return world;
};

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("WorldSqlStore", () => {
  test("remembers the container size and lets OOM escalation replace it", () => {
    const world = createWorld();
    expect(world.selectContainerSize("small")).toBe("small");
    expect(world.selectContainerSize("large")).toBe("small");
    world.rememberContainerSize("large");
    expect(world.selectContainerSize("small")).toBe("large");
  });

  test("writes, reads, edits, greps, and checkpoints an idempotent tree", async () => {
    const world = createWorld();
    await world.writeFile(
      "src/demo.ts",
      encoder.encode("const one = 1;\nconst two = 2;\n"),
    );
    expect(decoder.decode(await world.readFile("src/demo.ts"))).toBe(
      "const one = 1;\nconst two = 2;\n",
    );

    const read = await world.tool({
      name: "Read",
      arguments: { file_path: "/workspace/world/src/demo.ts" },
    });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("1#");
    const anchor = /\s(2#[0-9a-z]{3})\t/u.exec(read.output)?.[1];
    expect(anchor).toBeTruthy();
    const edit = await world.tool({
      name: "Edit",
      arguments: {
        file_path: "/workspace/world/src/demo.ts",
        anchor,
        new_string: "const two = 3;",
      },
    });
    expect(edit.ok).toBe(true);
    const grep = await world.tool({
      name: "Grep",
      arguments: {
        pattern: "two = 3",
        path: "/workspace/world/src",
        output_mode: "content",
      },
    });
    expect(grep.output).toContain(
      "/workspace/world/src/demo.ts:2:const two = 3;",
    );

    const first = await world.checkpoint({
      historyCursor: `v1:${"a".repeat(64)}`,
    });
    const second = await world.checkpoint({
      historyCursor: `v1:${"a".repeat(64)}`,
    });
    expect(second.manifestId).toBe(first.manifestId);
    expect(
      (await world.manifest(first.manifestId))?.entries.map(
        (entry) => entry.path,
      ),
    ).toEqual(["src", "src/demo.ts"]);
  });

  test("diff and pushDiff apply known metadata and request only missing blobs", async () => {
    const world = createWorld();
    await world.writeFile("old.txt", encoder.encode("old"));
    const bytes = encoder.encode("new");
    const sha256 = await sha256BytesHex(bytes);
    const listing = [
      {
        path: "new.txt",
        kind: "file" as const,
        mode: 0o644,
        mtime: 10,
        size: bytes.byteLength,
        sha256,
      },
    ];
    expect(await world.diff(listing)).toEqual({
      changed: ["new.txt"],
      deleted: ["old.txt"],
    });
    expect(
      await world.pushDiff({ entries: listing, deleted: ["old.txt"] }),
    ).toEqual({ missingBlobs: [sha256], revision: 1 });
    expect(
      await world.putBlobs(fragmentedStream(blobFrame(sha256, bytes))),
    ).toEqual([{ sha256, accepted: true }]);
    expect(
      await world.pushDiff({ entries: listing, deleted: ["old.txt"] }),
    ).toEqual({ missingBlobs: [], revision: 2 });
    expect(decoder.decode(await world.readFile("new.txt"))).toBe("new");
  });

  test("putBlobs parses many frames split across arbitrary stream chunks", async () => {
    const world = createWorld();
    const first = encoder.encode("first");
    const second = encoder.encode("second");
    const firstSha = await sha256BytesHex(first);
    const secondSha = await sha256BytesHex(second);
    const firstFrame = blobFrame(firstSha, first);
    const secondFrame = blobFrame(secondSha, second);
    const body = new Uint8Array(firstFrame.byteLength + secondFrame.byteLength);
    body.set(firstFrame);
    body.set(secondFrame, firstFrame.byteLength);

    expect(await world.putBlobs(fragmentedStream(body, 3))).toEqual([
      { sha256: firstSha, accepted: true },
      { sha256: secondSha, accepted: true },
    ]);
    expect((await world.exportBlob(firstSha))?.size).toBe(first.byteLength);
    expect((await world.exportBlob(secondSha))?.size).toBe(second.byteLength);
  });

  test("putBlobs rejects a sha mismatch without recording either digest", async () => {
    const world = createWorld();
    const expectedSha = await sha256BytesHex(encoder.encode("expected"));
    const actual = encoder.encode("corrupted");
    const actualSha = await sha256BytesHex(actual);

    expect(
      await world.putBlobs(fragmentedStream(blobFrame(expectedSha, actual), 1)),
    ).toEqual([
      {
        sha256: expectedSha,
        accepted: false,
        error: `sha256 mismatch: received ${actualSha}`,
      },
    ]);
    expect(await world.exportBlob(expectedSha)).toBeNull();
    expect(await world.exportBlob(actualSha)).toBeNull();
  });

  test("putBlobs refuses a declared request above the 32 MiB byte cap", async () => {
    const world = createWorld();
    const header = new Uint8Array(WORLD_BLOB_FRAME_HEADER_BYTES);
    new DataView(header.buffer).setBigUint64(
      32,
      BigInt(WORLD_BLOB_BATCH_MAX_BYTES + 1),
      false,
    );

    await expect(world.putBlobs(fragmentedStream(header, 7))).rejects.toThrow(
      "exceeds the 32 MiB request limit",
    );
  });

  test("pages changes by revision and reports tool-write revisions", async () => {
    const world = createWorld();
    const first = await world.writeFile("src/one.txt", encoder.encode("one"));
    const second = await world.tool({
      name: "Write",
      arguments: {
        file_path: "/workspace/world/src/two.txt",
        content: "two",
      },
    });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);

    const pageOne = await world.changesSince(0);
    expect(pageOne).toMatchObject({ revision: 1, resync: false, deleted: [] });
    expect(pageOne.entries.map((entry) => entry.path)).toEqual([
      "src",
      "src/one.txt",
    ]);
    const pageTwo = await world.changesSince(pageOne.revision);
    expect(pageTwo).toMatchObject({ revision: 2, resync: false, deleted: [] });
    expect(pageTwo.entries.map((entry) => entry.path)).toEqual(["src/two.txt"]);
    expect(await world.changesSince(pageTwo.revision)).toEqual({
      revision: 2,
      entries: [],
      deleted: [],
      resync: false,
    });

    await world.remove("src/one.txt");
    expect(await world.changesSince(2)).toMatchObject({
      revision: 3,
      deleted: ["src/one.txt"],
      resync: false,
    });
  });

  test("compacts an oversized change batch into a manifest resync", async () => {
    const world = createWorld();
    const entries = Array.from(
      { length: WORLD_CHANGE_LOG_MAX_ROWS + 1 },
      (_, index) => ({
        path: `bulk/${String(index).padStart(5, "0")}`,
        kind: "dir" as const,
        mode: 0o755,
        mtime: index,
        size: 0,
      }),
    );
    expect(await world.pushDiff({ entries, deleted: [] })).toEqual({
      missingBlobs: [],
      revision: 1,
    });
    expect(await world.changesSince(0)).toEqual({
      revision: 1,
      entries: [],
      deleted: [],
      resync: true,
    });
    const fake = stores.at(-1)!;
    expect(
      fake.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM world_changes")
        .one().count,
    ).toBeLessThanOrEqual(WORLD_CHANGE_LOG_MAX_ROWS);
  });

  test("uses last-writer-wins across two pushes to the same path", async () => {
    const world = createWorld();
    const push = async (text: string, mtime: number) => {
      const bytes = encoder.encode(text);
      const sha256 = await sha256BytesHex(bytes);
      await world.putBlobs(fragmentedStream(blobFrame(sha256, bytes)));
      return await world.pushDiff({
        entries: [
          {
            path: "shared.txt",
            kind: "file",
            mode: 0o644,
            mtime,
            size: bytes.byteLength,
            sha256,
          },
        ],
        deleted: [],
      });
    };
    expect((await push("first", 1)).revision).toBe(1);
    expect((await push("second", 2)).revision).toBe(2);
    expect(decoder.decode(await world.readFile("shared.txt"))).toBe("second");
  });

  test("fork copies metadata, shares chunks, and new starts empty", async () => {
    const world = createWorld();
    await world.writeFile("shared.txt", encoder.encode("shared bytes"));
    const fake = stores.at(-1)!;
    const before = fake.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM world_chunks")
      .one().count;

    const forked = await world.fork({
      kind: "fork",
      threadId: "thread-fork",
    });
    expect(
      decoder.decode(
        await world.readFile("shared.txt", { fork: forked.forkId }),
      ),
    ).toBe("shared bytes");
    expect(
      fake.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM world_chunks")
        .one().count,
    ).toBe(before);

    const fresh = await world.fork({
      kind: "new",
      threadId: "thread-new",
    });
    expect(await world.list("", { fork: fresh.forkId })).toEqual({
      entries: [],
    });
    expect(await world.forkStatus(fresh.forkId)).toMatchObject({
      kind: "new",
      baseManifestId: null,
      changedSinceBase: 0,
      revision: 0,
    });
    expect(await world.dropFork(fresh.forkId)).toEqual({ dropped: true });
    expect(await world.dropFork(fresh.forkId)).toEqual({ dropped: false });
  });

  test("merge applies upserts and tombstones and takes reported conflicts", async () => {
    const world = createWorld();
    await world.writeFile("conflict.txt", encoder.encode("base"));
    await world.writeFile("deleted.txt", encoder.encode("delete me"));
    const isolated = await world.fork({
      kind: "fork",
      threadId: "thread-merge",
    });

    await world.writeFile("conflict.txt", encoder.encode("fork wins"), {
      fork: isolated.forkId,
    });
    await world.writeFile("added.txt", encoder.encode("added"), {
      fork: isolated.forkId,
    });
    await world.remove("deleted.txt", { fork: isolated.forkId });
    await world.writeFile("conflict.txt", encoder.encode("shared loses"));

    const merged = await world.merge({
      from: isolated.forkId,
      into: "shared",
      strategy: "last_writer_wins",
    });
    expect(merged.applied).toEqual(["added.txt", "conflict.txt"]);
    expect(merged.deleted).toEqual(["deleted.txt"]);
    expect(merged.conflicts).toEqual(["conflict.txt"]);
    expect(decoder.decode(await world.readFile("conflict.txt"))).toBe(
      "fork wins",
    );
    expect(decoder.decode(await world.readFile("added.txt"))).toBe("added");
    expect(await world.stat("deleted.txt")).toBeNull();
    expect(await world.forkStatus(isolated.forkId)).toMatchObject({
      kind: "fork",
      changedSinceBase: 3,
      revision: 3,
    });
  });

  test("records tombstones only for paths inherited from the parent manifest", async () => {
    const fake = openSqlStorageFake();
    stores.push(fake);
    const world = new WorldSqlStore(
      fake.sql,
      new MemoryBucket() as unknown as R2Bucket,
      () => 1_700_000_000_000,
    );
    world.initialize();
    await world.writeFile("kept.txt", encoder.encode("parent"));
    await world.checkpoint({ historyCursor: `v1:${"b".repeat(64)}` });
    await world.writeFile("temporary.txt", encoder.encode("live only"));
    await world.remove("temporary.txt");
    await world.remove("kept.txt");
    expect(
      fake.sql
        .exec<{
          path: string;
        }>("SELECT path FROM world_tombstones ORDER BY path")
        .toArray(),
    ).toEqual([{ path: "kept.txt" }]);
  });

  test("exports a readable ustar stream", async () => {
    const world = createWorld();
    await world.writeFile("hello.txt", encoder.encode("hello"));
    const exported = world.exportTar();
    expect(exported.revision).toBe(1);
    const response = new Response(exported.body);
    const tar = new Uint8Array(await response.arrayBuffer());
    expect(decoder.decode(tar.slice(0, 9))).toBe("hello.txt");
    expect(decoder.decode(tar.slice(257, 262))).toBe("ustar");
    expect(decoder.decode(tar.slice(512, 517))).toBe("hello");
  });

  test("binds a sealed checkpoint export to its own revision after later writes", async () => {
    const world = createWorld();
    await world.writeFile("before.txt", encoder.encode("revision one"));
    const checkpoint = await world.checkpoint({
      historyCursor: `v1:${"c".repeat(64)}`,
    });
    await world.writeFile("after.txt", encoder.encode("revision two"));

    const exported = world.exportTar(checkpoint.manifestId);
    expect(exported.revision).toBe(1);
    const tar = decoder.decode(
      new Uint8Array(await new Response(exported.body).arrayBuffer()),
    );
    expect(tar).toContain("before.txt");
    expect(tar).toContain("revision one");
    expect(tar).not.toContain("after.txt");
    expect((await world.head()).revision).toBe(2);
  });

  test("refuses to export a manifest through a different fork", async () => {
    const world = createWorld();
    await world.writeFile("shared.txt", encoder.encode("shared"));
    const checkpoint = await world.checkpoint({
      historyCursor: `v1:${"d".repeat(64)}`,
    });
    const isolated = await world.fork({
      kind: "new",
      threadId: "wrong-export-fork",
    });

    expect(() =>
      world.exportTar(checkpoint.manifestId, { fork: isolated.forkId }),
    ).toThrow("does not belong to the requested fork");
  });

  test("aborts a lazy live export before emitting a complete stale archive", async () => {
    const world = createWorld();
    await world.writeFile("before.txt", encoder.encode("revision one"));
    const exported = world.exportTar();
    expect(exported.revision).toBe(1);
    const reader = exported.body.getReader();
    expect((await reader.read()).done).toBe(false);

    await world.writeFile("concurrent.txt", encoder.encode("revision two"));

    const drain = async (): Promise<void> => {
      while (!(await reader.read()).done) {
        // Drain any chunk queued before the revision changed.
      }
    };
    await expect(drain()).rejects.toThrow(
      "World changed while exporting its live manifest",
    );
    expect((await world.head()).revision).toBe(2);
  });

  test("refuses live export while rename has partially changed SQL at the old revision", async () => {
    const world = createWorld();
    await world.writeFile("source/file.txt", encoder.encode("content"));
    let enteredRemove!: () => void;
    const removeEntered = new Promise<void>((resolve) => {
      enteredRemove = resolve;
    });
    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const originalRemove = world.remove.bind(world);
    world.remove = async (input, options = {}) => {
      enteredRemove();
      await removeGate;
      return await originalRemove(input, options);
    };

    const rename = world.rename("source", "destination");
    await removeEntered;
    expect(() => world.exportTar()).toThrow(
      "World cannot be exported during a mutation",
    );
    await expect(
      world.fork({ kind: "fork", threadId: "mutation-racing-fork" }),
    ).rejects.toThrow("cannot be sealed during a mutation");
    releaseRemove();
    await rename;
    expect(await world.stat("destination/file.txt")).not.toBeNull();
  });

  test("streams blobs above four MiB to R2 and reads bounded ranges", async () => {
    const fake = openSqlStorageFake();
    stores.push(fake);
    const bucket = new MemoryBucket();
    const world = new WorldSqlStore(
      fake.sql,
      bucket as unknown as R2Bucket,
      () => 1_700_000_000_000,
    );
    world.initialize();
    const bytes = new Uint8Array(4 * 1024 * 1024 + 17).fill(0x61);
    const sha256 = await sha256BytesHex(bytes);
    await world.putBlobs(fragmentedStream(blobFrame(sha256, bytes), 127_003));
    await world.pushDiff({
      entries: [
        {
          path: "large.bin",
          kind: "file",
          mode: 0o644,
          size: bytes.byteLength,
          sha256,
        },
      ],
      deleted: [],
    });
    expect(bucket.objects.get(`blobs/${sha256}`)?.byteLength).toBe(
      bytes.byteLength,
    );
    expect(
      await world.readFile("large.bin", {
        offset: bytes.byteLength - 17,
        length: 17,
      }),
    ).toEqual(bytes.subarray(bytes.byteLength - 17));
  });

  test("matches the Node host for Read, Edit, Grep, and apply_patch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-world-parity-"));
    try {
      const world = createWorld();
      const localPath = path.join(root, "demo.ts");
      const worldPath = "/workspace/world/demo.ts";
      const initial = "const alpha = 1;\nconst beta = 2;\n";
      await writeFile(localPath, initial);
      await world.writeFile("demo.ts", encoder.encode(initial));
      const normalize = (value: unknown): string =>
        (typeof value === "string" ? value : JSON.stringify(value))
          .replaceAll(localPath, worldPath)
          .replaceAll(root, "/workspace/world")
          .trimEnd();

      const nodeRead = await handleRead(
        { file_path: localPath, offset: 1, limit: 20 },
        { toolWorkspaceRoot: root },
      );
      const worldRead = await world.tool({
        name: "Read",
        arguments: { file_path: worldPath, offset: 1, limit: 20 },
      });
      expect(worldRead.ok).toBe(true);
      expect(normalize(worldRead.output)).toBe(normalize(nodeRead.result));

      const editArgs = {
        old_string: "const beta = 2;",
        new_string: "const beta = 3;",
      };
      const nodeEdit = await handleEdit(
        { file_path: localPath, ...editArgs },
        { toolWorkspaceRoot: root },
      );
      const worldEdit = await world.tool({
        name: "Edit",
        arguments: { file_path: worldPath, ...editArgs },
      });
      expect(normalize(worldEdit.output)).toBe(normalize(nodeEdit.result));
      expect(decoder.decode((await world.readFile("demo.ts"))!)).toBe(
        await readFile(localPath, "utf8"),
      );

      const grepArgs = {
        pattern: "beta = 3",
        output_mode: "content",
        max_results: 10,
      };
      const nodeGrep = await handleGrep(
        { path: localPath, ...grepArgs },
        { toolWorkspaceRoot: root },
      );
      const worldGrep = await world.tool({
        name: "Grep",
        arguments: { path: worldPath, ...grepArgs },
      });
      expect(normalize(worldGrep.output)).toBe(normalize(nodeGrep.result));

      const nodePatch = `*** Begin Patch\n*** Update File: ${localPath}\n@@\n-const alpha = 1;\n+const alpha = 4;\n*** End Patch`;
      const worldPatch = nodePatch.replace(localPath, worldPath);
      const nodePatched = await handleApplyPatch(
        { input: nodePatch },
        { toolWorkspaceRoot: root },
      );
      const worldPatched = await world.tool({
        name: "apply_patch",
        arguments: { input: worldPatch },
      });
      expect(normalize(worldPatched.output)).toBe(
        normalize(nodePatched.result),
      );
      expect(decoder.decode((await world.readFile("demo.ts"))!)).toBe(
        await readFile(localPath, "utf8"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
