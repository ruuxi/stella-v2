import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startCliBridgeServer } from "@stella/runtime/worker/cli-bridge-server";
import {
  createSecureCliBridgeEndpoint,
  resolveRuntimePaths,
} from "@stella/runtime/worker/runtime-paths";

const roots: string[] = [];
const servers: Array<{ stop: () => Promise<void> }> = [];
const handlers = {
  requestConnectorCredential: async () => ({
    ok: false as const,
    reason: "unused",
  }),
};

const makeRoot = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "stella-cli-security-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("CLI bridge transport security", () => {
  it("uses a distinct unpredictable per-session endpoint", () => {
    const root = makeRoot();
    const paths = { ipcDir: root, rootHash: "0123456789abcdef" };
    const first = createSecureCliBridgeEndpoint(paths);
    const second = createSecureCliBridgeEndpoint(paths);
    expect(first).not.toBe(second);
    // The nonce must stay its own directory component (the 0700 dir is the
    // unpredictability barrier) and carry >= 128 bits (22 base64url chars).
    expect(path.dirname(path.dirname(first))).toBe(root);
    expect(path.basename(path.dirname(first))).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(path.basename(first)).toBe("b.sock");
  });

  it("stays under the 104-byte macOS sun_path cap for long home directories", () => {
    const longStateDir = path.join(
      "/Users/alexandra.rodriguez/Library/Application Support",
      "Stella Development/verification-state-with-a-long-name",
    );
    const paths = resolveRuntimePaths("/Applications/Stella.app", {
      platform: "darwin",
      runtimeStateDir: longStateDir,
      runtimeIpcDir: "/tmp",
    });
    const endpoint = createSecureCliBridgeEndpoint(paths, {
      platform: "darwin",
    });

    expect(path.dirname(path.dirname(endpoint))).toBe(paths.ipcDir);
    expect(endpoint).not.toContain(longStateDir);
    expect(Buffer.byteLength(endpoint, "utf8")).toBeLessThanOrEqual(103);
  });

  it("rejects nonces carrying fewer than 128 bits of entropy", () => {
    const paths = { ipcDir: makeRoot(), rootHash: "0123456789abcdef" };
    for (const nonce of ["", "abc", "a".repeat(21), "b@d!".repeat(8)]) {
      expect(() => createSecureCliBridgeEndpoint(paths, { nonce })).toThrow(
        "128 bits",
      );
    }
    // 22 base64url chars (current default) and legacy 32-hex both pass.
    expect(() =>
      createSecureCliBridgeEndpoint(paths, { nonce: "A-_b".repeat(5) + "Zz" }),
    ).not.toThrow();
    expect(() =>
      createSecureCliBridgeEndpoint(paths, {
        nonce: "0123456789abcdef0123456789abcdef",
      }),
    ).not.toThrow();
  });

  it("refuses to bind a socket path over the defensive byte ceiling", async () => {
    const root = makeRoot();
    const socketPath = path.join(root, "x".repeat(120), "b.sock");
    await expect(
      startCliBridgeServer({ socketPath, handlers }),
    ).rejects.toThrow(/exceeding the 100-byte ceiling/u);
  });

  it("advertises only after establishing 0700 directory and 0600 socket permissions", async () => {
    const root = makeRoot();
    const socketPath = path.join(root, "private", "bridge.sock");
    const server = await startCliBridgeServer({ socketPath, handlers });
    servers.push(server);
    expect((await fs.stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600);
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await expect(fs.stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when socket chmod fails", async () => {
    const root = makeRoot();
    const socketPath = path.join(root, "private", "bridge.sock");
    const realChmod = fs.chmod.bind(fs);
    vi.spyOn(fs, "chmod").mockImplementation(async (target, mode) => {
      if (String(target) === socketPath) throw new Error("chmod denied");
      return await realChmod(target, mode);
    });
    await expect(
      startCliBridgeServer({ socketPath, handlers }),
    ).rejects.toThrow("chmod denied");
  });

  it("rejects a symlinked socket directory without chmodding its target", async () => {
    const root = makeRoot();
    const target = path.join(root, "target");
    const directory = path.join(root, "private");
    await fs.mkdir(target, { mode: 0o755 });
    await fs.symlink(target, directory);
    await expect(
      startCliBridgeServer({
        socketPath: path.join(directory, "bridge.sock"),
        handlers,
      }),
    ).rejects.toThrow("socket directory is not private");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
  });

  it.each(["file", "symlink"] as const)(
    "refuses to unlink a stale %s at the advertised path",
    async (kind) => {
      const root = makeRoot();
      const directory = path.join(root, "private");
      const socketPath = path.join(directory, "bridge.sock");
      await fs.mkdir(directory, { mode: 0o700 });
      if (kind === "file") await fs.writeFile(socketPath, "not a socket");
      else await fs.symlink(path.join(root, "target"), socketPath);
      await expect(
        startCliBridgeServer({ socketPath, handlers }),
      ).rejects.toThrow("unsafe stale socket");
      expect((await fs.lstat(socketPath)).isSocket()).toBe(false);
    },
  );

  it("refuses a stale socket path reported as owned by another uid", async () => {
    if (typeof process.getuid !== "function") return;
    const root = makeRoot();
    const directory = path.join(root, "private");
    const socketPath = path.join(directory, "bridge.sock");
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(socketPath, "placeholder");
    const realLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      const stat = await realLstat(target, options as never);
      if (String(target) !== socketPath) return stat;
      return {
        ...stat,
        uid: process.getuid() + 1,
        isSymbolicLink: () => false,
        isSocket: () => true,
      } as typeof stat;
    });
    await expect(
      startCliBridgeServer({ socketPath, handlers }),
    ).rejects.toThrow("unsafe stale socket");
    expect(await fs.readFile(socketPath, "utf8")).toBe("placeholder");
  });

  it("fails closed on Windows where Node cannot establish a current-user pipe ACL", async () => {
    const pipe = createSecureCliBridgeEndpoint(
      { ipcDir: "unused", rootHash: "0123456789abcdef" },
      { platform: "win32", nonce: "0123456789abcdef0123456789abcdef" },
    );
    await expect(
      startCliBridgeServer({ socketPath: pipe, handlers }),
    ).rejects.toThrow("secure current-user named-pipe ACLs are unavailable");
  });
});
