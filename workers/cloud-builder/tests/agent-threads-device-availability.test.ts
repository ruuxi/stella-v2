import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import {
  DispatchError,
  type AgentCompletionDelivery,
  type DeviceAgentTurnDispatch,
} from "../src/owner-store/registry.js";
import {
  createOwnerStoreHarness,
  type OwnerStoreHarness,
} from "./helpers/owner-store-harness.js";

const UNAVAILABLE = "The selected computer is offline.";

const harnesses: OwnerStoreHarness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

/**
 * The refusals a device offer can come back with. "offline" is the dispatch
 * record's own availability code; "gate-busy" and "gate-transient" are the
 * gate's admission vocabulary, which is a different set of strings and which
 * the queue used to treat as fatal; "signed-out" is genuinely permanent.
 */
type Outcome =
  | "offline"
  | "gate-busy"
  | "gate-transient"
  | "signed-out"
  | "accepted";

const GATE_BUSY = "Stella can't take another agent right now.";
const GATE_TRANSIENT = "Stella can't check your account right now.";
const SIGNED_OUT = "Sign in to Stella to use cloud agents.";

const refusalFor = (outcome: Outcome): DispatchError | null => {
  switch (outcome) {
    case "offline":
      return new DispatchError(UNAVAILABLE, false, "SELECTED_DEVICE_OFFLINE");
    case "gate-busy":
      return new DispatchError(GATE_BUSY, false, "capability_unavailable");
    case "gate-transient":
      return new DispatchError(GATE_TRANSIENT, true, "internal");
    case "signed-out":
      return new DispatchError(SIGNED_OUT, false, "sign_in_required");
    default:
      return null;
  }
};

const open = (options: {
  device: Partial<DeviceDestination>;
  outcomes: Outcome[];
  /** What the device says when input is handed to a live dispatch. */
  steerDelivered?: boolean;
}) => {
  const dispatched: DeviceAgentTurnDispatch[] = [];
  const delivered: AgentCompletionDelivery[] = [];
  const steered: Array<{ dispatchId: string; messageId: string; text: string }> =
    [];
  const harness = createOwnerStoreHarness({
    host: {
      deviceDestinations: async () => [
        {
          deviceId: "desk-1",
          label: "omarchy",
          remoteExecutionEnabled: true,
          online: true,
          ...options.device,
        },
      ],
      dispatchDeviceAgentTurn: async (input) => {
        dispatched.push(input);
        const refusal = refusalFor(options.outcomes.shift() ?? "offline");
        if (refusal) throw refusal;
        return { dispatchId: `dsp-${dispatched.length}` };
      },
      steerDeviceAgentTurn: async (input) => {
        steered.push(input);
        return options.steerDelivered === false
          ? { delivered: false, reason: "not_running" as const }
          : { delivered: true };
      },
      deliverAgentCompletion: async (input) => {
        delivered.push(input);
      },
    },
  });
  harnesses.push(harness);
  return { harness, dispatched, delivered, steered };
};

const spawn = async (harness: OwnerStoreHarness, clientMsgId = "client-msg-0001") => {
  const response = await harness.store.internalCall("agentThreads.spawnOnDevice", {
    ownerGeneration: "generation-1",
    conversationId: "conversation-1",
    parentTurnId: "parent-turn-1",
    clientMsgId,
    targetDeviceId: "desk-1",
    description: "Survey the project",
    prompt: "Survey the project and report back.",
  });
  if (!response.ok) throw new Error(response.error.message);
  return response.value as { threadId: string; status: string; waitingForDevice?: boolean };
};

const threadOf = async (harness: OwnerStoreHarness, threadId: string) => {
  const response = await harness.store.internalCall("agentThreads.deviceThread", {
    ownerGeneration: "generation-1",
    conversationId: "conversation-1",
    threadId,
  });
  if (!response.ok) throw new Error(response.error.message);
  return response.value as { status: string; errorMessage?: string };
};

