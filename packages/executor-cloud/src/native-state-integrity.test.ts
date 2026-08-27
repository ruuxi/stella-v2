import { describe, expect, it } from "bun:test";
import {
  chown,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  NATIVE_STATE_ATTESTATION_FILE,
  assertFreshNativeState,
  assertNativeState,
  sealNativeState,
} from "./native-state-integrity.js";

const INTEGRITY_KEY = "9".repeat(64);
const TEST_OWNER = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
};

const withStateFixture = async (
  test: (stateRoot: string) => Promise<void>,
): Promise<void> => {
  const parent = await mkdtemp(path.join(tmpdir(), "stella-native-state-"));
  const stateRoot = path.join(parent, "anthropic");
  try {
    await mkdir(path.join(stateRoot, "projects", "thread"), {
      recursive: true,
      mode: 0o700,
    });
    await chmod(stateRoot, 0o700);
    await writeFile(path.join(stateRoot, "session-started"), "session-1\n", {
      mode: 0o600,
    });
    await writeFile(
      path.join(stateRoot, "projects", "thread", "conversation.jsonl"),
      '{"role":"assistant","content":"durable"}\n',
      { mode: 0o600 },
    );
    await test(stateRoot);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
};

const sealFixture = (stateRoot: string) =>
  sealNativeState({
    stateRoot,
    engine: "anthropic",
    threadId: "thread-1",
    sessionId: "session-1",
    cursor: "v1:cursor-1",
    integrityKey: INTEGRITY_KEY,
    expectedOwner: TEST_OWNER,
  });

const assertFixture = (stateRoot: string) =>
  assertNativeState({
    stateRoot,
    engine: "anthropic",
    threadId: "thread-1",
    sessionId: "session-1",
    expectedCursor: "v1:cursor-1",
    integrityKey: INTEGRITY_KEY,
    expectedOwner: TEST_OWNER,
  });

describe("native state integrity", () => {
  it("binds the complete resumable tree and accepts its exact checkpoint", async () => {
    await withStateFixture(async (stateRoot) => {
      const sealed = await sealFixture(stateRoot);
      expect(sealed.version).toBe(2);
      expect(sealed.tree.entries).toBe(5);
      expect(sealed.tree.bytes).toBeGreaterThan(0);
      expect(sealed.tree.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(sealed.mac).toMatch(/^[0-9a-f]{64}$/);

      const verified = await assertFixture(stateRoot);
      expect(verified).toEqual(sealed);
    });
  });

  it("rejects changed, added, removed, renamed, and permission-altered state", async () => {
    const mutations: Array<(stateRoot: string) => Promise<void>> = [
      async (stateRoot) => {
        await writeFile(path.join(stateRoot, "session-started"), "session-2\n");
      },
      async (stateRoot) => {
        await writeFile(path.join(stateRoot, "injected"), "attacker", {
          mode: 0o600,
        });
      },
      async (stateRoot) => {
        await unlink(
          path.join(stateRoot, "projects", "thread", "conversation.jsonl"),
        );
      },
      async (stateRoot) => {
        const source = path.join(
          stateRoot,
          "projects",
          "thread",
          "conversation.jsonl",
        );
        const contents = await readFile(source);
        await unlink(source);
        await writeFile(
          path.join(stateRoot, "projects", "thread", "moved"),
          contents,
          { mode: 0o600 },
        );
      },
      async (stateRoot) => {
        await chmod(
          path.join(stateRoot, "projects", "thread", "conversation.jsonl"),
          0o644,
        );
      },
    ];

    for (const mutate of mutations) {
      await withStateFixture(async (stateRoot) => {
        await sealFixture(stateRoot);
        await mutate(stateRoot);
        await expect(assertFixture(stateRoot)).rejects.toThrow(
          /state bytes have changed|permissions 0600/,
        );
      });
    }
  });

  it("rejects a symlink instead of signing state outside the checkpoint", async () => {
    await withStateFixture(async (stateRoot) => {
      const external = path.join(path.dirname(stateRoot), "agent-writable");
      await writeFile(external, "mutable");
      await symlink(external, path.join(stateRoot, "workspace-state"));
      await expect(sealFixture(stateRoot)).rejects.toThrow(
        "forbidden symbolic link",
      );
    });
  });

  it("rejects hard-linked state instead of signing a shared inode", async () => {
    await withStateFixture(async (stateRoot) => {
      const source = path.join(
        stateRoot,
        "projects",
        "thread",
        "conversation.jsonl",
      );
      await link(source, path.join(stateRoot, "shared-conversation.jsonl"));
      await expect(sealFixture(stateRoot)).rejects.toThrow(
        "forbidden hard link",
      );
    });
  });

  it("hardens CLI-created permissions before binding the checkpoint", async () => {
    await withStateFixture(async (stateRoot) => {
      const looseDirectory = path.join(stateRoot, "loose-directory");
      const looseFile = path.join(looseDirectory, "config.json");
      await mkdir(looseDirectory, { mode: 0o755 });
      await writeFile(looseFile, "{}\n", { mode: 0o644 });

      await sealFixture(stateRoot);

      expect((await lstat(stateRoot)).mode & 0o7777).toBe(0o700);
      expect((await lstat(looseDirectory)).mode & 0o7777).toBe(0o700);
      expect((await lstat(looseFile)).mode & 0o7777).toBe(0o600);
      expect(
        (await lstat(path.join(stateRoot, NATIVE_STATE_ATTESTATION_FILE)))
          .mode & 0o7777,
      ).toBe(0o600);
      await expect(assertFixture(stateRoot)).resolves.toBeDefined();
    });
  });

  it("rejects foreign ownership instead of silently legitimizing it", async () => {
    await withStateFixture(async (stateRoot) => {
      const uid = TEST_OWNER.uid;
      const gid = TEST_OWNER.gid;
      const alternateGid =
        uid === 0
          ? gid === 1
            ? 2
            : 1
          : process.getgroups?.().find((value) => value !== gid);
      if (alternateGid === undefined) return;

      const unchangedLooseDirectory = path.join(stateRoot, "projects");
      await chmod(unchangedLooseDirectory, 0o755);
      const stateFile = path.join(stateRoot, "session-started");
      await chown(stateFile, uid, alternateGid);
      await expect(sealFixture(stateRoot)).rejects.toThrow("wrong owner");
      expect((await lstat(unchangedLooseDirectory)).mode & 0o7777).toBe(0o755);
    });
  });

  it("defaults the production contract to root ownership", async () => {
    await withStateFixture(async (stateRoot) => {
      const productionSeal = sealNativeState({
        stateRoot,
        engine: "anthropic",
        threadId: "thread-1",
        sessionId: "session-1",
        cursor: "v1:cursor-1",
        integrityKey: INTEGRITY_KEY,
      });
      if (TEST_OWNER.uid === 0 && TEST_OWNER.gid === 0) {
        await expect(productionSeal).resolves.toBeDefined();
      } else {
        await expect(productionSeal).rejects.toThrow("expected 0:0");
      }
    });
  });

  it("rejects metadata rewrites and a different integrity authority", async () => {
    await withStateFixture(async (stateRoot) => {
      await sealFixture(stateRoot);
      await expect(
        assertNativeState({
          stateRoot,
          engine: "anthropic",
          threadId: "thread-1",
          sessionId: "session-1",
          expectedCursor: "v1:another-cursor",
          integrityKey: INTEGRITY_KEY,
          expectedOwner: TEST_OWNER,
        }),
      ).rejects.toThrow("does not match");
      await expect(
        assertNativeState({
          stateRoot,
          engine: "anthropic",
          threadId: "thread-1",
          sessionId: "session-1",
          expectedCursor: "v1:cursor-1",
          integrityKey: "8".repeat(64),
          expectedOwner: TEST_OWNER,
        }),
      ).rejects.toThrow("attestation is invalid");

      const manifestPath = path.join(stateRoot, NATIVE_STATE_ATTESTATION_FILE);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        tree: { digest: string };
      };
      manifest.tree.digest = "0".repeat(64);
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(assertFixture(stateRoot)).rejects.toThrow(
        "attestation is invalid",
      );
    });
  });

  it("accepts only a truly empty root for a fresh transcript", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "stella-native-fresh-"));
    const absent = path.join(parent, "absent");
    const empty = path.join(parent, "empty");
    try {
      await mkdir(empty, { mode: 0o700 });
      await expect(
        assertFreshNativeState(absent, TEST_OWNER),
      ).resolves.toBeUndefined();
      await expect(
        assertFreshNativeState(empty, TEST_OWNER),
      ).resolves.toBeUndefined();
      await writeFile(path.join(empty, "state"), "unexpected");
      await expect(assertFreshNativeState(empty, TEST_OWNER)).rejects.toThrow(
        "Unexpected native agent session state",
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects symlinked or permissive roots for a fresh transcript", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "stella-native-fresh-"));
    const target = path.join(parent, "target");
    const linked = path.join(parent, "linked");
    const permissive = path.join(parent, "permissive");
    try {
      await mkdir(target, { mode: 0o700 });
      await symlink(target, linked);
      await expect(assertFreshNativeState(linked, TEST_OWNER)).rejects.toThrow(
        "canonical real directory",
      );

      await mkdir(permissive, { mode: 0o700 });
      await chmod(permissive, 0o755);
      await expect(
        assertFreshNativeState(permissive, TEST_OWNER),
      ).rejects.toThrow("permissions 0700");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
