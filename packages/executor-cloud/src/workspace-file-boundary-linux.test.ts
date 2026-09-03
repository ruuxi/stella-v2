import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleApplyPatch } from "@stella/runtime/kernel/tools/apply-patch.js";
import { handleRead } from "@stella/runtime/kernel/tools/file.js";
import { readWorkspaceFileNoFollow } from "@stella/runtime/kernel/tools/workspace-file-boundary.js";
import type { ToolContext } from "@stella/runtime/kernel/tools/types.js";

import { CLOUD_TOOL_PROCESS_IDENTITY } from "./agent-turn.js";

type ChildResult = { code: number | null; stdout: string; stderr: string };

const runAsTool = async (
  command: string,
  args: string[],
): Promise<ChildResult> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      uid: CLOUD_TOOL_PROCESS_IDENTITY.uid,
      gid: CLOUD_TOOL_PROCESS_IDENTITY.gid,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

const digest = async (filePath: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

describe("real Linux cloud workspace privilege boundary", () => {
  test("UID 42424 cannot make root Read/apply_patch follow workspace aliases into native state", async () => {
    if (process.platform !== "linux" || process.getuid?.() !== 0) return;

    const root = await mkdtemp(path.join(tmpdir(), "stella-linux-boundary-"));
    const workspace = path.join(root, "workspace");
    const nativeState = path.join(root, "native-state");
    const secret = path.join(nativeState, "session.jsonl");
    const ordinary = path.join(workspace, "notes.txt");
    const parentAlias = path.join(workspace, "native-link");
    const finalAlias = path.join(workspace, "session-link");
    const hardAlias = path.join(workspace, "hard-link");
    const owner = {
      uid: CLOUD_TOOL_PROCESS_IDENTITY.uid,
      gid: CLOUD_TOOL_PROCESS_IDENTITY.gid,
    };
    const context: ToolContext = {
      executionHost: "sandbox",
      conversationId: "linux-boundary",
      deviceId: "cloud",
      requestId: "request-1",
      agentType: "general",
      workingDirectory: workspace,
      stellaAppDir: workspace,
      toolWorkspaceRoot: workspace,
      toolProcessIdentity: {
        ...CLOUD_TOOL_PROCESS_IDENTITY,
        home: path.join(workspace, ".tool-home"),
      },
    };

    try {
      await chown(root, 0, owner.gid);
      await chmod(root, 0o750);
      await mkdir(workspace, { mode: 0o750 });
      await chown(workspace, owner.uid, owner.gid);
      await mkdir(nativeState, { mode: 0o700 });
      await Bun.write(secret, "private resume authority\n");
      await chmod(secret, 0o600);
      const originalDigest = await digest(secret);

      const setup = await runAsTool("/bin/sh", [
        "-c",
        'printf "ordinary workspace bytes\\n" > "$1"; ln -s "$2" "$3"; ln -s "$4" "$5"',
        "stella-tools",
        ordinary,
        nativeState,
        parentAlias,
        secret,
        finalAlias,
      ]);
      expect(setup).toMatchObject({ code: 0, stderr: "" });

      const capabilities = await runAsTool("/bin/sh", [
        "-c",
        "grep '^CapEff:' /proc/self/status",
      ]);
      expect(capabilities.code).toBe(0);
      expect(capabilities.stdout.trim()).toBe("CapEff:\t0000000000000000");
      const directRead = await runAsTool("/bin/cat", [secret]);
      expect(directRead.code).not.toBe(0);
      expect(directRead.stdout).toBe("");

      const ordinaryRead = await handleRead({ file_path: ordinary }, context);
      expect(ordinaryRead.error).toBeUndefined();
      expect(String(ordinaryRead.result)).toContain("ordinary workspace bytes");

      for (const alias of [
        path.join(parentAlias, "session.jsonl"),
        finalAlias,
      ]) {
        const result = await handleRead({ file_path: alias }, context);
        expect(result.error).toBeTruthy();
        expect(JSON.stringify(result)).not.toContain(
          "private resume authority",
        );
      }

      const aliasPatch = await handleApplyPatch(
        {
          input: `*** Begin Patch
*** Update File: ${path.join(parentAlias, "session.jsonl")}
@@
-private resume authority
+corrupted
*** End Patch`,
        },
        context,
      );
      expect(aliasPatch.error).toBeTruthy();

      await link(secret, hardAlias);
      const hardRead = await handleRead({ file_path: hardAlias }, context);
      expect(hardRead.error).toContain("singly linked");

      const added = path.join(workspace, "nested", "added.txt");
      const ordinaryPatch = await handleApplyPatch(
        {
          input: `*** Begin Patch
*** Update File: ${ordinary}
@@
-ordinary workspace bytes
+updated workspace bytes
*** Add File: ${added}
+new file
*** End Patch`,
        },
        context,
      );
      expect(ordinaryPatch.error).toBeUndefined();
      expect(await readFile(ordinary, "utf8")).toBe(
        "updated workspace bytes\n",
      );
      expect(await readFile(added, "utf8")).toBe("new file\n");
      expect(await lstat(path.dirname(added))).toMatchObject(owner);
      expect(await lstat(added)).toMatchObject(owner);

      const opened = path.join(workspace, "opened.txt");
      await rename(ordinary, opened);
      await rename(opened, ordinary);
      await expect(
        readWorkspaceFileNoFollow(ordinary, workspace, 1_000, {
          owner,
          afterOpen: async () => {
            await rename(ordinary, opened);
            await symlink(secret, ordinary);
          },
        }),
      ).rejects.toThrow("changed while it was being authorized");

      expect(await digest(secret)).toBe(originalDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
