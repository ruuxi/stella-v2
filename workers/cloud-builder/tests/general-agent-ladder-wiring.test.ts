import { describe, expect, test } from "bun:test";
import {
  createAgentSandboxAttachment,
  AttachedToolHostUnavailableError,
} from "../src/agent-sandbox-attachment.js";
import {
  GeneralAgentPlacementError,
  runGeneralAgentTurn,
  type GeneralAgentTurnResult,
} from "../src/general-agent-turn.js";
import { createTurnRetryCancellation } from "../src/turn-cancellation.js";
import {
  ATTACHED_TOOL_HOST_INPUT_PATH,
  ATTACHED_TOOL_PROTOCOL_VERSION,
  ATTACHED_TOOL_REQUEST_PATH,
  ATTACHED_TOOL_RESULT_PATH,
  ATTACHED_TOOL_SOCKET_PATH,
  type AttachedToolRequest,
} from "@stella/executor-cloud/attached-tool-protocol";

const liveContext = () => {
  const cancellation = createTurnRetryCancellation();
  const controller = new AbortController();
  return {
    cancellation: { ...cancellation, sleep: async () => undefined },
    signal: controller.signal,
    assertActive: () => undefined,
  };
};

const STELLA = {
  engine: "stella",
  provider: "stella",
  model: "stella/default",
  reasoningEffort: "default",
} as const;

const residentResult = (
  overrides: Partial<GeneralAgentTurnResult> = {},
): GeneralAgentTurnResult =>
  ({
    outcome: "completed",
    ok: true,
    finalText: "done",
    usage: { inputTokens: 1, outputTokens: 2, llmCalls: 1 },
    compute: { kind: "resident" },
    durability: {
      kind: "transcript_only",
      transcript: {
        kind: "canonical_transcript",
        historyCursor: "cursor",
        rowCount: 2,
      },
    },
    ...overrides,
  }) as GeneralAgentTurnResult;

describe("the placement dispatch is the only engine branch", () => {
  test("a resident plan runs the resident arm and hands its envelope back", async () => {
    const calls: string[] = [];

    const outcome = await runGeneralAgentTurn({
      plan: { kind: "resident_stella", execution: STELLA },
      context: liveContext(),
      resident: async () => {
        calls.push("resident");
        return residentResult();
      },
      native: async () => {
        calls.push("native");
      },
    });

    expect(calls).toEqual(["resident"]);
    expect(outcome).toMatchObject({ kind: "resident" });
  });

  test("a native plan runs today's path and reports nothing to sequence", async () => {
    const calls: string[] = [];

    const outcome = await runGeneralAgentTurn({
      plan: {
        kind: "native_sandbox",
        execution: STELLA,
        reason: "resident_disabled",
      },
      context: liveContext(),
      resident: async () => {
        calls.push("resident");
        return residentResult();
      },
      native: async () => {
        calls.push("native");
      },
    });

    expect(calls).toEqual(["native"]);
    expect(outcome).toEqual({ kind: "native_finalized" });
  });

  test("an unplaced attempt keeps the container path it was admitted onto", async () => {
    const calls: string[] = [];

    const outcome = await runGeneralAgentTurn({
      plan: { kind: "native_sandbox", execution: STELLA, reason: "unplaced" },
      context: liveContext(),
      resident: async () => {
        calls.push("resident");
        return residentResult();
      },
      native: async () => {
        calls.push("native");
      },
    });

    expect(calls).toEqual(["native"]);
    expect(outcome).toEqual({ kind: "native_finalized" });
  });

  test("a stella turn cannot reach the container as a native engine", async () => {
    const calls: string[] = [];

    await expect(
      runGeneralAgentTurn({
        plan: {
          kind: "native_sandbox",
          execution: STELLA,
          reason: "native_engine",
        } as Parameters<typeof runGeneralAgentTurn>[0]["plan"],
        context: liveContext(),
        resident: async () => {
          calls.push("resident");
          return residentResult();
        },
        native: async () => {
          calls.push("native");
        },
      }),
    ).rejects.toThrow(GeneralAgentPlacementError);
    expect(calls).toEqual([]);
  });

  test("a resident turn cannot claim an archive it never attached to upload", async () => {
    await expect(
      runGeneralAgentTurn({
        plan: { kind: "resident_stella", execution: STELLA },
        context: liveContext(),
        resident: async () =>
          residentResult({
            durability: {
              kind: "workspace_checkpoint",
              transcript: {
                kind: "canonical_transcript",
                historyCursor: "cursor",
                rowCount: 2,
              },
              checkpoint: {
                schemaVersion: 1,
                receipt: "r",
                operationId: "o",
                historyCursor: "cursor",
                workspaceSha256: "w",
              },
            } as GeneralAgentTurnResult["durability"],
          }),
        native: async () => undefined,
      }),
    ).rejects.toThrow(GeneralAgentPlacementError);
  });
});

type ExecResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

const fakeSession = (options: {
  socketAppearsAfter?: number;
  resultFrame?: unknown;
  resultBytes?: number;
}) => {
  const files = new Map<string, string>();
  const execs: string[] = [];
  const processes: string[] = [];
  let socketProbes = 0;
  const resultText = () => `${JSON.stringify(options.resultFrame ?? {})}\n`;
  const exec = async (command: string): Promise<ExecResult> => {
    execs.push(command);
    const ok = { success: true, exitCode: 0, stdout: "", stderr: "" };
    if (command.startsWith("test -S")) {
      socketProbes += 1;
      return socketProbes > (options.socketAppearsAfter ?? 0)
        ? ok
        : { success: false, exitCode: 1, stdout: "", stderr: "" };
    }
    if (command.startsWith("wc -c")) {
      return {
        ...ok,
        stdout: `${options.resultBytes ?? new TextEncoder().encode(resultText()).byteLength}\n`,
      };
    }
    if (command.includes("--attached-tool-client")) {
      files.set(ATTACHED_TOOL_RESULT_PATH, resultText());
      return ok;
    }
    return ok;
  };
  return {
    files,
    execs,
    processes,
    session: {
      exec,
      writeFile: async (path: string, contents: string) => {
        files.set(path, contents);
      },
      readFile: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return { content: btoa(content) };
      },
      deleteFile: async (path: string) => {
        files.delete(path);
      },
      startProcess: async (command: string) => {
        processes.push(command);
        return {};
      },
    },
  };
};

const HANDOFF = {
  turnId: "turn-1",
  attemptGeneration: 1,
  threadId: "thread-1",
  prompt: "hello",
  workspaceRestored: true,
  turnBroker: { credentialsPath: "/workspace/.turn-broker-1.json" },
} as const;

const attachmentFor = (fake: ReturnType<typeof fakeSession>) => {
  const destroyed: string[] = [];
  const attachment = createAgentSandboxAttachment({
    context: liveContext(),
    attachWorld: async () => ({
      session: fake.session as never,
      coldContainerStartMs: 1_200,
      restoreMs: 340,
    }),
    prepareBrokerHandoff: async () => HANDOFF,
    destroy: async (sandboxId) => {
      destroyed.push(sandboxId);
    },
  });
  return { attachment, destroyed };
};

const TOOL_REQUEST: AttachedToolRequest = {
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  turnId: "turn-1",
  attemptGeneration: 1,
  toolCallId: "call-1",
  fingerprint: "a".repeat(64),
  toolName: "exec_command",
  params: { command: "ls" },
};

const COMPLETED_FRAME = {
  version: ATTACHED_TOOL_PROTOCOL_VERSION,
  status: "completed",
  toolCallId: "call-1",
  fingerprint: "a".repeat(64),
  result: {
    outcome: { kind: "ok", text: "world" },
    details: null,
    authorizedImages: [],
    fileChanges: [],
    producedFiles: [],
    producedFilesOmitted: null,
  },
} as const;

