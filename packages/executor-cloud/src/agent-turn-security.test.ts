import { describe, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chownTreeWithoutFollowingSymlinks,
  cloudGeneralToolNames,
  commitTurnStateBeforeTranscript,
  createBuilderFallbackAgentTurnResult,
} from "./agent-turn.js";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";

const checkpoint = {
  engine: "anthropic" as const,
  sessionId: "session-1",
  cursor: "v1:cursor-1",
  tree: {
    algorithm: "sha256" as const,
    digest: "a".repeat(64),
    entries: 2,
    bytes: 7,
  },
  mac: "b".repeat(64),
};

describe("cloud native-state containment", () => {
  test("commits the native checkpoint before making transcript state canonical", async () => {
    const calls: string[] = [];
    await commitTurnStateBeforeTranscript({
      historyCursor: checkpoint.cursor,
      nativeCheckpoint: checkpoint,
      broker: {
        commitTurnStateCheckpoint: async (value) => {
          expect(value).toEqual({
            historyCursor: checkpoint.cursor,
            nativeCheckpoint: checkpoint,
          });
          calls.push("checkpoint");
          return {
            operationId: "a".repeat(64),
            historyCursor: checkpoint.cursor,
            manifestId: "d".repeat(64),
          };
        },
      },
      appendTranscript: async () => {
        calls.push("transcript");
      },
    });
    expect(calls).toEqual(["checkpoint", "transcript"]);
  });

  test("never appends the transcript when native checkpoint durability is unknown", async () => {
    let transcriptCalled = false;
    await expect(
      commitTurnStateBeforeTranscript({
        historyCursor: checkpoint.cursor,
        nativeCheckpoint: checkpoint,
        broker: {
          commitTurnStateCheckpoint: async () => {
            throw new Error("lost response");
          },
        },
        appendTranscript: async () => {
          transcriptCalled = true;
        },
      }),
    ).rejects.toThrow("lost response");
    expect(transcriptCalled).toBe(false);
  });

  test("keeps a completed report recoverable when Builder must finish the checkpoint", () => {
    const messages = [
      {
        ordinal: 0,
        role: "assistant",
        payloadJson: JSON.stringify({ role: "assistant", content: [] }),
      },
    ];
    expect(
      createBuilderFallbackAgentTurnResult({
        finalText: "Finished report",
        usage: { inputTokens: 3, outputTokens: 4, llmCalls: 1 },
        historyCursor: checkpoint.cursor,
        messages,
      }),
    ).toEqual({
      ok: true,
      finalText: "Finished report",
      checkpointPolicy: "builder_fallback",
      usage: { inputTokens: 3, outputTokens: 4, llmCalls: 1 },
      builderFallback: {
        historyCursor: checkpoint.cursor,
        messages,
      },
    });
    expect(
      createBuilderFallbackAgentTurnResult({
        finalText: "Partial report",
        error: "model failed",
        usage: { inputTokens: 3, outputTokens: 4, llmCalls: 1 },
        historyCursor: checkpoint.cursor,
        messages,
      }),
    ).toMatchObject({ ok: false, error: "model failed" });
  });

  test("gives every container engine the same file and shell tools, and no code", () => {
    expect(cloudGeneralToolNames()).not.toContain("code");
    expect(cloudGeneralToolNames()).toContain("Bash");
    expect(cloudGeneralToolNames()).toContain("Write");
    expect(cloudGeneralToolNames()).toContain("Edit");
    expect(cloudGeneralToolNames()).toContain("Grep");
  });

  test("changes workspace ownership without dereferencing its symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-tool-owner-"));
    const outside = await mkdtemp(path.join(tmpdir(), "stella-tool-outside-"));
    try {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested", "owned.txt"), "owned");
      await writeFile(path.join(outside, "private.txt"), "outside");
      await symlink(outside, path.join(root, "outside-link"));
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (uid === undefined || gid === undefined) return;

      await chownTreeWithoutFollowingSymlinks(root, uid, gid);

      expect(
        (await lstat(path.join(root, "outside-link"))).isSymbolicLink(),
      ).toBe(true);
      expect(await readFile(path.join(outside, "private.txt"), "utf8")).toBe(
        "outside",
      );
      expect((await lstat(path.join(root, "nested", "owned.txt"))).uid).toBe(
        uid,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects a symlink workspace root and restored hard-linked files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stella-tool-hardlink-"));
    const outside = await mkdtemp(path.join(tmpdir(), "stella-tool-private-"));
    const rootAlias = `${root}-alias`;
    try {
      const privateFile = path.join(outside, "private.txt");
      await writeFile(privateFile, "private");
      await link(privateFile, path.join(root, "restored-hardlink"));
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (uid === undefined || gid === undefined) return;

      await expect(
        chownTreeWithoutFollowingSymlinks(root, uid, gid),
      ).rejects.toThrow("hard-linked");
      await rm(path.join(root, "restored-hardlink"));
      await symlink(root, rootAlias);
      await expect(
        chownTreeWithoutFollowingSymlinks(rootAlias, uid, gid),
      ).rejects.toThrow("root must not be a symbolic link");
    } finally {
      await rm(rootAlias, { force: true });
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
