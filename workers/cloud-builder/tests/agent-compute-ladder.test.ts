import { describe, expect, test } from "bun:test";
import {
  agentComputeKey,
  createAgentComputeLadder,
  createLazySandboxAttachment,
  parsePersistedAgentCompute,
  SandboxOutOfMemoryError,
  type AgentComputeStore,
  type AttachBoot,
  type PersistedAgentCompute,
  type SandboxAttachment,
} from "../src/agent-compute-ladder.js";
import {
  ATTACHED_TOOL_PROTOCOL_VERSION,
  type AttachedToolControlResponse,
  type AttachedToolRequest,
  type AttachedToolResponse,
  type SerializedAgentToolResult,
} from "@stella/executor-cloud/attached-tool-protocol";
import { createTurnRetryCancellation } from "../src/turn-cancellation.js";

const IDENTITY = { turnId: "turn-1", attemptGeneration: 1 } as const;
const SANDBOX_ID = "agent-turn-1-abc";
const SESSION_ID = "agent-run-turn-1";
const DAEMON_DIRECTORY = "/workspace/attached/turn-1-1";

const OK: SerializedAgentToolResult = {
  outcome: { kind: "ok", text: "listed" },
  details: null,
  authorizedImages: [],
};

type Journal = {
  readonly phases: string[];
  readonly calls: string[];
  readonly records: PersistedAgentCompute[];
};

const harness = (
  options: {
    boot?: (args: { instanceSize: "small" | "large" }) => Promise<AttachBoot>;
    selectInstanceSize?: (
      initial: "small" | "large",
    ) => Promise<"small" | "large">;
    callTool?: (request: AttachedToolRequest) => Promise<AttachedToolResponse>;
    notices?: readonly string[];
    deliveredFiles?: readonly string[];
  } = {},
) => {
  const journal: Journal = { phases: [], calls: [], records: [] };
  const events: Array<{ kind: string; payload: unknown }> = [];
  let persisted: PersistedAgentCompute | null = null;

  const store: AgentComputeStore = {
    read: async () => persisted,
    write: async (record) => {
      persisted = record;
      journal.phases.push(record.phase);
      journal.records.push(structuredClone(record));
    },
  };

  const attachment: SandboxAttachment = {
    boot: async (args) => {
      journal.calls.push(`boot:${args.sandboxId}:${args.instanceSize}`);
      return options.boot
        ? await options.boot(args)
        : { coldStartMs: 3_000, restoreMs: 400 };
    },
    callTool: async ({ request }) => {
      journal.calls.push(`tool:${request.toolName}:${request.toolCallId}`);
      return options.callTool
        ? await options.callTool(request)
        : {
            version: ATTACHED_TOOL_PROTOCOL_VERSION,
            status: "completed",
            toolCallId: request.toolCallId,
            fingerprint: request.fingerprint,
            result: OK,
          };
    },
    control: async ({ control }): Promise<AttachedToolControlResponse> => {
      journal.calls.push(`control:${control}`);
      return control === "boot_report"
        ? {
            version: ATTACHED_TOOL_PROTOCOL_VERSION,
            status: "boot_report",
            notices: options.notices ?? [],
          }
        : {
            version: ATTACHED_TOOL_PROTOCOL_VERSION,
            status: "quiesced",
            deliveredFiles: options.deliveredFiles ?? [],
          };
    },
    release: async ({ sessionId, daemonDirectory }) => {
      journal.calls.push(`release:${sessionId}:${daemonDirectory}`);
    },
    destroy: async ({ sandboxId }) => {
      journal.calls.push(`destroy:${sandboxId}`);
    },
  };

  const cancellation = createTurnRetryCancellation();
  const ladder = createAgentComputeLadder({
    ...IDENTITY,
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    daemonDirectory: DAEMON_DIRECTORY,
    initialInstanceSize: "small",
    selectInstanceSize:
      options.selectInstanceSize ?? (async (initial) => initial),
    rememberInstanceSize: async (size) => {
      journal.calls.push(`remember:${size}`);
    },
    store,
    attachment,
    context: {
      cancellation,
      signal: AbortSignal.timeout(30_000),
      assertActive: () => {},
    },
    emitEvent: (kind, payload) => events.push({ kind, payload }),
    now: () => 1_000,
  });

  return { ladder, journal, events, record: () => persisted };
};

const call = (toolCallId: string, toolName = "exec_command") => ({
  toolCallId,
  toolName,
  params: { command: "ls" },
});

