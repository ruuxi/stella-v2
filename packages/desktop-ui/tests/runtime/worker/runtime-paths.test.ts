import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSecureCliBridgeEndpoint,
  ensurePrivateRuntimeIpcDir,
  ensureRuntimeIpcDir,
  isWindowsNamedPipePath,
  resolveRuntimePaths,
  runtimeIpcListenUrl,
  runtimeIpcPathUsesFilesystem,
} from "@stella/runtime/worker/runtime-paths";

const tempRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("resolveRuntimePaths", () => {
  it("keeps runtime control files and logs under explicit Electron userData", () => {
    const runtimeStateDir = path.join(
      "/Users/test",
      ".stella",
      "electron-user-data",
    );
    const paths = resolveRuntimePaths("/Users/test/stella-v2", {
      platform: "darwin",
      runtimeStateDir,
    });

    expect(paths.rootDir).toBe(
      path.join(runtimeStateDir, "runtime", paths.rootHash),
    );
    expect(paths.logDir).toBe(
      path.join(runtimeStateDir, "logs", paths.rootHash),
    );
    expect(paths.rootDir).toContain(runtimeStateDir);
    expect(paths.logDir).toContain(runtimeStateDir);
    expect(paths.socketPath).not.toContain(runtimeStateDir);
  });

  it("uses the Electron-provided runtime root inherited by the worker", () => {
    const previous = process.env.STELLA_RUNTIME_STATE_DIR;
    const runtimeStateDir = "/tmp/stella-v2-electron-user-data";
    process.env.STELLA_RUNTIME_STATE_DIR = runtimeStateDir;
    try {
      const paths = resolveRuntimePaths("/Users/test/stella-v2", {
        platform: "darwin",
        runtimeIpcDir: "/tmp",
      });
      expect(paths.rootDir).toBe(
        path.join(runtimeStateDir, "runtime", paths.rootHash),
      );
      expect(paths.logDir).toBe(
        path.join(runtimeStateDir, "logs", paths.rootHash),
      );
    } finally {
      if (previous === undefined) {
        delete process.env.STELLA_RUNTIME_STATE_DIR;
      } else {
        process.env.STELLA_RUNTIME_STATE_DIR = previous;
      }
    }
  });

  it("uses filesystem socket paths on POSIX platforms", () => {
    const paths = resolveRuntimePaths("/Users/test/stella", {
      platform: "darwin",
      homeDir: "/Users/test",
    });

    expect(paths.socketPath).toBe(path.join(paths.ipcDir, "r.sock"));
    expect(paths.cliBridgeSocketPath).toBe(path.join(paths.ipcDir, "c.sock"));
    expect(runtimeIpcPathUsesFilesystem(paths.socketPath)).toBe(true);
    expect(runtimeIpcListenUrl(paths.socketPath)).toBe(
      `unix://${paths.socketPath}`,
    );
  });

  it("keeps every macOS socket path below the BSD sun_path byte cap", () => {
    for (const runtimeStateDir of [
      "/Users/rahulnanda/.stella/electron-user-data",
      "/tmp/stella-v2-isolated/electron-user-data",
    ]) {
      const paths = resolveRuntimePaths(
        "/Users/rahulnanda/projects/stella-v2",
        {
          platform: "darwin",
          runtimeStateDir,
          runtimeIpcDir: "/tmp",
        },
      );
      const secureBridge = createSecureCliBridgeEndpoint(paths, {
        platform: "darwin",
        nonce: "0123456789abcdef0123456789abcdef",
      });
      for (const socketPath of [
        paths.socketPath,
        paths.cliBridgeSocketPath,
        secureBridge,
      ]) {
        expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThan(104);
      }
    }
  });

  it("ignores inherited IPC-root overrides that point at the packaged home", () => {
    const previous = process.env.STELLA_RUNTIME_IPC_DIR;
    process.env.STELLA_RUNTIME_IPC_DIR = "/Users/test/.stella";
    try {
      const paths = resolveRuntimePaths("/Users/test/stella-v2", {
        platform: "darwin",
        runtimeStateDir: "/tmp/stella-runtime-state",
      });
      expect(paths.ipcDir.startsWith("/tmp/stella-")).toBe(true);
      expect(paths.ipcDir).not.toContain("/Users/test/.stella");
    } finally {
      if (previous === undefined) {
        delete process.env.STELLA_RUNTIME_IPC_DIR;
      } else {
        process.env.STELLA_RUNTIME_IPC_DIR = previous;
      }
    }
  });

  it("rejects symlinked and permissive predictable IPC namespaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-ipc-root-"));
    tempRoots.add(root);
    const target = path.join(root, "target");
    await mkdir(target, { mode: 0o700 });

    const symlinkBase = path.join(root, "symlink-base");
    await mkdir(symlinkBase, { mode: 0o700 });
    const symlinkPaths = resolveRuntimePaths("/tmp/stella-v2", {
      platform: "darwin",
      runtimeStateDir: path.join(root, "state"),
      runtimeIpcDir: symlinkBase,
    });
    await symlink(target, path.dirname(symlinkPaths.ipcDir), "dir");
    await expect(
      ensurePrivateRuntimeIpcDir(symlinkPaths.ipcDir),
    ).rejects.toThrow("not a private owner-only directory");

    const permissiveBase = path.join(root, "permissive-base");
    await mkdir(permissiveBase, { mode: 0o700 });
    const permissivePaths = resolveRuntimePaths("/tmp/stella-v2", {
      platform: "darwin",
      runtimeStateDir: path.join(root, "state"),
      runtimeIpcDir: permissiveBase,
    });
    await mkdir(path.dirname(permissivePaths.ipcDir), { mode: 0o755 });
    await expect(
      ensurePrivateRuntimeIpcDir(permissivePaths.ipcDir),
    ).rejects.toThrow("not a private owner-only directory");
  });

  it("uses named pipes on Windows", () => {
    const paths = resolveRuntimePaths("C:\\Users\\test\\Stella", {
      platform: "win32",
      homeDir: "C:\\Users\\test",
    });

    expect(paths.socketPath).toMatch(
      /^\\\\\.\\pipe\\stella-runtime-[a-f0-9]{16}$/,
    );
    expect(paths.cliBridgeSocketPath).toMatch(
      /^\\\\\.\\pipe\\stella-cli-bridge-[a-f0-9]{16}$/,
    );
    expect(isWindowsNamedPipePath(paths.socketPath)).toBe(true);
    expect(runtimeIpcPathUsesFilesystem(paths.socketPath)).toBe(false);
    expect(runtimeIpcListenUrl(paths.socketPath)).toBe(
      `pipe://${paths.socketPath}`,
    );
  });

  it("does not require a POSIX IPC directory for Windows named pipes", async () => {
    const paths = resolveRuntimePaths("C:\\Users\\test\\Stella", {
      platform: "win32",
      runtimeStateDir: "C:\\Users\\test\\AppData\\Roaming\\Stella",
      runtimeIpcDir: "Z:\\must-not-be-created",
    });
    await expect(ensureRuntimeIpcDir(paths)).resolves.toBeUndefined();
  });
});
