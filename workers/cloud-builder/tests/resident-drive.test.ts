import { describe, expect, test } from "bun:test";
import {
  hydrateResidentDrive,
  type ResidentDriveWorld,
} from "../src/resident-drive.js";
import { sha256BytesHex } from "../src/hash.js";
import type { WorldEntry } from "../src/world/types.js";

const encode = (text: string) => new TextEncoder().encode(text);
const harness = async (seed: Record<string, string> = {}) => {
  const entries = new Map<string, WorldEntry>();
  const blobs = new Map<string, Uint8Array>();
  let commits = 0;
  let conflict = false;
  const seedFile = async (path: string, text: string) => {
    const bytes = encode(text);
    const sha256 = await sha256BytesHex(bytes);
    entries.set(path, {
      path,
      kind: "file",
      mode: 0o644,
      mtime: 0,
      size: bytes.length,
      sha256,
    });
    blobs.set(sha256, bytes);
  };
  for (const [path, text] of Object.entries(seed)) await seedFile(path, text);
  const world: ResidentDriveWorld = {
    head: async () => ({ revision: 7 }),
    stat: async (path) => entries.get(path) ?? null,
    list: async (prefix, options) => {
      const listed = [...entries.values()]
        .filter(
          (entry) =>
            entry.path === prefix || entry.path.startsWith(`${prefix}/`),
        )
        .sort((a, b) => a.path.localeCompare(b.path));
      return {
        entries: listed.slice(0, options.limit),
        ...(listed.length > options.limit
          ? { cursor: listed[options.limit - 1]!.path }
          : {}),
      };
    },
    readFile: async (path) =>
      blobs.get(entries.get(path)?.sha256 ?? "") ?? null,
    putBlob: async (stream, input) => {
      blobs.set(
        input.sha256,
        new Uint8Array(await new Response(stream).arrayBuffer()),
      );
    },
    commitShell: async (change) => {
      commits++;
      if (change.reads.children.length) {
        expect(change.reads.children).toContain("");
        expect(change.reads.children).toContain("drive");
      }
      expect(change.baseRevision).toBe(7);
      expect(change.reads.paths).toContain("drive/.stella/drive-sync.json");
      if (conflict) return { status: "conflict" };
      for (const path of change.deleted) entries.delete(path);
      for (const entry of change.entries)
        entries.set(entry.path, { ...entry, mtime: 0 });
      return { status: "committed" };
    },
  };
  const manifest = (files: unknown[], extras = {}) => ({
    files,
    prefix: "",
    skipped: [],
    deleted: [],
    absent: [],
    syncedAt: 20,
    deletedComplete: true,
    ...extras,
  });
  const run = (
    files: unknown[],
    extras = {},
    fetchImpl: typeof fetch = (async () =>
      new Response("hello")) as typeof fetch,
  ) =>
    hydrateResidentDrive({
      world,
      post: async () => Response.json(manifest(files, extras)),
      turnId: "turn-1",
      prompt: "read uploads/a.txt",
      fetchImpl,
    });
  const row = (path = "uploads/a.txt", sizeBytes = 5, updatedAt = 10) => ({
    path,
    relativePath: path,
    sizeBytes,
    updatedAt,
    url: "https://drive.test/a",
  });
  return {
    world,
    entries,
    blobs,
    run,
    row,
    seedFile,
    conflict: () => {
      conflict = true;
    },
    commits: () => commits,
  };
};