describe("a device agent spawned onto an offline computer", () => {
  test("is queued, then dispatched with its prompt once the computer reconnects", async () => {
    const { harness, dispatched } = open({
      device: { online: false },
      outcomes: ["offline", "accepted"],
    });
    const spawned = await spawn(harness);
    expect(spawned).toMatchObject({ status: "running", waitingForDevice: true });

    const start = Date.now();
    await harness.runJobs(start + 1_000);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.requeue).toBeUndefined();
    expect((await threadOf(harness, spawned.threadId)).status).toBe("running");

    await harness.runJobs(start + 12_000);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).toMatchObject({
      requeue: 1,
      prompt: "Survey the project and report back.",
    });
    expect((await threadOf(harness, spawned.threadId)).status).toBe("running");
  });

  test("fails honestly when the computer stays offline past the wait", async () => {
    const { harness, delivered } = open({
      device: { online: false },
      outcomes: [],
    });
    const spawned = await spawn(harness);
    await harness.runJobs(Date.now() + 61 * 60_000);
    const thread = await threadOf(harness, spawned.threadId);
    expect(thread.status).toBe("failed");
    expect(thread.errorMessage).toContain("computer is offline");
    expect(thread.errorMessage).toContain("did not become available within 60 minutes");
    expect(delivered).toHaveLength(1);
  });

  test("a offline report for a lapsed offer requeues instead of failing", async () => {
    const { harness, dispatched } = open({
      device: {},
      outcomes: ["accepted", "accepted"],
    });
    const spawned = await spawn(harness);
    const start = Date.now();
    await harness.runJobs(start + 1_000);
    expect(dispatched).toHaveLength(1);
    const settled = await harness.store.internalCall("agentThreads.deviceSettled", {
      turnId: dispatched[0]!.turnId,
      requeue: 0,
      state: "blocked",
      errorCode: "SELECTED_DEVICE_OFFLINE",
      errorMessage: UNAVAILABLE,
    });
    expect(settled).toMatchObject({ ok: true, value: { settled: false } });
    expect((await threadOf(harness, spawned.threadId)).status).toBe("running");
    await harness.runJobs(start + 12_000);
    expect(dispatched[1]).toMatchObject({ requeue: 1 });
  });
});

describe("a device offer the gate refuses before it reaches the computer", () => {
  test("stays queued for the whole stated wait instead of a few attempts", async () => {
    const { harness, dispatched } = open({
      device: {},
      outcomes: ["gate-busy", "gate-busy", "gate-busy", "gate-busy", "accepted"],
    });
    const spawned = await spawn(harness);
    const start = Date.now();
    // Four refusals is already past the old three-attempt dispatch cap, which
    // expired a "queued" agent in well under a minute.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await harness.runJobs(start + attempt * 11_000);
    }
    expect(dispatched).toHaveLength(5);
    expect((await threadOf(harness, spawned.threadId)).status).toBe("running");
  });

  test("fails with the wait it promised, not the raw refusal", async () => {
    const { harness } = open({ device: {}, outcomes: [] });
    const spawned = await spawn(harness);
    await harness.runJobs(Date.now() + 61 * 60_000);
    const thread = await threadOf(harness, spawned.threadId);
    expect(thread.status).toBe("failed");
    expect(thread.errorMessage).toContain(
      "did not become available within 60 minutes",
    );
  });

  test("a transient gate failure is queued too", async () => {
    const { harness, dispatched } = open({
      device: {},
      outcomes: ["gate-transient", "accepted"],
    });
    const spawned = await spawn(harness);
    const start = Date.now();
    await harness.runJobs(start + 1_000);
    await harness.runJobs(start + 12_000);
    expect(dispatched).toHaveLength(2);
    expect((await threadOf(harness, spawned.threadId)).status).toBe("running");
  });

  test("a permanent refusal still fails at once and says why", async () => {
    const { harness } = open({ device: {}, outcomes: ["signed-out"] });
    const spawned = await spawn(harness);
    await harness.runJobs(Date.now() + 1_000);
    const thread = await threadOf(harness, spawned.threadId);
    expect(thread.status).toBe("failed");
    expect(thread.errorMessage).toContain(SIGNED_OUT);
    expect(thread.errorMessage).not.toContain("did not become available");
  });
});

describe("input sent to a device agent that has no live dispatch yet", () => {
  const sendInput = async (
    harness: OwnerStoreHarness,
    threadId: string,
    controlRequestId: string,
    prompt: string,
  ) =>
    await harness.store.internalCall("agentThreads.continueOnDevice", {
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      threadId,
      controlRequestId,
      description: "Survey the project",
      prompt,
    });

  test("is held with the attempt and handed over when the offer lands", async () => {
    const { harness, steered } = open({
      device: { online: false },
      outcomes: ["offline", "accepted"],
    });
    const spawned = await spawn(harness);
    const start = Date.now();
    await harness.runJobs(start + 1_000);

    const accepted = await sendInput(
      harness,
      spawned.threadId,
      "control-request-0001",
      "Also check the tests.",
    );
    expect(accepted.ok).toBe(true);
    expect(steered).toHaveLength(0);

    await harness.runJobs(start + 12_000);
    expect(steered).toEqual([
      {
        dispatchId: "dsp-2",
        messageId: "control-request-0001",
        text: "Also check the tests.",
      },
    ]);
  });

  test("keeps its order and survives a device that will not take it yet", async () => {
    const { harness, steered } = open({
      device: { online: false },
      outcomes: ["offline", "accepted", "accepted"],
      steerDelivered: false,
    });
    const spawned = await spawn(harness);
    const start = Date.now();
    await harness.runJobs(start + 1_000);
    await sendInput(
      harness,
      spawned.threadId,
      "control-request-0001",
      "First note.",
    );
    await sendInput(
      harness,
      spawned.threadId,
      "control-request-0002",
      "Second note.",
    );
    await harness.runJobs(start + 12_000);
    // The first hand-over is refused, so nothing is dropped and the rest is
    // not sent out of order.
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({ text: "First note." });
  });
});

