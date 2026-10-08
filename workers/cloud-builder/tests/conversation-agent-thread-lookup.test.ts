import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OwnerEvent } from "@stella/contracts/turn-plane/owner-events";
import {
  agentThreadElsewhereError,
  agentThreadElsewhereStatus,
  cancelDeviceAgent,
  continueDeviceAgent,
  readDeviceAgent,
  resolveConversationAgentThread,
  type DeviceAgentCaller,
} from "../src/device-agent-tools.js";
import {
  createOwnerStoreHarness,
  OWNER_ID,
  type OwnerStoreHarness,
} from "./helpers/owner-store-harness.js";

const GEN = "generation-1";
const CONV = "6f0e2a7c-1b3d-4c5e-8f9a-0b1c2d3e4f5a";
const OTHER_CONV = "7a1f3b8d-2c4e-4d6f-9a0b-1c2d3e4f5a6b";

let h: OwnerStoreHarness;
let steered: Array<{ dispatchId: string; text: string }>;
let canceled: string[];

beforeEach(async () => {
  steered = [];
  canceled = [];
  let dispatches = 0;
  h = createOwnerStoreHarness({
    host: {
      deviceDestinations: async () => [
        { deviceId: "mac-1", label: "Rahul's Mac", remoteExecutionEnabled: true, online: true },
        { deviceId: "desk-1", label: "omarchy", remoteExecutionEnabled: true, online: true },
      ],
      dispatchDeviceAgentTurn: async () => ({ dispatchId: `dsp-${++dispatches}` }),
      steerDeviceAgentTurn: async (input) => {
        steered.push({ dispatchId: input.dispatchId, text: input.text });
        return { delivered: true };
      },
      cancelDeviceAgentTurn: async (input) => {
        canceled.push(input.dispatchId);
      },
    },
  });
  const created: OwnerEvent = {
    v: 1,
    kind: "conversation.created",
    key: CONV,
    ownerId: OWNER_ID,
    ownerGeneration: GEN,
    emittedAt: 1,
    conversationId: CONV,
    createdAt: 1_000,
    title: "Disk cleanup",
  };
  await h.ownerEvents([created]);
});
afterEach(() => h.close());

const cloudOrchestrator = (conversationId = CONV, parentTurnId = "turn-after-restart"): DeviceAgentCaller => ({
  ownerGeneration: GEN,
  conversationId,
  parentTurnId,
  ownerInternal: async (name, args) => {
    const response = await h.store.internalCall(name, args);
    if (!response.ok) throw new Error(response.error.message);
    return response.value;
  },
});

const spawnFromCloud = async (parentThreadId?: string) => {
  const response = await h.store.internalCall("agentThreads.spawnOnDevice", {
    ownerGeneration: GEN,
    conversationId: CONV,
    parentTurnId: "turn-before-restart",
    ...(parentThreadId ? { parentThreadId } : {}),
    clientMsgId: parentThreadId ? "client-msg-helper" : "client-msg-0001",
    targetDeviceId: "mac-1",
    description: "Disk cleanup",
    prompt: "Free disk space on the Mac and report what was removed.",
  });
  if (!response.ok) throw new Error(response.error.message);
  await h.runJobs(Date.now() + 1_000);
  return response.value as { threadId: string };
};

const spawnFromDesktop = async () =>
  (await h.call("agentThreads.spawnFromDesktop", {
    ownerGeneration: GEN,
    clientMsgId: "desktop-spawn-0001",
    description: "Adobe clones survey",
    prompt: "Survey the Adobe clone apps on the Mac.",
    originDeviceId: "desk-1",
    originConversationId: CONV,
    conversationId: CONV,
    targetDeviceId: "mac-1",
  })) as { threadId: string };

describe("a conversation finds agents it started somewhere else", () => {
  test("the cloud orchestrator takes over its own device agent when its receipt is missing, and can steer and pause it", async () => {
    const { threadId } = await spawnFromCloud();
    const caller = cloudOrchestrator();

    const found = await resolveConversationAgentThread(caller, threadId);
    expect(found).toMatchObject({
      kind: "adopted",
      control: { threadId, status: "running", executorDeviceId: "mac-1", description: "Disk cleanup" },
    });
    if (found?.kind !== "adopted") throw new Error("expected adoption");

    expect(await readDeviceAgent(caller, found.control)).toMatchObject({ threadId, status: "running" });

    const input = await continueDeviceAgent(caller, found.control, {
      controlRequestId: "send-input-0001",
      message: "Also empty the Downloads folder.",
    });
    expect(input).toMatchObject({ threadId, attemptGeneration: found.control.attemptGeneration });
    expect(steered).toEqual([{ dispatchId: "dsp-1", text: "Also empty the Downloads folder." }]);

    const paused = await cancelDeviceAgent(caller, found.control, "pause-agent-0001");
    expect(paused).toMatchObject({ threadId, status: "canceled" });
    expect(canceled).toEqual(["dsp-1"]);
  });

  test("a thread started from another computer is found and described, and input or pause say who can reach it", async () => {
    const { threadId } = await spawnFromDesktop();
    const found = await resolveConversationAgentThread(cloudOrchestrator(), threadId);
    expect(found?.kind).toBe("elsewhere");
    if (found?.kind !== "elsewhere") throw new Error("expected a thread started elsewhere");

    expect(found.text).toContain(`Thread ${threadId} (Adobe clones survey) runs on Rahul's Mac and is running`);
    expect(found.text).toContain("started from omarchy");
    expect(found.text).toContain("only omarchy can send it input or pause it");

    const status = agentThreadElsewhereStatus(found);
    expect(status.details).toMatchObject({
      thread_id: threadId,
      status: "active",
      status_detail: "running",
      device_id: "mac-1",
      started_from_device_id: "desk-1",
      controllable_here: false,
    });
    expect(status.content[0]?.text).toContain("send_message still reaches it, as a note from you.");
    expect(agentThreadElsewhereError(found).message).toContain("so nothing was paused.");
  });

  test("a helper another agent started stays with that agent", async () => {
    const { threadId } = await spawnFromCloud("thr-parent-agent");
    const found = await resolveConversationAgentThread(cloudOrchestrator(), threadId);
    expect(found?.kind).toBe("elsewhere");
    if (found?.kind !== "elsewhere") throw new Error("expected a helper thread");
    expect(found.text).toContain("started by another agent of this conversation (thread thr-parent-agent)");
  });

  test("a desktop looks a thread up by its own conversation id and sees where it was started", async () => {
    const { threadId } = await spawnFromCloud();
    const desktopStarted = await spawnFromDesktop();

    expect(await h.call("agentThreads.lookup", { conversationId: CONV, threadId })).toMatchObject({
      threadId,
      executorDeviceId: "mac-1",
      executorDeviceLabel: "Rahul's Mac",
      status: "running",
    });
    const fromDesktop = await h.call("agentThreads.lookup", {
      conversationId: CONV,
      threadId: desktopStarted.threadId,
    });
    expect(fromDesktop).toMatchObject({ originDeviceId: "desk-1", originDeviceLabel: "omarchy" });
  });

  test("another conversation's thread stays not found", async () => {
    const { threadId } = await spawnFromCloud();
    expect(await resolveConversationAgentThread(cloudOrchestrator(OTHER_CONV), threadId)).toBeNull();
    expect(await h.call("agentThreads.lookup", { conversationId: OTHER_CONV, threadId })).toBeNull();
    expect(await resolveConversationAgentThread(cloudOrchestrator(), "thr-missing")).toBeNull();
  });
});
