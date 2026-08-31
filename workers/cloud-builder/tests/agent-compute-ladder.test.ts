import { describe, expect, test } from "bun:test";
import {
  agentComputeKey,
  createAgentComputeLadder,
  parsePersistedAgentCompute,
  SandboxOutOfMemoryError,
  type AgentComputeStore,
  type AgentWorldLeaseHooks,
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
    callTool?: (request: AttachedToolRequest) => Promise<AttachedToolResponse>;
    notices?: readonly string[];
    deliveredFiles?: readonly string[];
    worldLease?: boolean;
    retireWorldLease?: AgentWorldLeaseHooks["retire"];
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
    destroy: async (sandboxId) => {
      journal.calls.push(`destroy:${sandboxId}`);
    },
  };

  const cancellation = createTurnRetryCancellation();
  const worldLease: AgentWorldLeaseHooks | undefined = options.worldLease
    ? {
        leaseId: "world-turn-1-1",
        acquire: async (identity) => {
          expect(identity.role).toBe("world");
          journal.calls.push(`lease:acquire:${identity.leaseId}`);
          return { generation: "lease-generation-1", expiresAt: 31_000 };
        },
        renew: async (identity) => {
          journal.calls.push(`lease:renew:${identity.leaseId}`);
          return { expiresAt: 61_000 };
        },
        retire: async (identity) => {
          journal.calls.push(`lease:retire:${identity.leaseId}`);
          await options.retireWorldLease?.(identity);
        },
      }
    : undefined;
  const ladder = createAgentComputeLadder({
    ...IDENTITY,
    sandboxId: SANDBOX_ID,
    initialInstanceSize: "small",
    store,
    attachment,
    worldLease,
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

  test("the first attach acquires one exact durable world lease", async () => {
    const { ladder, journal, record } = harness({ worldLease: true });

    await Promise.all([
      ladder.execute(call("call-1")),
      ladder.execute(call("call-2")),
      ladder.execute(call("call-3")),
    ]);

    expect(
      journal.calls.filter((entry) => entry.startsWith("lease:acquire:")),
    ).toEqual(["lease:acquire:world-turn-1-1"]);
    expect(journal.records[0]).toMatchObject({
      phase: "attaching",
      sandboxId: SANDBOX_ID,
      worldLease: {
        leaseId: "world-turn-1-1",
        phase: "registering",
      },
    });
    expect(record()).toMatchObject({
      schemaVersion: 2,
      phase: "attached",
      worldLease: {
        leaseId: "world-turn-1-1",
        phase: "registered",
        generation: "lease-generation-1",
      },
    });
    expect(record()?.worldLease?.expiresAt).toBeGreaterThanOrEqual(31_000);
  });

  test("a chat-only resident turn never acquires a world lease", async () => {
    const { ladder, journal, record } = harness({ worldLease: true });

    await ladder.quiesce();
    await ladder.teardown();

    expect(journal.calls.filter((entry) => entry.startsWith("lease:"))).toEqual(
      [],
    );
    expect(record()).toBeNull();
    expect(ladder.worldLease()).toBeNull();
  });

  test("renew updates the exact registered world lease", async () => {
    const { ladder, journal, record } = harness({ worldLease: true });

    await ladder.execute(call("call-1"));
    await ladder.renewWorldLease();

    expect(journal.calls).toContain("lease:renew:world-turn-1-1");
    expect(record()?.worldLease).toEqual({
      leaseId: "world-turn-1-1",
      phase: "registered",
      generation: "lease-generation-1",
      expiresAt: 61_000,
    });
  });

  test("teardown destroys before retiring and leaves no world lease", async () => {
    const { ladder, journal, record } = harness({ worldLease: true });

    await ladder.execute(call("call-1"));
    await ladder.teardown();

    const destroyAt = journal.calls.indexOf(`destroy:${SANDBOX_ID}`);
    const retireAt = journal.calls.indexOf("lease:retire:world-turn-1-1");
    expect(destroyAt).toBeGreaterThanOrEqual(0);
    expect(retireAt).toBeGreaterThan(destroyAt);
    expect(record()?.phase).toBe("quiesced");
    expect(record()?.worldLease).toBeUndefined();
    expect(ladder.worldLease()).toBeNull();
  });

  test("a failed retirement leaves durable unregister debt for retry", async () => {
    let retires = 0;
    const { ladder, record } = harness({
      worldLease: true,
      retireWorldLease: async () => {
        retires += 1;
        if (retires === 1) throw new Error("lost unregister response");
      },
    });

    await ladder.execute(call("call-1"));
    await expect(ladder.teardown()).rejects.toThrow("lost unregister response");
    expect(record()?.worldLease).toMatchObject({
      leaseId: "world-turn-1-1",
      phase: "unregister_pending",
      generation: "lease-generation-1",
    });

    await ladder.teardown();
    expect(retires).toBe(2);
    expect(record()?.worldLease).toBeUndefined();
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
    expect(journal.calls.at(-1)).toBe(`destroy:${SANDBOX_ID}`);
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

  test("a resident turn that asked for the interior build attaches after the loop", async () => {
    const { ladder, journal, events } = harness();

    ladder.requestInteriorBuild();
    expect(ladder.attached()).toBe(false);
    await ladder.attachForInteriorBuild();

    expect(ladder.attached()).toBe(true);
    expect(journal.calls[0]).toBe(`boot:${SANDBOX_ID}:small`);
    expect(events[0]?.payload).toMatchObject({ reason: "interior_build" });
  });

  test("a stop landing mid-boot still destroys the reserved instance", async () => {
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
    expect(journal.calls).toContain(`destroy:${SANDBOX_ID}`);

    release?.();
    await running;
  });

  test("teardown destroys exactly what attached, and only that", async () => {
    const resident = harness();
    await resident.ladder.teardown();
    expect(resident.journal.calls).toEqual([]);

    const attachedRun = harness();
    await attachedRun.ladder.execute(call("call-1"));
    await attachedRun.ladder.teardown();
    await attachedRun.ladder.teardown();

    expect(
      attachedRun.journal.calls.filter((entry) => entry.startsWith("destroy:")),
    ).toEqual([`destroy:${SANDBOX_ID}`, `destroy:${SANDBOX_ID}`]);
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

describe("persisted compute record", () => {
  const record: PersistedAgentCompute = {
    schemaVersion: 1,
    ...IDENTITY,
    phase: "attached",
    instanceSize: "small",
    sandboxId: SANDBOX_ID,
  };

  test("keys are scoped to the exact attempt", () => {
    expect(agentComputeKey("turn-1", 2)).toBe("agentCompute:turn-1:2");
  });

  test("reads back a record written by this attempt", () => {
    expect(parsePersistedAgentCompute(record, IDENTITY)).toEqual(record);
  });

  test("reads schema v2 with an exact world lease", () => {
    const versionTwo: PersistedAgentCompute = {
      schemaVersion: 2,
      ...IDENTITY,
      phase: "attached",
      instanceSize: "small",
      sandboxId: SANDBOX_ID,
      attachReason: "process_tool",
      worldLease: {
        leaseId: "world-turn-1-1",
        phase: "registered",
        generation: "lease-generation-1",
        expiresAt: 31_000,
      },
    };

    expect(parsePersistedAgentCompute(versionTwo, IDENTITY)).toEqual(
      versionTwo,
    );
  });

  test("refuses a resident record that claims a world lease", () => {
    expect(
      parsePersistedAgentCompute(
        {
          schemaVersion: 2,
          ...IDENTITY,
          phase: "resident",
          instanceSize: "small",
          worldLease: {
            leaseId: "world-turn-1-1",
            phase: "registered",
          },
        },
        IDENTITY,
      ),
    ).toBeNull();
  });

  test("refuses a record left by another attempt", () => {
    expect(
      parsePersistedAgentCompute(record, {
        turnId: "turn-1",
        attemptGeneration: 2,
      }),
    ).toBeNull();
  });

  test("refuses an attached record with no instance to destroy", () => {
    const { sandboxId: _omitted, ...withoutSandbox } = record;
    expect(parsePersistedAgentCompute(withoutSandbox, IDENTITY)).toBeNull();
  });
});