describe("agent compute ladder", () => {
  test("a chat-only turn touches no container at all", async () => {
    const { ladder, journal, events, record } = harness();

    await ladder.quiesce();
    await ladder.teardown();

    expect(journal.calls).toEqual([]);
    expect(events).toEqual([]);
    expect(record()).toBeNull();
    expect(ladder.compute()).toEqual({ kind: "resident" });
  });

  test("the reservation is durable before the instance is created", async () => {
    const { ladder, journal } = harness({
      boot: async () => {
        // Whatever the record says at this instant is what a Stop arriving
        // mid-boot has to work from.
        journal.calls.push("boot-observed-phase:attaching");
        return { coldStartMs: 100, restoreMs: 10 };
      },
    });

    await ladder.execute(call("call-1"));

    expect(journal.phases[0]).toBe("attaching");
    expect(journal.calls[0]).toBe(`boot:${SANDBOX_ID}:small`);
    expect(journal.phases).toEqual(["attaching", "attached"]);
  });

  test("the first real attach adopts the size remembered by the world", async () => {
    let selected = 0;
    const { ladder, journal, record } = harness({
      selectInstanceSize: async (initial) => {
        selected += 1;
        expect(initial).toBe("small");
        return "large";
      },
    });

    await ladder.execute(call("call-1"));

    expect(selected).toBe(1);
    expect(journal.calls[0]).toBe(`boot:${SANDBOX_ID}:large`);
    expect(record()?.instanceSize).toBe("large");
  });

  test("concurrent first calls share one attach", async () => {
    const { ladder, journal } = harness();

    await Promise.all([
      ladder.execute(call("call-1")),
      ladder.execute(call("call-2")),
      ladder.execute(call("call-3")),
    ]);

    expect(journal.calls.filter((entry) => entry.startsWith("boot:"))).toEqual([
      `boot:${SANDBOX_ID}:small`,
    ]);
  });

  test("attachment is sticky: later calls never boot again", async () => {
    const { ladder, journal } = harness();

    await ladder.execute(call("call-1"));
    await ladder.execute(call("call-2", "Read"));

    expect(journal.phases).toEqual(["attaching", "attached"]);
    expect(journal.calls.filter((entry) => entry.startsWith("boot:"))).toEqual([
      `boot:${SANDBOX_ID}:small`,
    ]);
  });

  test("sandbox_ready fires once, only on a real attach", async () => {
    const { ladder, events } = harness();

    await ladder.execute(call("call-1"));
    await ladder.execute(call("call-2"));

    expect(events).toEqual([
      {
        kind: "sandbox_ready",
        payload: {
          attachedMidTurn: true,
          instanceSize: "small",
          reason: "process_tool",
        },
      },
    ]);
  });

  test("the boot report rides the attach-triggering result and only that one", async () => {
    const { ladder } = harness({ notices: ["Your drive is on disk."] });

    const first = await ladder.execute(call("call-1"));
    const second = await ladder.execute(call("call-2"));

    if (first.outcome.kind !== "ok" || second.outcome.kind !== "ok") {
      throw new Error("expected both calls to succeed");
    }
    expect(first.outcome.text).toBe("listed\n\nYour drive is on disk.");
    expect(second.outcome.text).toBe("listed");
  });

  test("a pending replay is reported, never re-run", async () => {
    const { ladder, journal } = harness({
      callTool: async (request) => ({
        version: ATTACHED_TOOL_PROTOCOL_VERSION,
        status: "pending",
        toolCallId: request.toolCallId,
        fingerprint: request.fingerprint,
      }),
    });

    const result = await ladder.execute(call("call-1"));

    expect(result.outcome.kind).toBe("error");
    expect(journal.calls.filter((entry) => entry.startsWith("tool:"))).toEqual([
      "tool:exec_command:call-1",
    ]);
  });

  test("an unbridged tool never reaches the daemon", async () => {
    const { ladder, journal } = harness();

    await expect(ladder.execute(call("call-1", "code"))).rejects.toThrow();
    expect(journal.calls).toEqual([]);
  });

  test("an out-of-memory kill before any command retries once at large", async () => {
    let boots = 0;
    const { ladder, journal } = harness({
      boot: async () => {
        boots += 1;
        if (boots === 1) throw new SandboxOutOfMemoryError();
        return { coldStartMs: 100, restoreMs: 10 };
      },
    });

    const result = await ladder.execute(call("call-1"));

    expect(result.outcome.kind).toBe("ok");
    expect(journal.calls).toEqual([
      `boot:${SANDBOX_ID}:small`,
      `destroy:${SANDBOX_ID}`,
      "remember:large",
      `boot:${SANDBOX_ID}:large`,
      "control:boot_report",
      "tool:exec_command:call-1",
    ]);
  });

  test("an out-of-memory kill after a command fails the turn instead of replaying", async () => {
    let calls = 0;
    const { ladder, journal } = harness({
      callTool: async (request) => {
        calls += 1;
        if (calls === 1) {
          return {
            version: ATTACHED_TOOL_PROTOCOL_VERSION,
            status: "completed",
            toolCallId: request.toolCallId,
            fingerprint: request.fingerprint,
            result: OK,
          };
        }
        throw new SandboxOutOfMemoryError();
      },
    });

    await ladder.execute(call("call-1"));
    await expect(ladder.execute(call("call-2"))).rejects.toThrow(
      SandboxOutOfMemoryError,
    );

    expect(calls).toBe(2);
    expect(journal.calls.slice(-2)).toEqual([
      `destroy:${SANDBOX_ID}`,
      "remember:large",
    ]);
    expect(journal.phases.at(-1)).toBe("quiesced");
  });

  test("quiesce joins the daemon once and reports what it delivered", async () => {
    const { ladder, journal } = harness({
      deliveredFiles: ["out.txt"],
    });

    await ladder.execute(call("call-1"));
    const first = await ladder.quiesce(["/world/drive/out.txt"]);
    const again = await ladder.quiesce(["/world/drive/out.txt"]);

    expect(first.deliveredFiles).toEqual(["out.txt"]);
    expect(again).toEqual(first);
    expect(
      journal.calls.filter((entry) => entry === "control:quiesce"),
    ).toEqual(["control:quiesce"]);
  });

  test("a stop landing mid-boot releases the reserved session", async () => {
    let release: (() => void) | null = null;
    let entered: (() => void) | null = null;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const booting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { ladder, journal } = harness({
      boot: async () => {
        entered?.();
        await stalled;
        return { coldStartMs: 100, restoreMs: 10 };
      },
    });

    const running = ladder.execute(call("call-1"));
    await booting;
    // The boot has not returned, so nothing has told the ladder an instance
    // exists. The durable record written before it is the only thing a sweep
    // arriving now can act on.
    expect(journal.phases).toEqual(["attaching"]);
    await ladder.teardown();
    expect(journal.calls).toContain(
      `release:${SESSION_ID}:${DAEMON_DIRECTORY}`,
    );

    release?.();
    await running;
  });

  test("teardown releases exactly what attached, and only once", async () => {
    const resident = harness();
    await resident.ladder.teardown();
    expect(resident.journal.calls).toEqual([]);

    const attachedRun = harness();
    await attachedRun.ladder.execute(call("call-1"));
    await attachedRun.ladder.teardown();
    await attachedRun.ladder.teardown();

    expect(
      attachedRun.journal.calls.filter((entry) => entry.startsWith("release:")),
    ).toEqual([`release:${SESSION_ID}:${DAEMON_DIRECTORY}`]);
  });

  test("the compute record names the reason it attached", async () => {
    const { ladder } = harness();

    await ladder.execute(call("call-1", "Read"));

    expect(ladder.compute()).toEqual({
      kind: "sandbox",
      reason: "filesystem_tool",
      instanceSize: "small",
      coldStartMs: 3_000,
      restoreMs: 400,
    });
  });
});