describe("the sandbox attachment is the container side of the ladder", () => {
  test("boot hands the daemon its capability, starts it, and waits for its socket", async () => {
    const fake = fakeSession({ socketAppearsAfter: 2 });
    const { attachment } = attachmentFor(fake);

    const boot = await attachment.boot({
      sandboxId: "agent-turn-1",
      instanceSize: "small",
    });

    expect(boot).toEqual({ coldStartMs: 1_200, restoreMs: 340 });
    expect(JSON.parse(fake.files.get(ATTACHED_TOOL_HOST_INPUT_PATH)!)).toEqual(
      HANDOFF,
    );
    expect(fake.processes).toEqual([
      "'bun' 'packages/executor-cloud/src/cli.ts' '--attached-tool-host'",
    ]);
    // The socket appearing is the readiness signal, so a daemon that is slow
    // to listen must be waited for rather than called into.
    expect(
      fake.execs.filter((command) =>
        command.startsWith(`test -S '${ATTACHED_TOOL_SOCKET_PATH}'`),
      ),
    ).toHaveLength(3);
  });

  test("a tool call round-trips through the request and result files", async () => {
    const fake = fakeSession({ resultFrame: COMPLETED_FRAME });
    const { attachment } = attachmentFor(fake);
    await attachment.boot({
      sandboxId: "agent-turn-1",
      instanceSize: "large",
    });

    const response = await attachment.callTool({
      sandboxId: "agent-turn-1",
      request: TOOL_REQUEST,
    });

    expect(response).toMatchObject({ status: "completed" });
    expect(JSON.parse(fake.files.get(ATTACHED_TOOL_REQUEST_PATH)!)).toEqual(
      TOOL_REQUEST,
    );
    expect(
      fake.execs.some((command) =>
        command.includes("'--attached-tool-client'"),
      ),
    ).toBe(true);
  });

  test("a result larger than the protocol bound is refused before it is read", async () => {
    const fake = fakeSession({
      resultFrame: COMPLETED_FRAME,
      resultBytes: 64 * 1024 * 1024,
    });
    const { attachment } = attachmentFor(fake);
    await attachment.boot({
      sandboxId: "agent-turn-1",
      instanceSize: "large",
    });

    await expect(
      attachment.callTool({
        sandboxId: "agent-turn-1",
        request: TOOL_REQUEST,
      }),
    ).rejects.toThrow(AttachedToolHostUnavailableError);
  });

  test("a control frame is parsed as a control response", async () => {
    const fake = fakeSession({
      resultFrame: {
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        status: "quiesced",
        producedFiles: [],
        producedFilesOmitted: null,
      },
    });
    const { attachment } = attachmentFor(fake);
    await attachment.boot({
      sandboxId: "agent-turn-1",
      instanceSize: "large",
    });

    const control = await attachment.control({
      sandboxId: "agent-turn-1",
      control: "quiesce",
      turnId: "turn-1",
      attemptGeneration: 1,
    });

    expect(control).toMatchObject({ status: "quiesced" });
  });

  test("a call before boot names the missing workspace instead of booting one", async () => {
    const fake = fakeSession({ resultFrame: COMPLETED_FRAME });
    const { attachment } = attachmentFor(fake);

    await expect(
      attachment.callTool({
        sandboxId: "agent-turn-1",
        request: TOOL_REQUEST,
      }),
    ).rejects.toThrow(AttachedToolHostUnavailableError);
    expect(fake.processes).toEqual([]);
  });

  test("destroy runs the exact teardown and drops the session handle", async () => {
    const fake = fakeSession({ resultFrame: COMPLETED_FRAME });
    const { attachment, destroyed } = attachmentFor(fake);
    await attachment.boot({
      sandboxId: "agent-turn-1",
      instanceSize: "large",
    });

    await attachment.destroy("agent-turn-1");

    expect(destroyed).toEqual(["agent-turn-1"]);
    await expect(
      attachment.control({
        sandboxId: "agent-turn-1",
        control: "quiesce",
        turnId: "turn-1",
        attemptGeneration: 1,
      }),
    ).rejects.toThrow(AttachedToolHostUnavailableError);
  });
});
