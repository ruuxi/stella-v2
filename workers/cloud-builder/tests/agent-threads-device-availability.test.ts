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

const open = (options: {
  device: Partial<DeviceDestination>;
  outcomes: Array<"offline" | "accepted">;
}) => {
  const dispatched: DeviceAgentTurnDispatch[] = [];
  const delivered: AgentCompletionDelivery[] = [];
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
        const outcome = options.outcomes.shift() ?? "offline";
        if (outcome === "offline") {
          throw new DispatchError(UNAVAILABLE, false, "SELECTED_DEVICE_OFFLINE");
        }
        return { dispatchId: `dsp-${dispatched.length}` };
      },
      deliverAgentCompletion: async (input) => {
        delivered.push(input);
      },
    },
  });
  harnesses.push(harness);
  return { harness, dispatched, delivered };
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
