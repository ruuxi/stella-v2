import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import { WorldSqlStore } from "../src/world/store.js";
import { sha256BytesHex } from "../src/hash.js";
import { handleEdit, handleRead } from "@stella/runtime/kernel/tools/file.js";
import { handleGrep } from "@stella/runtime/kernel/tools/search.js";
import { handleApplyPatch } from "@stella/runtime/kernel/tools/apply-patch.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
    ).toEqual({ missingBlobs: [sha256] });
    const { uploadId } = await world.beginBlob();
    await world.appendBlob(uploadId, bytes);
    await world.finishBlob(uploadId, { sha256 });
    expect(
      await world.pushDiff({ entries: listing, deleted: ["old.txt"] }),
    ).toEqual({ missingBlobs: [] });
    expect(decoder.decode(await world.readFile("new.txt"))).toBe("new");
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
    const response = new Response(world.exportTar());
    const tar = new Uint8Array(await response.arrayBuffer());
    expect(decoder.decode(tar.slice(0, 9))).toBe("hello.txt");
    expect(decoder.decode(tar.slice(257, 262))).toBe("ustar");
    expect(decoder.decode(tar.slice(512, 517))).toBe("hello");
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
    const { uploadId } = await world.beginBlob();
    await world.appendBlob(uploadId, bytes.subarray(0, 3 * 1024 * 1024));
    await world.appendBlob(uploadId, bytes.subarray(3 * 1024 * 1024));
    await world.finishBlob(uploadId, { path: "large.bin", sha256 });
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
