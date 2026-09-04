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
  ATTACHED_TOOL_PROTOCOL_VERSION,
  attachedToolPaths,
  type AttachedToolRequest,
} from "@stella/executor-cloud/attached-tool-protocol";

const PATHS = attachedToolPaths({ turnId: "turn-1", attemptGeneration: 1 });
const BOOT = {
  sandboxId: "world-owner-1",
  sessionId: "agent-run-turn-1",
  daemonDirectory: PATHS.directory,
} as const;

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
              kind: "workspace_manifest",
              transcript: {
                kind: "canonical_transcript",
                historyCursor: "cursor",
                rowCount: 2,
              },
              historyCursor: "cursor",
              manifestId: "w".repeat(64),
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
  /** What the daemon handle reports while the socket is still absent. */
  daemonStatus?: string;
  daemonStderr?: string;
  /** What the daemon's persisted stderr file holds when the SDK has nothing. */
  daemonStderrFile?: string;
  /**
   * Model the SDK's persistent shell after a boundary script left `set -e`
   * on: any command that would exit non-zero takes the shell down and the SDK
   * throws instead of returning a result.
   */
  errexit?: boolean;
}) => {
  const files = new Map<string, string>();
  const execs: string[] = [];
  const execOptions: unknown[] = [];
  const processes: string[] = [];
  const processOptions: unknown[] = [];
  let socketProbes = 0;
  const resultText = () => `${JSON.stringify(options.resultFrame ?? {})}\n`;
  const exec = async (
    command: string,
    execOpts?: unknown,
  ): Promise<ExecResult> => {
    execs.push(command);
    execOptions.push(execOpts ?? null);
    const ok = { success: true, exitCode: 0, stdout: "", stderr: "" };
    if (command.includes("test -S")) {
      socketProbes += 1;
      const ready = socketProbes > (options.socketAppearsAfter ?? 0);
      // The probe is an `if`, so it exits zero either way and reports on
      // stdout; a bare `test -S` would be a non-zero exit while waiting.
      if (command.startsWith("if test -S")) {
        return {
          ...ok,
          stdout: ready ? "stella-attached-tool-host-ready\n" : "",
        };
      }
      if (ready) return ok;
      if (options.errexit) {
        throw new Error(
          "Session 'agent-run-turn-1' shell exited (exit code: 1)",
        );
      }
      return { success: false, exitCode: 1, stdout: "", stderr: "" };
    }
    if (command.startsWith("tail -c")) {
      return { ...ok, stdout: options.daemonStderrFile ?? "" };
    }
    if (command.startsWith("wc -c")) {
      return {
        ...ok,
        stdout: `${options.resultBytes ?? new TextEncoder().encode(resultText()).byteLength}\n`,
      };
    }
    if (command.includes("--attached-tool-client")) {
      files.set(PATHS.result, resultText());
      return ok;
    }
    return ok;
  };
  return {
    files,
    execs,
    execOptions,
    processes,
    processOptions,
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
      startProcess: async (command: string, opts?: unknown) => {
        processes.push(command);
        processOptions.push(opts ?? null);
        return {
          getStatus: async () => options.daemonStatus ?? "running",
          getLogs: async () => ({
            stdout: "",
            stderr: options.daemonStderr ?? "",
          }),
        };
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
  const events: Array<{ kind: string; payload: unknown }> = [];
  const attachment = createAgentSandboxAttachment({
    context: liveContext(),
    attachWorld: async () => ({
      session: fake.session as never,
      coldContainerStartMs: 1_200,
      restoreMs: 340,
    }),
    prepareBrokerHandoff: async () => HANDOFF,
    release: async () => undefined,
    destroy: async ({ sandboxId }) => {
      destroyed.push(sandboxId);
    },
    emitEvent: (kind, payload) => {
      events.push({ kind, payload });
    },
  });
  return { attachment, destroyed, events };
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
  },
} as const;

describe("the sandbox attachment is the container side of the ladder", () => {
  test("the readiness probe survives a session shell left with errexit on", async () => {
    // Boundary scripts run `set -eu` in the same persistent shell. The probe
    // must never be the first non-zero exit in that shell, or the attach dies
    // with "shell exited (exit code: 1)" before the daemon can listen.
    const fake = fakeSession({ socketAppearsAfter: 3, errexit: true });
    const { attachment } = attachmentFor(fake);

    const boot = await attachment.boot({
      ...BOOT,
      instanceSize: "small",
    });

    expect(boot).toEqual({ coldStartMs: 1_200, restoreMs: 340 });
    const probes = fake.execs.filter((c) => c.includes("test -S"));
    expect(probes).toHaveLength(4);
    for (const probe of probes)
      expect(probe.startsWith("if test -S")).toBe(true);
  });

  test("a daemon that exits before listening fails the boot with its own stderr", async () => {
    const fake = fakeSession({
      socketAppearsAfter: Number.MAX_SAFE_INTEGER,
      daemonStatus: "failed",
      daemonStderr:
        'error: Module not found "packages/executor-cloud/src/cli.ts"\n',
    });
    const { attachment } = attachmentFor(fake);

    await expect(
      attachment.boot({ ...BOOT, instanceSize: "small" }),
    ).rejects.toThrow(
      /exited before it could listen \(failed\): error: Module not found/u,
    );
    // Fast: the readiness window is not waited out for a process that is gone.
    expect(fake.execs.filter((c) => c.includes("test -S"))).toHaveLength(1);
  });

  test("the one-shot client runs from the executor root as well", async () => {
    const fake = fakeSession({ resultFrame: COMPLETED_FRAME });
    const { attachment } = attachmentFor(fake);
    await attachment.boot({ ...BOOT, instanceSize: "small" });
    await attachment.callTool({ request: TOOL_REQUEST });

    const client = fake.execs.findIndex((c) =>
      c.includes("--attached-tool-client"),
    );
    expect(client).toBeGreaterThanOrEqual(0);
    expect(fake.execOptions[client]).toEqual({ cwd: "/opt/stella" });
  });

  test("boot hands the daemon its capability, starts it, and waits for its socket", async () => {
    const fake = fakeSession({ socketAppearsAfter: 2 });
    const { attachment } = attachmentFor(fake);

    const boot = await attachment.boot({
      ...BOOT,
      instanceSize: "small",
    });

    expect(boot).toEqual({ coldStartMs: 1_200, restoreMs: 340 });
    expect(JSON.parse(fake.files.get(PATHS.hostInput)!)).toEqual(HANDOFF);
    // stderr is also persisted: the SDK keeps nothing for a daemon that died
    // abruptly, and that file is what the attachment reads back.
    expect(fake.processes).toEqual([
      "'bun' 'packages/executor-cloud/src/cli.ts' '--attached-tool-host' '--dir' '/workspace/attached/turn-1-1' 2>>'/workspace/attached/turn-1-1/daemon.stderr'",
    ]);
    // The SDK gives a background process no session working directory, and
    // the argv is relative to the image's executor root.
    expect(fake.processOptions).toEqual([
      { cwd: "/opt/stella", processId: "attached-daemon-agent-run-turn-1" },
    ]);
    // The socket appearing is the readiness signal, so a daemon that is slow
    // to listen must be waited for rather than called into.
    expect(
      fake.execs.filter((command) =>
        command.startsWith(`if test -S '${PATHS.socket}'`),
      ),
    ).toHaveLength(3);
  });

  test("a tool call round-trips through the request and result files", async () => {
    const fake = fakeSession({ resultFrame: COMPLETED_FRAME });
    const { attachment } = attachmentFor(fake);
    await attachment.boot({
      ...BOOT,
      instanceSize: "large",
    });

    const response = await attachment.callTool({
      sandboxId: "agent-turn-1",
      request: TOOL_REQUEST,
    });

    expect(response).toMatchObject({ status: "completed" });
    expect(JSON.parse(fake.files.get(PATHS.request)!)).toEqual(TOOL_REQUEST);
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
      ...BOOT,
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
        deliveredFiles: [],
      },
    });
    const { attachment } = attachmentFor(fake);
    await attachment.boot({
      ...BOOT,
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

  test("a failed control answer is returned and recorded, never mistaken for a broken frame", async () => {
    // The daemon answers a quiesce it could not complete with a failed
    // control frame. The ladder tolerates that (no delivered files), so the
    // emitted event is the only record of the daemon's reason.
    const fake = fakeSession({
      resultFrame: {
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        status: "failed",
        error: "tool host shutdown failed",
      },
    });
    const { attachment, events } = attachmentFor(fake);
    await attachment.boot({
      ...BOOT,
      instanceSize: "large",
    });

    const control = await attachment.control({
      sandboxId: "agent-turn-1",
      control: "quiesce",
      turnId: "turn-1",
      attemptGeneration: 1,
    });

    expect(control).toEqual({
      version: ATTACHED_TOOL_PROTOCOL_VERSION,
      status: "failed",
      error: "tool host shutdown failed",
    });
    expect(events).toContainEqual({
      kind: "attached_control_failed",
      payload: { control: "quiesce", error: "tool host shutdown failed" },
    });
  });

  test("a daemon whose SDK logs are empty is described from its persisted stderr", async () => {
    const fake = fakeSession({
      socketAppearsAfter: 100,
      daemonStatus: "error",
      daemonStderr: "",
      daemonStderrFile: "attached tool host received SIGTERM",
    });
    const { attachment, events } = attachmentFor(fake);

    await expect(
      attachment.boot({ ...BOOT, instanceSize: "small" }),
    ).rejects.toThrow(
      "The workspace bridge exited before it could listen (error): attached tool host received SIGTERM",
    );
    expect(events).toContainEqual({
      kind: "attached_daemon_failed",
      payload: {
        reason: "The workspace bridge exited before it could listen",
        status: "error",
        stderr: "attached tool host received SIGTERM",
      },
    });
  });

  test("a daemon that stops answering after boot is reported once with its status and stderr", async () => {
    // The client's frame only says the socket refused. The daemon's own
    // status and stderr say why it died, and only the attachment can still
    // read them; a turn's later calls must not repeat the report.
    const fake = fakeSession({
      resultFrame: {
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        status: "failed",
        toolCallId: "call-1",
        fingerprint: "a".repeat(64),
        error: `connect ECONNREFUSED ${PATHS.socket}`,
      },
      daemonStatus: "exited",
      daemonStderr: "TypeError: drive ledger is not iterable",
    });
    const { attachment, events } = attachmentFor(fake);
    await attachment.boot({
      ...BOOT,
      instanceSize: "large",
    });

    const first = await attachment.callTool({
      sandboxId: "agent-turn-1",
      request: TOOL_REQUEST,
    });
    const second = await attachment.callTool({
      sandboxId: "agent-turn-1",
      request: TOOL_REQUEST,
    });

    expect(first).toMatchObject({ status: "failed" });
    expect(second).toMatchObject({ status: "failed" });
    const losses = events.filter(
      (event) => event.kind === "attached_daemon_failed",
    );
    expect(losses).toHaveLength(1);
    expect(losses[0]?.payload).toMatchObject({
      reason: "The workspace bridge stopped answering",
      status: "exited",
      stderr: "TypeError: drive ledger is not iterable",
      error: `connect ECONNREFUSED ${PATHS.socket}`,
    });
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
      ...BOOT,
      instanceSize: "large",
    });

    await attachment.destroy({
      sandboxId: BOOT.sandboxId,
      instanceSize: "large",
    });

    expect(destroyed).toEqual([BOOT.sandboxId]);
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

describe("the daemon outlives the session shell", () => {
  test("boot starts the daemon through the sessionless facade when the caller provides one", async () => {
    // A session process is a child of that session's persistent shell and
    // dies with it. The facade start is the same path the eager container
    // executor takes, so no shell exit can take the bridge down.
    const fake = fakeSession({ socketAppearsAfter: 1 });
    const started: Array<{ command: string; options: unknown }> = [];
    const attachment = createAgentSandboxAttachment({
      context: liveContext(),
      attachWorld: async () => ({
        session: fake.session as never,
        coldContainerStartMs: 10,
        restoreMs: 5,
      }),
      prepareBrokerHandoff: async () => HANDOFF,
      startDaemon: async (command, options) => {
        started.push({ command, options });
        return {
          getStatus: async () => "running",
          getLogs: async () => ({ stdout: "", stderr: "" }),
        } as never;
      },
      release: async () => undefined,
      destroy: async () => undefined,
    });

    await attachment.boot({ ...BOOT, instanceSize: "small" });

    expect(started).toEqual([
      {
        command:
          "'bun' 'packages/executor-cloud/src/cli.ts' '--attached-tool-host' '--dir' '/workspace/attached/turn-1-1' 2>>'/workspace/attached/turn-1-1/daemon.stderr'",
        options: {
          cwd: "/opt/stella",
          processId: "attached-daemon-agent-run-turn-1",
        },
      },
    ]);
    // Nothing was started inside the session shell.
    expect(fake.processes).toEqual([]);
  });

  test("a shell that exits under a bridge call surfaces as a tool error and is reported once", async () => {
    const fake = fakeSession({ resultFrame: COMPLETED_FRAME });
    const shellExited = () => {
      const error = new Error(
        "Session 'agent-run-turn-1' ended because its shell exited (exit code: 1)",
      );
      error.name = "SessionTerminatedError";
      return error;
    };
    let deleteCalls = 0;
    const session = {
      ...fake.session,
      deleteFile: async () => {
        deleteCalls += 1;
        throw shellExited();
      },
    };
    const events: Array<{ kind: string; payload: unknown }> = [];
    const attachment = createAgentSandboxAttachment({
      context: liveContext(),
      attachWorld: async () => ({
        session: session as never,
        coldContainerStartMs: 10,
        restoreMs: 5,
      }),
      prepareBrokerHandoff: async () => HANDOFF,
      release: async () => undefined,
      destroy: async () => undefined,
      emitEvent: (kind, payload) => {
        events.push({ kind, payload });
      },
    });
    await attachment.boot({ ...BOOT, instanceSize: "small" });

    await expect(
      attachment.callTool({ sandboxId: "agent-turn-1", request: TOOL_REQUEST }),
    ).rejects.toThrow(
      /workspace shell exited under that call: .*shell exited \(exit code: 1\)/u,
    );
    await expect(
      attachment.callTool({ sandboxId: "agent-turn-1", request: TOOL_REQUEST }),
    ).rejects.toThrow(AttachedToolHostUnavailableError);

    expect(deleteCalls).toBe(2);
    const reported = events.filter(
      (e) => e.kind === "attached_session_terminated",
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]!.payload).toMatchObject({
      error: expect.stringContaining("shell exited (exit code: 1)"),
    });
  });

  test("a missing stale result is still not an error", async () => {
    const fake = fakeSession({ resultFrame: COMPLETED_FRAME });
    const session = {
      ...fake.session,
      deleteFile: async () => {
        throw new Error("ENOENT: no such file");
      },
    };
    const attachment = createAgentSandboxAttachment({
      context: liveContext(),
      attachWorld: async () => ({
        session: session as never,
        coldContainerStartMs: 10,
        restoreMs: 5,
      }),
      prepareBrokerHandoff: async () => HANDOFF,
      release: async () => undefined,
      destroy: async () => undefined,
    });
    await attachment.boot({ ...BOOT, instanceSize: "small" });
    const response = await attachment.callTool({
      sandboxId: "agent-turn-1",
      request: TOOL_REQUEST,
    });
    expect(response).toMatchObject({ status: "completed" });
  });
});
