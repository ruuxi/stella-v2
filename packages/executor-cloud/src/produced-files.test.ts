import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolProcessIdentity } from "@stella/runtime/kernel/tools/types.js";
import {
  buildProducedFilesGitCheckIgnoreLaunch,
  collectProducedFiles,
  reportProducedFiles,
  type ProducedFileReport,
} from "./produced-files.js";

const temporaryRoots: string[] = [];
const TEST_UID = process.getuid?.() ?? 0;
const TEST_GID = process.getgid?.() ?? 0;

const makeFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-produced-files-"));
  temporaryRoots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const toolHome = path.join(root, "tool-home");
  await mkdir(workspaceRoot, { mode: 0o750 });
  await mkdir(toolHome, { mode: 0o700 });
  const processIdentity: ToolProcessIdentity = {
    uid: TEST_UID,
    gid: TEST_GID,
    home: toolHome,
    user: "stella-test-tools",
    requireNoNewPrivileges: true,
  };
  return { root, workspaceRoot, processIdentity };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("cloud produced-file boundary", () => {
  test("delivers descriptor-authorized bytes after the workspace path is swapped", async () => {
    const { root, workspaceRoot, processIdentity } = await makeFixture();
    const outputPath = path.join(workspaceRoot, "answer.txt");
    const movedPath = path.join(workspaceRoot, "answer.original.txt");
    const outsidePath = path.join(root, "private.txt");
    await writeFile(outputPath, "authorized answer");
    await writeFile(outsidePath, "private executor bytes");

    const collected = await collectProducedFiles({
      workspaceRoot,
      processIdentity,
      edited: [{ path: outputPath, kind: { type: "add" } }],
      detected: [],
      gitAware: false,
      drivePrefix: "",
    });
    expect(collected.files).toHaveLength(1);
    // The trusted byte carrier must not leak into events or ordinary spreads.
    expect(Object.keys(collected.files[0]!)).toEqual([
      "path",
      "name",
      "sizeBytes",
      "contentType",
    ]);
    expect(JSON.stringify(collected.files[0])).not.toContain(
      "authorized answer",
    );

    await rename(outputPath, movedPath);
    await symlink(outsidePath, outputPath);

    let posted: Record<string, unknown> | undefined;
    const delivery = await reportProducedFiles({
      turnId: "turn-1",
      files: collected.files,
      post: async (route, body) => {
        expect(route).toBe("/api/cloud/drive/files");
        posted = body as Record<string, unknown>;
        return Response.json({
          files: [{ path: "answer.txt", stored: true }],
        });
      },
    });

    const entries = posted?.files as
      | Array<{ contentBase64?: string }>
      | undefined;
    expect(entries).toHaveLength(1);
    expect(Buffer.from(entries![0]!.contentBase64!, "base64").toString()).toBe(
      "authorized answer",
    );
    expect(delivery.stored).toEqual(new Set(["answer.txt"]));
  });

  test("rejects symlinked and hard-linked candidates before authorization", async () => {
    const { root, workspaceRoot, processIdentity } = await makeFixture();
    const outsidePath = path.join(root, "private.txt");
    const symlinkPath = path.join(workspaceRoot, "symlink.txt");
    const linkedPath = path.join(workspaceRoot, "linked.txt");
    const linkedAlias = path.join(workspaceRoot, "linked-alias.txt");
    await writeFile(outsidePath, "private executor bytes");
    await symlink(outsidePath, symlinkPath);
    await writeFile(linkedPath, "not singly linked");
    await link(linkedPath, linkedAlias);

    const collected = await collectProducedFiles({
      workspaceRoot,
      processIdentity,
      edited: [
        { path: symlinkPath, kind: { type: "add" } },
        { path: linkedPath, kind: { type: "add" } },
      ],
      detected: [],
      gitAware: false,
      drivePrefix: "",
    });

    expect(collected.files).toEqual([]);
  });

  test("never falls back to an attacker-controlled sourcePath", async () => {
    const { root } = await makeFixture();
    const outsidePath = path.join(root, "private.txt");
    const privateBytes = "private executor bytes";
    await writeFile(outsidePath, privateBytes);
    const legacyPathReport = {
      path: "answer.txt",
      name: "answer.txt",
      sizeBytes: Buffer.byteLength(privateBytes),
      contentType: "text/plain",
      sourcePath: outsidePath,
    } as ProducedFileReport & { sourcePath: string };

    let posted: Record<string, unknown> | undefined;
    await reportProducedFiles({
      turnId: "turn-2",
      files: [legacyPathReport],
      post: async (_route, body) => {
        posted = body as Record<string, unknown>;
        return Response.json({ files: [] });
      },
    });

    const entries = posted?.files as
      | Array<{ contentBase64?: string }>
      | undefined;
    expect(entries).toHaveLength(1);
    expect(entries![0]!.contentBase64).toBeUndefined();
  });

  test("builds git check-ignore behind the fixed strict setpriv trampoline", () => {
    const identity: ToolProcessIdentity = {
      uid: 42_424,
      gid: 42_424,
      home: "/workspace/.stella/tool-home",
      user: "stella-tools",
      requireNoNewPrivileges: true,
    };
    const launch = buildProducedFilesGitCheckIgnoreLaunch(identity, "linux");

    expect(launch.command).toBe("/usr/bin/setpriv");
    expect(launch.nativeIdentity).toBeUndefined();
    expect(launch.args).toEqual([
      "--reuid=42424",
      "--regid=42424",
      "--clear-groups",
      "--no-new-privs",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      "/usr/bin/git",
      "check-ignore",
      "--stdin",
      "-z",
    ]);
    expect(() =>
      buildProducedFilesGitCheckIgnoreLaunch(
        { ...identity, requireNoNewPrivileges: undefined },
        "linux",
      ),
    ).toThrow("strict tool identity");
  });
});