describe("resident drive hydration", () => {
  test("publishes uploads and the compatible sandbox ledger in one commit", async () => {
    const h = await harness();
    expect(await h.run([h.row()])).toEqual(new Map([["uploads/a.txt", 10]]));
    expect(
      new TextDecoder().decode(
        (await h.world.readFile("drive/uploads/a.txt"))!,
      ),
    ).toBe("hello");
    const ledger = JSON.parse(
      new TextDecoder().decode(
        (await h.world.readFile("drive/.stella/drive-sync.json"))!,
      ),
    );
    expect(ledger.files["uploads/a.txt"].updatedAt).toBe(10);
    expect(ledger.files["uploads/a.txt"].sha256).toBe(
      await sha256BytesHex(encode("hello")),
    );
    expect(h.commits()).toBe(1);
    expect(h.entries.get("drive/uploads")?.kind).toBe("dir");
  });

  test("a real first-sync manifest with incomplete deletion history hydrates a fresh drive", async () => {
    const h = await harness();
    expect(await h.run([h.row()], { deletedComplete: false })).toEqual(
      new Map([["uploads/a.txt", 10]]),
    );
    expect(
      new TextDecoder().decode(
        (await h.world.readFile("drive/uploads/a.txt"))!,
      ),
    ).toBe("hello");
    expect(h.commits()).toBe(1);
  });

  test("full presence coverage reconciles an old ledger despite incomplete deletion replay", async () => {
    const h = await harness();
    await h.run([h.row()]);
    await h.run([], { deletedComplete: false, absent: ["uploads/a.txt"] });
    expect(await h.world.stat("drive/uploads/a.txt")).toBeNull();
    expect(h.commits()).toBe(2);
  });

  test("an incomplete deletion replay cannot advance a ledger with unchecked paths", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `uploads/${index}.txt`,
        { updatedAt: 10, sizeBytes: 5, sha256: "a".repeat(64) },
      ]),
    );
    const h = await harness({
      "drive/.stella/drive-sync.json": JSON.stringify({ files, syncedAt: 0 }),
    });
    await expect(h.run([], { deletedComplete: false })).rejects.toThrow(
      "full sandbox reconciliation",
    );
    expect(h.commits()).toBe(0);
    const ledger = JSON.parse(
      new TextDecoder().decode(
        (await h.world.readFile("drive/.stella/drive-sync.json"))!,
      ),
    );
    expect(ledger.syncedAt).toBe(0);
  });

  test("a missing ledger cannot hide a stale drive copy beyond the tombstone window", async () => {
    const h = await harness({ "drive/uploads/deleted.txt": "old user file" });
    await expect(h.run([], { deletedComplete: false })).rejects.toThrow(
      "unaccounted workspace files",
    );
    expect(h.commits()).toBe(0);
    expect(await h.world.readFile("drive/uploads/deleted.txt")).not.toBeNull();
    expect(await h.world.stat("drive/.stella/drive-sync.json")).toBeNull();
  });

  test("a partial ledger cannot hide undelivered files during incomplete replay", async () => {
    const h = await harness();
    await h.run([h.row()]);
    await h.seedFile("drive/undelivered.txt", "agent work");
    await expect(h.run([h.row()], { deletedComplete: false })).rejects.toThrow(
      "unaccounted workspace files",
    );
    expect(
      new TextDecoder().decode(
        (await h.world.readFile("drive/undelivered.txt"))!,
      ),
    ).toBe("agent work");
    expect(h.commits()).toBe(1);
  });

  test("download overflow cannot publish either a partial file or ledger", async () => {
    const h = await harness();
    await expect(
      h.run(
        [h.row()],
        {},
        (async () => new Response("too long")) as typeof fetch,
      ),
    ).rejects.toThrow("declared size");
    expect(h.entries.size).toBe(0);
    expect(h.commits()).toBe(0);
  });

  test("oversized files and omitted manifest rows require sandbox hydration", async () => {
    const h = await harness();
    await expect(
      h.run([h.row("large.bin", 8 * 1024 * 1024 + 1)]),
    ).rejects.toThrow("sandbox");
    await expect(h.run([], { skipped: [{ path: "a.txt" }] })).rejects.toThrow(
      "resident limits",
    );
    expect(h.commits()).toBe(0);
  });

  test("workspace races refuse the whole hydration transaction", async () => {
    const h = await harness();
    h.conflict();
    await expect(h.run([h.row()])).rejects.toThrow("changed during hydration");
    expect(h.entries.size).toBe(0);
  });

  test("a locally edited uploaded row is preserved until the drive changes", async () => {
    const h = await harness();
    await h.run([h.row()]);
    await h.seedFile("drive/uploads/a.txt", "edited");
    expect(
      await h.run([h.row()], {}, (async () => {
        throw new Error("must not download");
      }) as typeof fetch),
    ).toEqual(new Map([["uploads/a.txt", 10]]));
    await expect(h.run([h.row("uploads/a.txt", 5, 11)])).rejects.toThrow(
      "both changed",
    );
    expect(
      new TextDecoder().decode(
        (await h.world.readFile("drive/uploads/a.txt"))!,
      ),
    ).toBe("edited");
  });

  test("deletions require the ledger hash and protect divergent workspace edits", async () => {
    const h = await harness();
    await h.run([h.row()]);
    await h.run([], { absent: ["uploads/a.txt"] });
    expect(await h.world.stat("drive/uploads/a.txt")).toBeNull();
    await h.run([h.row()]);
    await h.seedFile("drive/uploads/a.txt", "edited");
    await expect(
      h.run([], {
        deleted: [{ path: "uploads/a.txt", relativePath: "uploads/a.txt" }],
      }),
    ).rejects.toThrow("workspace edits");
    expect(await h.world.stat("drive/uploads/a.txt")).not.toBeNull();
  });

  test("paths with traversal or symlink ancestors never receive downloads", async () => {
    const h = await harness();
    await expect(h.run([h.row("../a.txt")])).rejects.toThrow(
      "Invalid world-relative",
    );
    h.entries.set("drive/uploads", {
      path: "drive/uploads",
      kind: "symlink",
      mode: 0o777,
      mtime: 0,
      size: 0,
      target: "/etc",
    });
    await expect(h.run([h.row()])).rejects.toThrow("non-directory ancestor");
    expect(h.commits()).toBe(0);
  });
});
