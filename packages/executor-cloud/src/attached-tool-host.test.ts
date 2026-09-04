import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import {
  createAttachedToolDispatcher,
  parseAttachedToolHostInput,
  removeStaleAttachedToolSocket,
  serializeToolResult,
  type AttachedToolHostReport,
  type CallState,
} from "./attached-tool-host.js";
import {
  ATTACHED_TOOL_PROTOCOL_VERSION,
  type SerializedAgentToolResult,
} from "./attached-tool-protocol.js";
import { TOOL_RESULT_AUTHORIZED_IMAGES } from "@stella/runtime/kernel/tools/types.js";

const IDENTITY = { turnId: "turn-1", attemptGeneration: 2 } as const;

const OK: SerializedAgentToolResult = {
  outcome: { kind: "ok", text: "done" },
  details: null,
  authorizedImages: [],
};

const REPORT: AttachedToolHostReport = {
  bootNotices: [],
  deliveredFiles: [],
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("attached tool daemon socket ownership", () => {
  test("refuses to unlink a live daemon socket and removes it once stale", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "stella-daemon-"));
    temporaryDirectories.push(directory);
    const socketPath = path.join(directory, "tool-host.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    await expect(removeStaleAttachedToolSocket(socketPath)).rejects.toThrow(
      "already owns this socket",
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await removeStaleAttachedToolSocket(socketPath);
    await expect(Bun.file(socketPath).exists()).resolves.toBe(false);
  });
});

const toolFrame = (overrides: Record<string, unknown> = {}) => ({
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  turnId: IDENTITY.turnId,
  attemptGeneration: IDENTITY.attemptGeneration,
  toolCallId: "call-1",
  fingerprint: "a".repeat(64),
  toolName: "exec_command",
  params: { command: "ls" },
  ...overrides,
});

const controlFrame = (control: "boot_report" | "quiesce") => ({
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  turnId: IDENTITY.turnId,
  attemptGeneration: IDENTITY.attemptGeneration,
  control,
  ...(control === "quiesce" ? { linkedPaths: [] } : {}),
});

const dispatcher = (
  options: {
    calls?: Map<string, CallState>;
    execute?: () => Promise<SerializedAgentToolResult>;
    quiesce?: (
      linkedPaths: readonly string[],
    ) => Promise<AttachedToolHostReport>;
    bootNotices?: readonly string[];
  } = {},
) => {
  const runs: string[] = [];
  const calls = options.calls ?? new Map<string, CallState>();
  const instance = createAttachedToolDispatcher({
    identity: IDENTITY,
    bootNotices: options.bootNotices ?? [],
    calls,
    execute: async (key) => {
      runs.push(key);
      calls.set(key, { kind: "running" });
      const result = options.execute ? await options.execute() : OK;
      calls.set(key, { kind: "done", result });
      return result;
    },
    quiesce: options.quiesce ?? (async () => REPORT),
  });
  return { instance, runs, calls };
};

