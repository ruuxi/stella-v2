import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hydrateDriveForAgentTurn } from "./agent-turn.js";
import { materializeDriveFiles } from "./drive-sync.js";

const temporaryRoots: string[] = [];

const makeRoots = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-drive-sync-"));
  temporaryRoots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  return {
    root,
    workspaceRoot,
    stateDir: path.join(workspaceRoot, ".stella"),
  };
};

const owner = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("authoritative cloud drive hydration", () => {
  test("fails before touching a restored checkpoint when deletion history is incomplete", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "stale-file.txt"),
      "checkpoint bytes",
    );

    await expect(
      materializeDriveFiles({
        turnId: "turn-1",
        prompt: "Inspect the drive",
        workspaceRoot,
        owner,
        workspaceRestored: true,
        stateDir,
        post: async () =>
          Response.json({
            prefix: "",
            files: [],
            skipped: [],
            deleted: [],
            absent: [],
            deletedComplete: false,
            syncedAt: 10,
          }),
      }),
    ).rejects.toThrow("incomplete deletion history");
    expect(
      await readFile(path.join(workspaceRoot, "stale-file.txt"), "utf8"),
    ).toBe("checkpoint bytes");
    await expect(
      readFile(path.join(stateDir, "drive-sync.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("accepts the backend's incomplete-history marker for a builder-proven fresh workspace", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    const result = await materializeDriveFiles({
      turnId: "turn-fresh",
      prompt: "Inspect the drive",
      workspaceRoot,
      owner,
      workspaceRestored: false,
      stateDir,
      post: async () =>
        Response.json({
          prefix: "",
          files: [],
          skipped: [],
          deleted: [],
          absent: [],
          deletedComplete: false,
          syncedAt: 10,
        }),
    });

    expect(result.materialized).toEqual([]);
    expect(
      JSON.parse(await readFile(path.join(stateDir, "drive-sync.json"), "utf8"))
        .syncedAt,
    ).toBe(10);
  });

  test("propagates authoritative ledger persistence failure", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    await writeFile(stateDir, "not a directory");

    await expect(
      materializeDriveFiles({
        turnId: "turn-ledger",
        prompt: "Inspect the drive",
        workspaceRoot,
        owner,
        workspaceRestored: false,
        stateDir,
        post: async () =>
          Response.json({
            prefix: "",
            files: [],
            skipped: [],
            deleted: [],
            absent: [],
            deletedComplete: false,
            syncedAt: 10,
          }),
      }),
    ).rejects.toThrow();
  });

  test("keeps an individual unavailable drive object as an explicit skip", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    const result = await materializeDriveFiles({
      turnId: "turn-skip",
      prompt: "Inspect report.txt",
      workspaceRoot,
      owner,
      workspaceRestored: false,
      stateDir,
      post: async () =>
        Response.json({
          prefix: "",
          files: [
            {
              path: "report.txt",
              relativePath: "report.txt",
              sizeBytes: 7,
              contentType: "text/plain",
              source: "upload",
              origin: "upload",
              updatedAt: 1,
              url: "not a valid URL",
            },
          ],
          skipped: [],
          deleted: [],
          absent: [],
          deletedComplete: false,
          syncedAt: 10,
        }),
    });

    expect(result.materialized).toEqual([]);
    expect(result.known.size).toBe(0);
    expect(result.skipped).toEqual([
      {
        path: "report.txt",
        reason: "loading it into the workspace failed",
      },
    ]);
  });

  test("materializes binary bytes and its ledger as singly-linked files owned by the supplied identity", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const result = await materializeDriveFiles({
      turnId: "turn-binary",
      prompt: "Inspect nested/blob.bin",
      workspaceRoot,
      owner,
      workspaceRestored: false,
      stateDir,
      post: async () =>
        Response.json({
          prefix: "",
          files: [
            {
              path: "nested/blob.bin",
              relativePath: "nested/blob.bin",
              sizeBytes: bytes.byteLength,
              contentType: "application/octet-stream",
              source: "upload",
              origin: "upload",
              updatedAt: 1,
              sha256,
              url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
            },
          ],
          skipped: [],
          deleted: [],
          absent: [],
          deletedComplete: false,
          syncedAt: 10,
        }),
    });

    expect(result.materialized).toEqual(["nested/blob.bin"]);
    expect(
      Buffer.from(await readFile(path.join(workspaceRoot, "nested/blob.bin"))),
    ).toEqual(bytes);
    for (const file of [
      path.join(workspaceRoot, "nested/blob.bin"),
      path.join(stateDir, "drive-sync.json"),
    ]) {
      const details = await stat(file);
      expect({
        uid: details.uid,
        gid: details.gid,
        nlink: details.nlink,
      }).toEqual({ ...owner, nlink: 1 });
    }
  });

  test("refuses a drive parent symlink without writing into private state", async () => {
    const { root, workspaceRoot, stateDir } = await makeRoots();
    const privateRoot = path.join(root, "private");
    const privateFile = path.join(privateRoot, "secret.txt");
    await mkdir(privateRoot);
    await writeFile(privateFile, "private bytes");
    await symlink(privateRoot, path.join(workspaceRoot, "escape"));

    const result = await materializeDriveFiles({
      turnId: "turn-parent-symlink",
      prompt: "Inspect escape/secret.txt",
      workspaceRoot,
      owner,
      workspaceRestored: false,
      stateDir,
      post: async () =>
        Response.json({
          prefix: "",
          files: [
            {
              path: "escape/secret.txt",
              relativePath: "escape/secret.txt",
              sizeBytes: 5,
              contentType: "text/plain",
              source: "upload",
              origin: "upload",
              updatedAt: 1,
              url: "data:text/plain,drive",
            },
          ],
          skipped: [],
          deleted: [],
          absent: [],
          deletedComplete: false,
          syncedAt: 10,
        }),
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("safe owned file location");
    expect(await readFile(privateFile, "utf8")).toBe("private bytes");
  });

  test("refuses leaf symlinks and hard links without changing their targets", async () => {
    const { root, workspaceRoot, stateDir } = await makeRoots();
    const privateSymlinkTarget = path.join(root, "private-symlink.txt");
    const privateHardlinkTarget = path.join(root, "private-hardlink.txt");
    await writeFile(privateSymlinkTarget, "symlink private");
    await writeFile(privateHardlinkTarget, "hardlink private");
    await symlink(privateSymlinkTarget, path.join(workspaceRoot, "alias.txt"));
    await link(privateHardlinkTarget, path.join(workspaceRoot, "linked.txt"));

    const result = await materializeDriveFiles({
      turnId: "turn-leaf-aliases",
      prompt: "Inspect alias.txt and linked.txt",
      workspaceRoot,
      owner,
      workspaceRestored: false,
      stateDir,
      post: async () =>
        Response.json({
          prefix: "",
          files: [
            {
              path: "alias.txt",
              relativePath: "alias.txt",
              sizeBytes: 5,
              contentType: "text/plain",
              source: "upload",
              origin: "upload",
              updatedAt: 1,
              url: "data:text/plain,drive",
            },
            {
              path: "linked.txt",
              relativePath: "linked.txt",
              sizeBytes: 5,
              contentType: "text/plain",
              source: "upload",
              origin: "upload",
              updatedAt: 1,
              url: "data:text/plain,drive",
            },
          ],
          skipped: [],
          deleted: [],
          absent: [],
          deletedComplete: false,
          syncedAt: 10,
        }),
    });

    expect(result.materialized).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(await readFile(privateSymlinkTarget, "utf8")).toBe(
      "symlink private",
    );
    expect(await readFile(privateHardlinkTarget, "utf8")).toBe(
      "hardlink private",
    );
  });

  test("rejects a symlinked hydration ledger before contacting the drive", async () => {
    const { root, workspaceRoot, stateDir } = await makeRoots();
    const privateRoot = path.join(root, "private-ledger");
    const privateLedger = path.join(privateRoot, "drive-sync.json");
    await mkdir(privateRoot);
    await writeFile(privateLedger, "private ledger");
    await symlink(privateRoot, stateDir);
    let postCalls = 0;

    await expect(
      materializeDriveFiles({
        turnId: "turn-ledger-symlink",
        prompt: "Inspect the drive",
        workspaceRoot,
        owner,
        workspaceRestored: false,
        stateDir,
        post: async () => {
          postCalls += 1;
          return Response.json({});
        },
      }),
    ).rejects.toThrow();
    expect(postCalls).toBe(0);
    expect(await readFile(privateLedger, "utf8")).toBe("private ledger");
  });

  test("rejects a hard-linked hydration ledger before contacting the drive", async () => {
    const { root, workspaceRoot, stateDir } = await makeRoots();
    const privateLedger = path.join(root, "private-ledger.json");
    await mkdir(stateDir);
    await writeFile(privateLedger, JSON.stringify({ syncedAt: 1, files: {} }));
    await link(privateLedger, path.join(stateDir, "drive-sync.json"));
    let postCalls = 0;

    await expect(
      materializeDriveFiles({
        turnId: "turn-ledger-hardlink",
        prompt: "Inspect the drive",
        workspaceRoot,
        owner,
        workspaceRestored: false,
        stateDir,
        post: async () => {
          postCalls += 1;
          return Response.json({});
        },
      }),
    ).rejects.toThrow();
    expect(postCalls).toBe(0);
    expect(await readFile(privateLedger, "utf8")).toContain('"syncedAt":1');
  });

  test("deletes only the exact singly-linked hydrated inode and keeps a hard-linked alias", async () => {
    const { root, workspaceRoot, stateDir } = await makeRoots();
    const bytes = "hydrated bytes";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const removable = path.join(workspaceRoot, "removable.txt");
    const privateFile = path.join(root, "private-linked.txt");
    const linked = path.join(workspaceRoot, "linked.txt");
    await writeFile(removable, bytes);
    await writeFile(privateFile, bytes);
    await link(privateFile, linked);
    await mkdir(stateDir);
    await writeFile(
      path.join(stateDir, "drive-sync.json"),
      JSON.stringify({
        syncedAt: 1,
        checkedThrough: "",
        files: {
          "removable.txt": {
            updatedAt: 1,
            sizeBytes: Buffer.byteLength(bytes),
            sha256,
          },
          "linked.txt": {
            updatedAt: 1,
            sizeBytes: Buffer.byteLength(bytes),
            sha256,
          },
        },
      }),
    );

    const result = await materializeDriveFiles({
      turnId: "turn-tombstone",
      prompt: "Inspect the drive",
      workspaceRoot,
      owner,
      workspaceRestored: true,
      stateDir,
      post: async () =>
        Response.json({
          prefix: "",
          files: [],
          skipped: [],
          deleted: ["removable.txt", "linked.txt"],
          absent: [],
          deletedComplete: true,
          syncedAt: 2,
        }),
    });

    expect(result.deleted).toEqual(["removable.txt"]);
    expect(result.stale).toEqual(["linked.txt"]);
    await expect(readFile(removable, "utf8")).rejects.toThrow();
    expect(await readFile(linked, "utf8")).toBe(bytes);
    expect(await readFile(privateFile, "utf8")).toBe(bytes);
  });

  test("does not overwrite a hydration ledger replaced after its authorized read", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    const ledgerPath = path.join(stateDir, "drive-sync.json");
    const replacementPath = path.join(stateDir, "replacement.json");
    const replacement = "replacement ledger";
    await mkdir(stateDir);
    await writeFile(
      ledgerPath,
      JSON.stringify({ syncedAt: 1, checkedThrough: "", files: {} }),
    );
    await writeFile(replacementPath, replacement);

    await expect(
      materializeDriveFiles({
        turnId: "turn-ledger-race",
        prompt: "Inspect the drive",
        workspaceRoot,
        owner,
        workspaceRestored: true,
        stateDir,
        post: async () => {
          await rename(replacementPath, ledgerPath);
          return Response.json({
            prefix: "",
            files: [],
            skipped: [],
            deleted: [],
            absent: [],
            deletedComplete: true,
            syncedAt: 2,
          });
        },
      }),
    ).rejects.toThrow("changed after it was authorized");
    expect(await readFile(ledgerPath, "utf8")).toBe(replacement);
  });

  test("does not overwrite a replacement raced in after the authorized hash", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    const target = path.join(workspaceRoot, "report.txt");
    const replacement = path.join(workspaceRoot, "replacement.txt");
    const oldBytes = "drive-old";
    const newBytes = "drive-new";
    const racedBytes = "raced replacement";
    await writeFile(target, oldBytes);
    await writeFile(replacement, racedBytes);
    await mkdir(stateDir);
    await writeFile(
      path.join(stateDir, "drive-sync.json"),
      JSON.stringify({
        syncedAt: 1,
        checkedThrough: "",
        files: {
          "report.txt": {
            updatedAt: 1,
            sizeBytes: Buffer.byteLength(oldBytes),
            sha256: createHash("sha256").update(oldBytes).digest("hex"),
          },
        },
      }),
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await rename(replacement, target);
        return new Response(newBytes);
      },
    });
    try {
      const result = await materializeDriveFiles({
        turnId: "turn-race",
        prompt: "Inspect report.txt",
        workspaceRoot,
        owner,
        workspaceRestored: true,
        stateDir,
        post: async () =>
          Response.json({
            prefix: "",
            files: [
              {
                path: "report.txt",
                relativePath: "report.txt",
                sizeBytes: Buffer.byteLength(newBytes),
                contentType: "text/plain",
                source: "upload",
                origin: "upload",
                updatedAt: 2,
                url: `http://127.0.0.1:${server.port}/report.txt`,
              },
            ],
            skipped: [],
            deleted: [],
            absent: [],
            deletedComplete: true,
            syncedAt: 2,
          }),
      });

      expect(result.materialized).toEqual([]);
      expect(result.skipped[0]?.reason).toContain(
        "loading it into the workspace failed",
      );
      expect(await readFile(target, "utf8")).toBe(racedBytes);
    } finally {
      server.stop(true);
    }
  });

  test("turn hydration propagates systemic sync failure instead of returning an empty drive", async () => {
    const { workspaceRoot, stateDir } = await makeRoots();
    await expect(
      hydrateDriveForAgentTurn(
        {
          turnId: "turn-2",
          prompt: "Use report.pdf",
          workspaceRoot,
          owner,
          workspaceRestored: false,
          stateDir,
          post: async () => Response.json({}),
        },
        async () => {
          throw new Error("manifest unavailable");
        },
      ),
    ).rejects.toThrow(
      "refusing to run the agent against stale or incomplete files: manifest unavailable",
    );
  });
});
