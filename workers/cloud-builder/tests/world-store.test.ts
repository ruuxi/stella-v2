import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { openSqlStorageFake } from "./fixtures/sql-storage.js";
import { WorldSqlStore } from "../src/world/store.js";
import {
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

  test("reads late ranges and overwrites files above the edit limit without loading them whole", async () => {
    const world = createWorld();
    const large = "line-data\n".repeat(130_000);
    expect(encoder.encode(large).byteLength).toBeGreaterThan(1_000_000);
    await world.writeFile("large.txt", encoder.encode(large));

    const read = await world.tool({
      name: "Read",
      arguments: {
        file_path: "/workspace/world/large.txt",
        offset: 120_001,
        limit: 2,
      },
    });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("Showing 120001-120002");
    expect(read.output).toContain("120001#");
    expect(read.output).toContain("continue with offset=120003");

    const write = await world.tool({
      name: "Write",
      arguments: {
        file_path: "/workspace/world/large.txt",
        content: "tiny\n",
      },
    });
    expect(write.ok).toBe(true);
    expect(decoder.decode((await world.readFile("large.txt"))!)).toBe("tiny\n");
  });

  test("caps line count for newline-only large reads with an unbounded requested limit", async () => {
    const world = createWorld();
    await world.writeFile(
      "newlines.txt",
      encoder.encode("\n".repeat(1_100_000)),
    );
    const read = await world.tool({
      name: "Read",
      arguments: {
        file_path: "/workspace/world/newlines.txt",
        limit: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("Showing 1-5000");
    expect(read.output).toContain("continue with offset=5001");
    expect(read.output).toContain("Read limited to 5000 lines per call");
    expect(encoder.encode(read.output).byteLength).toBeLessThan(100_000);
  });

  test("rejects unsafe regexes and explicitly reports oversized grep subjects", async () => {
    const world = createWorld();
    await world.writeFile(
      "regex.txt",
      encoder.encode(`${"a".repeat(70_000)}needle\n`),
    );

    const unsafe = await world.tool({
      name: "Grep",
      arguments: {
        path: "/workspace/world/regex.txt",
        pattern: "(a+)+$",
        output_mode: "content",
      },
    });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.output).toContain("quantified groups are unsupported");
    const quadratic = await world.tool({
      name: "Grep",
      arguments: {
        path: "/workspace/world/regex.txt",
        pattern: "a+X",
        output_mode: "content",
      },
    });
    expect(quadratic.ok).toBe(false);
    expect(quadratic.output).toContain(
      "patterns containing quantifiers must start with ^",
    );

    const oversized = await world.tool({
      name: "Grep",
      arguments: {
        path: "/workspace/world/regex.txt",
        pattern: "needle",
        output_mode: "content",
      },
    });
    expect(oversized.ok).toBe(true);
    expect(oversized.output).toContain("Search incomplete");
    expect(oversized.output).toContain(
      "1 line(s) exceeded the 65536-character regex subject limit",
    );
  });

  test("bounds grep work beyond eight MiB and preserves unicode split across read chunks", async () => {
    const world = createWorld();
    const farMatch = `${`${"x".repeat(99)}\n`.repeat(85_000)}TAIL_MATCH\n`;
    expect(encoder.encode(farMatch).byteLength).toBeGreaterThan(
      8 * 1024 * 1024,
    );
    const farBytes = encoder.encode(farMatch);
    const farSha = await sha256BytesHex(farBytes);
    await world.putBlobs(
      fragmentedStream(blobFrame(farSha, farBytes), 131_071),
    );
    await world.pushDiff({
      entries: [
        {
          path: "far.txt",
          kind: "file",
          mode: 0o644,
          size: farBytes.byteLength,
          sha256: farSha,
        },
      ],
      deleted: [],
    });
    const far = await world.tool({
      name: "Grep",
      arguments: {
        path: "/workspace/world/far.txt",
        pattern: "TAIL_MATCH",
        output_mode: "content",
      },
    });
    expect(far.ok).toBe(true);
    expect(far.output).toContain("Search incomplete");
    expect(far.output).toContain("aggregate regex budget was reached");
    expect(far.output).not.toContain("85001:TAIL_MATCH");

    // The four-byte character begins one byte before the 256 KiB tool read boundary.
    const splitUnicode = `${"a".repeat(256 * 1024 - 2)}\n🦄needle\n`;
    await world.writeFile("unicode.txt", encoder.encode(splitUnicode));
    const unicode = await world.tool({
      name: "Grep",
      arguments: {
        path: "/workspace/world/unicode.txt",
        pattern: "🦄needle",
        output_mode: "content",
      },
    });
    expect(unicode.ok).toBe(true);
    expect(unicode.output).toContain("2:🦄needle");
  });

  test("bounds glob results and returns a usable continuation cursor", async () => {
    const world = createWorld();
    for (let index = 0; index < 30; index += 1)
      await world.writeFile(
        `glob/${String(index).padStart(2, "0")}-é.txt`,
        encoder.encode("ok"),
      );
    const first = await world.tool({
      name: "Glob",
      arguments: {
        path: "/workspace/world/glob",
        pattern: "*.txt",
        max_results: 5,
      },
    });
    expect(first.ok).toBe(true);
    expect(first.output).toContain("Glob results truncated at 5 matches");
    expect(first.output).toContain("é.txt");
    const cursor = /Continue with cursor=("(?:[^"\\]|\\.)*")/u.exec(
      first.output,
    )?.[1];
    expect(cursor).toBeTruthy();
    const second = await world.tool({
      name: "Glob",
      arguments: {
        path: "/workspace/world/glob",
        pattern: "*.txt",
        max_results: 5,
        cursor: JSON.parse(cursor!),
      },
    });
    expect(second.ok).toBe(true);
    expect(second.output).not.toContain("/00-é.txt");
  });

  test("matches the Node host for Read, Edit, Grep, and apply_patch", async () => {
    const root = await realpath(
      // macOS's canonical temp directory is /private/var, which file tools
      // correctly refuse as a system directory. Use a disposable home fixture.
      await mkdtemp(path.join(homedir(), ".stella-world-parity-")),
    );
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
      // Node uses ripgrep when installed and a JS scan otherwise. The fallback
      // includes the file path and a result-count header; compare the complete
      // matched lines so parity is independent of the host's ripgrep install.
      const matchedLines = (value: unknown) =>
        normalize(value)
          .replace(/^Found (?:matches|\d+ result\(s\)):\n\n/, "")
          .replaceAll(`${worldPath}:`, "");
      expect(worldGrep.ok).toBe(true);
      expect(nodeGrep.error).toBeUndefined();
      expect(matchedLines(worldGrep.output)).toBe("2:const beta = 3;");
      expect(matchedLines(worldGrep.output)).toBe(matchedLines(nodeGrep.result));

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

describe("WorldSqlStore worker-shell reads and commits", () => {
  const blobEntry = async (
    world: WorldSqlStore,
    path: string,
    text: string,
  ) => {
    const bytes = encoder.encode(text);
    const sha256 = await sha256BytesHex(bytes);
    const outcome = await world.putBlob(fragmentedStream(bytes), {
      sha256,
      size: bytes.byteLength,
    });
    expect(outcome.accepted).toBe(true);
    return { path, kind: "file" as const, mode: 0o644, size: bytes.byteLength, sha256 };
  };

  test("statMany answers exact paths without following links", async () => {
    const world = createWorld();
    await world.writeFile("a/b.txt", encoder.encode("b"));
    await world.symlink("link", "a");
    const [root, file, dir, link, through, missing] = await world.statMany([
      "",
      "a/b.txt",
      "a",
      "link",
      "link/b.txt",
      "nope",
    ]);
    expect(root).toMatchObject({ kind: "dir", path: "" });
    expect(file).toMatchObject({ kind: "file", size: 1 });
    expect(dir).toMatchObject({ kind: "dir" });
    expect(link).toMatchObject({ kind: "symlink", target: "a" });
    expect(through).toBeNull();
    expect(missing).toBeNull();
    await expect(world.statMany(["../escape"])).rejects.toThrow();
  });

  test("children lists one level, in name order", async () => {
    const world = createWorld();
    await world.writeFile("d/z.txt", encoder.encode("z"));
    await world.writeFile("d/a.txt", encoder.encode("a"));
    await world.writeFile("d/sub/deep.txt", encoder.encode("deep"));
    await world.writeFile("top.txt", encoder.encode("t"));
    expect((await world.children("d")).map((entry) => entry.path)).toEqual([
      "d/a.txt",
      "d/sub",
      "d/z.txt",
    ]);
    expect((await world.children("")).map((entry) => entry.path)).toEqual([
      "d",
      "top.txt",
    ]);
  });

  test("commits a change set in one revision when nothing it used moved", async () => {
    const world = createWorld();
    await world.writeFile("keep.txt", encoder.encode("keep"));
    await world.writeFile("gone/old.txt", encoder.encode("old"));
    const base = (await world.head()).revision;
    // An unrelated write after the base does not block the commit.
    await world.writeFile("elsewhere.txt", encoder.encode("x"));
    const result = await world.commitShell({
      baseRevision: base,
      reads: { paths: ["keep.txt", "gone"], children: ["gone"] },
      entries: [await blobEntry(world, "new/made.txt", "made")],
      deleted: ["gone"],
    });
    expect(result).toEqual({ status: "committed", revision: base + 2 });
    expect(decoder.decode((await world.readFile("new/made.txt"))!)).toBe("made");
    expect(await world.stat("gone/old.txt")).toBeNull();
    expect(await world.stat("keep.txt")).not.toBeNull();
  });

  test("refuses a change set when a path it read, listed, wrote or deleted moved", async () => {
    const cases: Array<{
      moved: string;
      reads?: { paths?: string[]; children?: string[] };
      write?: string;
      deleted?: string[];
    }> = [
      { moved: "read.txt", reads: { paths: ["read.txt"] } },
      { moved: "listed/new.txt", reads: { children: ["listed"] } },
      { moved: "out.txt", write: "out.txt" },
      { moved: "tree/inner/new.txt", deleted: ["tree"] },
    ];
    for (const change of cases) {
      const world = createWorld();
      await world.writeFile("tree/inner/x.txt", encoder.encode("x"));
      const base = (await world.head()).revision;
      await world.writeFile(change.moved, encoder.encode("concurrent"));
      const before = await world.head();
      const result = await world.commitShell({
        baseRevision: base,
        reads: {
          paths: change.reads?.paths ?? [],
          children: change.reads?.children ?? [],
        },
        entries: change.write ? [await blobEntry(world, change.write, "mine")] : [],
        deleted: change.deleted ?? [],
      });
      expect({ moved: change.moved, result }).toEqual({
        moved: change.moved,
        result: { status: "conflict", paths: [change.moved] },
      });
      expect(await world.head()).toEqual(before);
    }
  });

  test("refuses when the change log no longer reaches the base revision", async () => {
    const world = createWorld();
    const base = (await world.head()).revision;
    await world.pushDiff({
      entries: Array.from({ length: WORLD_CHANGE_LOG_MAX_ROWS + 1 }, (_, index) => ({
        path: `bulk/${String(index).padStart(5, "0")}`,
        kind: "dir" as const,
        mode: 0o755,
        size: 0,
      })),
      deleted: [],
    });
    expect(
      await world.commitShell({
        baseRevision: base,
        reads: { paths: [], children: [] },
        entries: [],
        deleted: ["unrelated"],
      }),
    ).toEqual({ status: "conflict", paths: [] });
  });

  test("reports an entry whose blob was never uploaded without applying anything", async () => {
    const world = createWorld();
    const base = (await world.head()).revision;
    const result = await world.commitShell({
      baseRevision: base,
      reads: { paths: [], children: [] },
      entries: [
        { path: "ghost.txt", kind: "file", mode: 0o644, size: 3, sha256: "0".repeat(64) },
      ],
      deleted: [],
    });
    expect(result).toEqual({ status: "missing_blobs", missingBlobs: ["0".repeat(64)] });
    expect(await world.stat("ghost.txt")).toBeNull();
    expect((await world.head()).revision).toBe(base);
  });
});