describe("attached tool dispatcher", () => {
  test("runs a call once and replays the receipt for its exact repeat", async () => {
    const { instance, runs } = dispatcher();

    const first = await instance.answer(toolFrame());
    const replay = await instance.answer(toolFrame());

    expect(first).toEqual(replay);
    expect(first.status).toBe("completed");
    expect(runs).toEqual(["call-1:" + "a".repeat(64)]);
  });

  test("treats a different argument fingerprint as a different call", async () => {
    const { instance, runs } = dispatcher();

    await instance.answer(toolFrame());
    await instance.answer(toolFrame({ fingerprint: "b".repeat(64) }));

    expect(runs).toHaveLength(2);
  });

  test("answers pending while the same call is still running", async () => {
    const calls = new Map<string, CallState>([
      [`call-1:${"a".repeat(64)}`, { kind: "running" }],
    ]);
    const { instance, runs } = dispatcher({ calls });

    expect((await instance.answer(toolFrame())).status).toBe("pending");
    expect(runs).toEqual([]);
  });

  test("fails closed on a replay whose outcome it cannot prove", async () => {
    const calls = new Map<string, CallState>([
      [
        `call-1:${"a".repeat(64)}`,
        { kind: "lost", error: "the shell went away" },
      ],
    ]);
    const { instance, runs } = dispatcher({ calls });

    const response = await instance.answer(toolFrame());

    expect(response).toMatchObject({
      status: "failed",
      error: "the shell went away",
    });
    expect(runs).toEqual([]);
  });

  test("refuses a frame addressed to another attempt of the same turn", async () => {
    const { instance, runs } = dispatcher();

    const response = await instance.answer(toolFrame({ attemptGeneration: 3 }));

    expect(response.status).toBe("failed");
    expect(runs).toEqual([]);
  });

  test("refuses a tool outside the allowlist before it reaches a handler", async () => {
    const { instance, runs } = dispatcher();

    await expect(
      instance.answer(toolFrame({ toolName: "code" })),
    ).rejects.toThrow();
    expect(runs).toEqual([]);
  });

  test("reports drive hydration once, without running anything", async () => {
    const { instance, runs } = dispatcher({
      bootNotices: ["Your drive is on disk."],
    });

    expect(await instance.answer(controlFrame("boot_report"))).toEqual({
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "boot_report",
      notices: ["Your drive is on disk."],
    });
    expect(runs).toEqual([]);
  });

  test("quiesce forwards the linked paths and returns what it delivered", async () => {
    let joined = 0;
    let receivedLinkedPaths: readonly string[] | undefined;
    const { instance } = dispatcher({
      quiesce: async (linkedPaths) => {
        joined += 1;
        receivedLinkedPaths = linkedPaths;
        return {
          bootNotices: [],
          deliveredFiles: ["out.txt"],
        };
      },
    });

    const response = await instance.answer({
      ...controlFrame("quiesce"),
      linkedPaths: ["/world/drive/out.txt"],
    });

    expect(joined).toBe(1);
    expect(receivedLinkedPaths).toEqual(["/world/drive/out.txt"]);
    expect(response).toMatchObject({
      status: "quiesced",
      deliveredFiles: ["out.txt"],
    });
  });
});

describe("attached tool result serialization", () => {
  test("carries a tool error as an outcome rather than as a thrown turn failure", () => {
    expect(serializeToolResult({ error: "exit 1" }).outcome).toEqual({
      kind: "error",
      message: "exit 1",
    });
  });

  test("stringifies a structured result the way the container path does", () => {
    const serialized = serializeToolResult({ result: { rows: 2 } });
    expect(serialized.outcome).toEqual({
      kind: "ok",
      text: JSON.stringify({ rows: 2 }, null, 2),
    });
  });

  test("truncates a result too large to put in front of the model", () => {
    const serialized = serializeToolResult({ result: "x".repeat(40_000) });
    if (serialized.outcome.kind !== "ok") throw new Error("expected ok");
    expect(serialized.outcome.text).toContain("…[truncated]…");
    expect(serialized.outcome.text.length).toBeLessThan(40_000);
  });

  test("base64s authorized image bytes so no handle crosses the wire", () => {
    const serialized = serializeToolResult({
      result: "shot",
      [TOOL_RESULT_AUTHORIZED_IMAGES]: [
        {
          data: new Uint8Array([1, 2, 3]),
          mimeType: "image/png",
          sourcePath: "/world/shot.png",
        },
      ],
    });
    expect(serialized.authorizedImages).toEqual([
      {
        data: Buffer.from([1, 2, 3]).toString("base64"),
        mimeType: "image/png",
        sourcePath: "/world/shot.png",
      },
    ]);
  });
});

describe("attached tool host input", () => {
  const input = (overrides: Record<string, unknown> = {}) => ({
    turnId: "turn-1",
    attemptGeneration: 1,
    threadId: "thread-1",
    prompt: "hi",
    workspaceRestored: true,
    turnBroker: { credentialsPath: "/workspace/broker.json" },
    world: {
      origin: "https://builder.example",
      name: `${"a".repeat(64)}:${"b".repeat(64)}`,
      capability: "wc1.payload.signature",
    },
    ...overrides,
  });

  test("accepts the record the worker writes", () => {
    expect(parseAttachedToolHostInput(input()).turnId).toBe("turn-1");
  });

  test("refuses input with no broker handoff to consume", () => {
    expect(() =>
      parseAttachedToolHostInput(input({ turnBroker: {} })),
    ).toThrow();
  });

  test("refuses an attempt generation the registry can never have issued", () => {
    expect(() =>
      parseAttachedToolHostInput(input({ attemptGeneration: 0 })),
    ).toThrow();
  });
});