describe("a running device agent's reported progress", () => {
  const report = async (
    harness: OwnerStoreHarness,
    turnId: string,
    activity: Record<string, unknown>,
  ) =>
    await harness.store.internalCall("agentThreads.deviceActivity", {
      turnId,
      ...activity,
    });

  const lookup = async (harness: OwnerStoreHarness, threadId: string) => {
    const response = await harness.store.internalCall("agentThreads.conversationThread", {
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      threadId,
    });
    if (!response.ok) throw new Error(response.error.message);
    return response.value as {
      status: string;
      updatedAt: number;
      activity?: { lastActivityAt: number; label?: string; activeToolCount?: number };
    };
  };

  test("answers whether it is working without stamping the thread as changed", async () => {
    const { harness, dispatched } = open({ device: {}, outcomes: ["accepted"] });
    const spawned = await spawn(harness);
    await harness.runJobs(Date.now() + 1_000);
    const before = await lookup(harness, spawned.threadId);
    expect(before.activity).toBeUndefined();

    expect(
      await report(harness, dispatched[0]!.turnId, {
        lastActivityAt: 1_700_000_000_000,
        label: "Running exec_command",
        activeToolCount: 1,
      }),
    ).toMatchObject({ ok: true, value: { recorded: true } });

    const after = await lookup(harness, spawned.threadId);
    expect(after.activity).toEqual({
      lastActivityAt: 1_700_000_000_000,
      label: "Running exec_command",
      activeToolCount: 1,
    });
    // Progress is not a thread change: a watcher must not be woken by it.
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  test("is dropped once the attempt is over, so a finished agent never looks stalled", async () => {
    const { harness, dispatched } = open({ device: {}, outcomes: ["accepted"] });
    const spawned = await spawn(harness);
    await harness.runJobs(Date.now() + 1_000);
    await report(harness, dispatched[0]!.turnId, { lastActivityAt: 1_700_000_000_000 });
    await harness.store.internalCall("agentThreads.deviceSettled", {
      turnId: dispatched[0]!.turnId,
      state: "completed",
      resultJson: JSON.stringify({ finalText: "Done." }),
    });
    const settled = await lookup(harness, spawned.threadId);
    expect(settled.status).toBe("completed");
    expect(settled.activity).toBeUndefined();
    expect(
      await report(harness, dispatched[0]!.turnId, { lastActivityAt: 1_700_000_100_000 }),
    ).toMatchObject({ ok: true, value: { recorded: false } });
  });

  test("does not carry over to the next attempt", async () => {
    const { harness, dispatched } = open({
      device: {},
      outcomes: ["accepted", "accepted"],
    });
    const spawned = await spawn(harness);
    await harness.runJobs(Date.now() + 1_000);
    await report(harness, dispatched[0]!.turnId, { lastActivityAt: 1_700_000_000_000 });
    await harness.store.internalCall("agentThreads.deviceSettled", {
      turnId: dispatched[0]!.turnId,
      state: "completed",
      resultJson: JSON.stringify({ finalText: "Done." }),
    });
    const continued = await harness.store.internalCall("agentThreads.continueOnDevice", {
      ownerGeneration: "generation-1",
      conversationId: "conversation-1",
      threadId: spawned.threadId,
      controlRequestId: "control-request-0009",
      description: "Survey the project",
      prompt: "Now check the docs.",
    });
    expect(continued.ok).toBe(true);
    const resumed = await lookup(harness, spawned.threadId);
    expect(resumed.status).toBe("running");
    expect(resumed.activity).toBeUndefined();
  });
});

describe("several device agents spawned onto one online computer", () => {
  test("all start right away instead of waiting for each other", async () => {
    const { harness, dispatched } = open({
      device: { availability: { ready: true, capabilities: ["agent"] } },
      outcomes: ["accepted", "accepted", "accepted"],
    });
    const spawned = [
      await spawn(harness, "client-msg-0001"),
      await spawn(harness, "client-msg-0002"),
      await spawn(harness, "client-msg-0003"),
    ];
    for (const thread of spawned) {
      expect(thread.status).toBe("running");
      expect(thread.waitingForDevice).toBeUndefined();
    }
    await harness.runJobs(Date.now() + 1_000);
    expect(dispatched).toHaveLength(3);
    expect(new Set(dispatched.map((input) => input.threadId)).size).toBe(3);
    for (const input of dispatched) expect(input.requeue).toBeUndefined();
    for (const thread of spawned) {
      expect((await threadOf(harness, thread.threadId)).status).toBe("running");
    }
  });
});

describe("a device agent spawned onto a computer that is not accepting work", () => {
  test("is queued at spawn until it starts accepting work", async () => {
    const { harness, dispatched } = open({
      device: { availability: { ready: false, capabilities: [] } },
      outcomes: [],
    });
    expect(await spawn(harness)).toMatchObject({ waitingForDevice: true });
    expect(dispatched).toHaveLength(0);
  });
});
