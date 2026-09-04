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
  checkpointCloudBrowserTurnBeforeTeardown,
  cloudGeneralToolNames,
  commitTurnStateBeforeTranscript,
  createBuilderFallbackAgentTurnResult,
  createCloudBrowserResumeToolResult,
  createSuspendedAgentTurnResult,
  usesNativeCloudRuntime,
} from "./agent-turn.js";
import { AgentToolSuspendedError } from "@stella/runtime/kernel/agent-core/suspension.js";
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
  test("keeps Codex Responses in Stella's in-process agent loop", () => {
    expect(
      usesNativeCloudRuntime({
        engine: "openai-codex",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      }),
    ).toBe(false);
    expect(
      usesNativeCloudRuntime({
        engine: "anthropic",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        reasoningEffort: "high",
      }),
    ).toBe(true);
  });

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

  test("stages the secret-free suspension transcript with its checkpoint", async () => {
    const suspensionTranscript = [
      {
        ordinal: 0,
        role: "user",
        payloadJson: JSON.stringify({ role: "user", content: [] }),
      },
      {
        ordinal: 1,
        role: "assistant",
        payloadJson: JSON.stringify({
          role: "assistant",
          content: [
            { type: "toolCall", id: "outer-code-call", name: "code" },
          ],
        }),
      },
    ];
    const calls: string[] = [];
    await commitTurnStateBeforeTranscript({
      historyCursor: "v1:suspension-cursor",
      suspensionTranscript,
      broker: {
        commitTurnStateCheckpoint: async (value) => {
          expect(value).toEqual({
            historyCursor: "v1:suspension-cursor",
            suspensionTranscript,
          });
          calls.push("checkpoint");
          return {
            operationId: "a".repeat(64),
            historyCursor: "v1:suspension-cursor",
            manifestId: "b".repeat(64),
          };
        },
      },
      appendTranscript: async () => {
        calls.push("transcript");
      },
    });
    expect(calls).toEqual(["checkpoint", "transcript"]);
  });

  test("enables browser-backed code only for the Stella cloud engine", () => {
    expect(cloudGeneralToolNames("stella")).toContain("code");
    for (const engine of ["anthropic", "openai-codex"] as const) {
      expect(cloudGeneralToolNames(engine)).not.toContain("code");
      expect(cloudGeneralToolNames(engine)).toContain("exec_command");
      expect(cloudGeneralToolNames(engine)).toContain("Write");
      expect(cloudGeneralToolNames(engine)).toContain("Edit");
      expect(cloudGeneralToolNames(engine)).toContain("Grep");
    }
  });

  test("joins browser profile checkpointing on completion and skips suspension", async () => {
    const completedCalls: Array<[string, string]> = [];
    await checkpointCloudBrowserTurnBeforeTeardown({
      codeToolCallIds: ["code-call-1", "code-call-2"],
      suspended: false,
      endBrowserTurn: async (toolCallId, behavior) => {
        completedCalls.push([toolCallId, behavior]);
      },
    });
    expect(completedCalls).toEqual([
      ["code-call-2", "retain-tabs"],
      ["code-call-1", "retain-tabs"],
    ]);

    const suspendedCalls: string[] = [];
    await checkpointCloudBrowserTurnBeforeTeardown({
      codeToolCallIds: ["suspended-code-call"],
      suspended: true,
      endBrowserTurn: async (toolCallId) => {
        suspendedCalls.push(toolCallId);
      },
    });
    expect(suspendedCalls).toEqual([]);
  });

  test("appends exactly one safe tool result for a browser resume", () => {
    const history = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "code-call-1",
            name: "code",
            arguments: { code: "await browser.command('url')" },
          },
        ],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
    ] as AgentMessage[];
    const receipt = {
      schemaVersion: 1 as const,
      interactionId: "interaction-1",
      interactionRevision: 2,
      profileId: "default",
      profileEpoch: 4,
      toolCallId: "code-call-1",
      requestDigest: "d".repeat(64),
      result: "approved" as const,
      safeMessage: "Sign-in completed; continue the browser task.",
    };
    const resumed = createCloudBrowserResumeToolResult(history, receipt, 2);
    expect(resumed).toMatchObject({
      role: "toolResult",
      toolCallId: "code-call-1",
      toolName: "code",
      content: [{ type: "text", text: receipt.safeMessage }],
      isError: false,
      timestamp: 2,
    });
    expect(JSON.stringify(resumed)).not.toContain("password");
    expect(() =>
      createCloudBrowserResumeToolResult([...history, resumed], receipt),
    ).toThrow("already appended");
    expect(() =>
      createCloudBrowserResumeToolResult(history, {
        ...receipt,
        toolCallId: "wrong-call",
      }),
    ).toThrow("canonical assistant tool call");
  });

  test("builds the strict durable suspension result without a fallback policy", () => {
    const suspension = {
      schemaVersion: 1 as const,
      outcome: "waiting_for_user" as const,
      interactionId: "interaction-1",
      interactionRevision: 1,
      interactionKind: "device_code" as const,
      toolCallId: "code-call-1",
      requestDigest: "a".repeat(64),
      profileId: "default",
      profileEpoch: 1,
      displayOrigin: "https://example.test",
      expiresAt: Date.now() + 60_000,
    };
    const turnStateCheckpoint = {
      operationId: "b".repeat(64),
      historyCursor: "v1:empty",
      manifestId: "c".repeat(64),
    };
    const result = createSuspendedAgentTurnResult({
      error: new AgentToolSuspendedError(suspension),
      usage: { inputTokens: 3, outputTokens: 4, llmCalls: 1 },
      checkpointMs: 9,
      turnStateCheckpoint,
    });
    expect(result).toEqual({
      outcome: "suspended",
      ok: false,
      finalText: "",
      suspension,
      usage: { inputTokens: 3, outputTokens: 4, llmCalls: 1 },
      checkpointMs: 9,
      turnStateCheckpoint,
    });
    expect("checkpointPolicy" in result).toBe(false);
    expect("builderFallback" in result).toBe(false);
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