describe("lazy sandbox attachment", () => {
  test("loads once on first feature call and forwards subsequent calls", async () => {
    const calls: string[] = [];
    let loads = 0;
    const attachment = createLazySandboxAttachment(async () => {
      loads += 1;
      return {
        boot: async () => ({ coldStartMs: 1, restoreMs: 2 }),
        callTool: async ({ request }) => {
          calls.push(request.toolCallId);
          return {
            version: ATTACHED_TOOL_PROTOCOL_VERSION,
            toolCallId: request.toolCallId,
            result: OK,
          };
        },
        control: async () => ({
          version: ATTACHED_TOOL_PROTOCOL_VERSION,
          status: "quiesced",
          deliveredFiles: [],
        }),
        release: async () => {},
        destroy: async () => {},
      };
    });

    expect(loads).toBe(0);
    await Promise.all([
      attachment.callTool({ sandboxId: SANDBOX_ID, request: call("call-a") }),
      attachment.callTool({ sandboxId: SANDBOX_ID, request: call("call-b") }),
    ]);
    expect(loads).toBe(1);
    expect(calls).toEqual(["call-a", "call-b"]);
  });
});

describe("persisted compute record", () => {
  const record: PersistedAgentCompute = {
    schemaVersion: 1,
    ...IDENTITY,
    phase: "attached",
    instanceSize: "small",
    sandboxId: SANDBOX_ID,
    sessionId: SESSION_ID,
    daemonDirectory: DAEMON_DIRECTORY,
  };

  test("keys are scoped to the exact attempt", () => {
    expect(agentComputeKey("turn-1", 2)).toBe("agentCompute:turn-1:2");
  });

  test("reads back a record written by this attempt", () => {
    expect(parsePersistedAgentCompute(record, IDENTITY)).toEqual(record);
  });

  test("refuses a record left by another attempt", () => {
    expect(
      parsePersistedAgentCompute(record, {
        turnId: "turn-1",
        attemptGeneration: 2,
      }),
    ).toBeNull();
  });

  test("refuses an attached record with no sandbox", () => {
    const { sandboxId: _omitted, ...withoutSandbox } = record;
    expect(parsePersistedAgentCompute(withoutSandbox, IDENTITY)).toBeNull();
  });
});
