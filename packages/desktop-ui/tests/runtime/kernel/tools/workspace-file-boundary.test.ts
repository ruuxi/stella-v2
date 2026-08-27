import { describe, expect, it } from "vitest";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleApplyPatch } from "@stella/runtime/kernel/tools/apply-patch";
import { handleRead } from "@stella/runtime/kernel/tools/file";
import { createToolHost } from "@stella/runtime/kernel/tools/host";
import { TOOL_RESULT_AUTHORIZED_IMAGES } from "@stella/runtime/kernel/tools/types";
import {
  readWorkspaceFileNoFollow,
  writeWorkspaceFileNoFollow,
} from "@stella/runtime/kernel/tools/workspace-file-boundary";

const fixture = async <T>(
  run: (paths: {
    root: string;
    workspace: string;
    privateState: string;
    secret: string;
  }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-workspace-boundary-"));
  const workspace = path.join(root, "workspace");
  const privateState = path.join(root, "private-native-state");
  const secret = path.join(privateState, "session.jsonl");
  try {
    await mkdir(workspace);
    await mkdir(privateState, { mode: 0o700 });
    await writeFile(secret, "private resume authority\n", { mode: 0o600 });
    return await run({ root, workspace, privateState, secret });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const contextFor = (workspace: string) => ({
  conversationId: "cloud-thread",
  deviceId: "cloud",
  requestId: "request-1",
  stellaAppDir: workspace,
  toolWorkspaceRoot: workspace,
  toolProcessIdentity: {
    uid: process.getuid?.() ?? 1,
    gid: process.getgid?.() ?? 1,
    user: "stella-tools",
    home: path.join(workspace, ".tool-home"),
  },
});

describe("workspace file descriptor boundary", () => {
  it("keeps cloud host startup away from model-owned recovery and shim paths", async () => {
    if (process.platform === "win32") return;
    await fixture(async ({ workspace, privateState, secret }) => {
      const modelState = path.join(workspace, ".model-state");
      const shimDir = path.join(modelState, "shell-shims");
      await mkdir(shimDir, { recursive: true });
      await symlink(secret, path.join(shimDir, "node"));
      await symlink(secret, path.join(shimDir, "git"));

      const host = createToolHost({
        stellaAppDir: workspace,
        stellaDataDir: modelState,
        recoverStaleSecrets: false,
        enableShellShims: false,
      });
      try {
        const context = { ...contextFor(workspace), storageMode: "cloud" as const };
        const code = await host.executeTool("code", { code: "1 + 1" }, context);
        expect(code.error).toContain("not available in cloud execution");

        const outside = await host.executeTool(
          "exec_command",
          { cmd: "pwd", workdir: privateState },
          context,
        );
        expect(outside.error).toContain("must stay inside the workspace");
      } finally {
        await host.shutdown();
      }
      expect(await readFile(secret, "utf8")).toBe("private resume authority\n");
    });
  });

  it("rejects shell-created symlinks before root Read or apply_patch can reach private state", async () => {
    if (process.platform === "win32") return;
    await fixture(async ({ workspace, privateState, secret }) => {
      const alias = path.join(workspace, "native-link");
      await symlink(privateState, alias);

      const read = await handleRead(
        { file_path: path.join(alias, "session.jsonl") },
        contextFor(workspace),
      );
      expect(read.error).toBeTruthy();
      expect(String(read.result ?? "")).not.toContain(
        "private resume authority",
      );

      const update = await handleApplyPatch(
        {
          input: `*** Begin Patch
*** Update File: ${path.join(alias, "session.jsonl")}
@@
-private resume authority
+corrupted
*** End Patch`,
        },
        contextFor(workspace),
      );
      expect(update.error).toBeTruthy();

      const add = await handleApplyPatch(
        {
          input: `*** Begin Patch
*** Add File: ${path.join(alias, "injected")}
+attacker
*** End Patch`,
        },
        contextFor(workspace),
      );
      expect(add.error).toBeTruthy();
      expect(await readFile(secret, "utf8")).toBe("private resume authority\n");
      await expect(
        readFile(path.join(privateState, "injected")),
      ).rejects.toThrow();
    });
  });

  it("rejects a hard-linked alias instead of trusting its workspace pathname", async () => {
    if (process.platform === "win32") return;
    await fixture(async ({ workspace, secret }) => {
      const alias = path.join(workspace, "hard-linked-state");
      await link(secret, alias);
      const read = await handleRead(
        { file_path: alias },
        contextFor(workspace),
      );
      expect(read.error).toContain("singly linked");
      expect(String(read.result ?? "")).not.toContain(
        "private resume authority",
      );
    });
  });

  it("detects pathname replacement after open and returns no private bytes", async () => {
    if (process.platform === "win32") return;
    await fixture(async ({ workspace, secret }) => {
      const target = path.join(workspace, "notes.txt");
      const moved = path.join(workspace, "notes-opened.txt");
      await writeFile(target, "ordinary workspace bytes\n");
      await expect(
        readWorkspaceFileNoFollow(target, workspace, 1_000, {
          afterOpen: async () => {
            await rename(target, moved);
            await symlink(secret, target);
          },
        }),
      ).rejects.toThrow("changed while it was being authorized");
    });
  });

  it("writes only the opened inode during a replacement race and never the private target", async () => {
    if (process.platform === "win32") return;
    await fixture(async ({ workspace, secret }) => {
      const target = path.join(workspace, "draft.txt");
      const moved = path.join(workspace, "draft-opened.txt");
      await writeFile(target, "before\n");
      await expect(
        writeWorkspaceFileNoFollow(target, workspace, "after\n", {
          hooks: {
            afterOpen: async () => {
              await rename(target, moved);
              await symlink(secret, target);
            },
          },
        }),
      ).rejects.toThrow("changed while it was being authorized");
      expect(await readFile(secret, "utf8")).toBe("private resume authority\n");
      expect(await readFile(moved, "utf8")).toBe("after\n");
    });
  });

  it("preserves ordinary scoped Read and apply_patch operations", async () => {
    await fixture(async ({ workspace }) => {
      const target = path.join(workspace, "notes.txt");
      const added = path.join(workspace, "nested", "added.txt");
      await writeFile(target, "hello\nworld\n");
      const read = await handleRead(
        { file_path: target },
        contextFor(workspace),
      );
      expect(read.error).toBeUndefined();
      expect(read.result).toContain("hello");

      const update = await handleApplyPatch(
        {
          input: `*** Begin Patch
*** Update File: ${target}
@@
-world
+stella
*** Add File: ${added}
+new file
*** End Patch`,
        },
        contextFor(workspace),
      );
      expect(update.error).toBeUndefined();
      expect(await readFile(target, "utf8")).toBe("hello\nstella\n");
      expect(await readFile(added, "utf8")).toBe("new file\n");

      const remove = await handleApplyPatch(
        {
          input: `*** Begin Patch
*** Delete File: ${added}
*** End Patch`,
        },
        contextFor(workspace),
      );
      expect(remove.error).toBeUndefined();
      await expect(readFile(added)).rejects.toThrow();
    });
  });

  it("carries descriptor-authorized image bytes without a deferred pathname reopen", async () => {
    await fixture(async ({ workspace }) => {
      const image = path.join(workspace, "pixel.png");
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(image, bytes);
      const host = createToolHost({ stellaAppDir: workspace });
      try {
        const read = await host.executeTool(
          "Read",
          { file_path: image },
          contextFor(workspace),
        );
        expect(read.error).toBeUndefined();
        expect(String(read.result)).not.toContain("[stella-attach-image]");
        const authorized = read[TOOL_RESULT_AUTHORIZED_IMAGES];
        expect(authorized).toHaveLength(1);
        expect(Buffer.from(authorized?.[0]?.data ?? [])).toEqual(bytes);
        expect(authorized?.[0]).toMatchObject({
          mimeType: "image/png",
          sourcePath: await realpath(image),
        });
        expect(JSON.stringify(read)).not.toContain(bytes.toString("base64"));
      } finally {
        await host.shutdown();
      }
    });
  });
});
