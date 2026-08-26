import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { LocalAgentManager } from "@stella/runtime/kernel/agents/local-agent-manager";
import { createBackgroundExitWake } from "@stella/runtime/kernel/runner/background-exit-wake";
import {
  createShellState,
  readShellExitSnapshot,
  setShellOwner,
  startShell,
  watchShellExit,
  type ShellExitSnapshot,
  type ShellState,
} from "@stella/runtime/kernel/tools/shell";
import type { ToolResult } from "@stella/runtime/kernel/tools/types";
import { waitForAgentSettled } from "../../../helpers/agent.js";

type OwnerIdentity = {
  conversationId: string;
  agentId: string;
};

type DeliveredWake = OwnerIdentity & {
  eventId: string;
  isCurrent?: () => boolean;
  text: string;
};

const OWNER_A: OwnerIdentity = {
  conversationId: "conversation-a",
  agentId: "shared-agent",
};
const OWNER_B: OwnerIdentity = {
  conversationId: "conversation-b",
  agentId: "shared-agent",
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for background shell exit");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const snapshot = (
  sessionId: string,
  owner: OwnerIdentity,
  output = sessionId,
): ShellExitSnapshot => ({
  sessionId,
  command: `command-${sessionId}`,
  cwd: "/tmp",
  exitCode: 0,
  startedAt: 1_000,
  completedAt: 2_000,
  output,
  owner,
});

const createFakeWakeHarness = (options?: {
  getThreadStatus?: (
    agentId: string,
    conversationId: string,
  ) => Promise<string | undefined> | string | undefined;
}) => {
  const listeners = new Map<string, () => void>();
  const disposers = new Map<string, ReturnType<typeof vi.fn>>();
  const snapshots = new Map<string, ShellExitSnapshot>();
  const delivered: DeliveredWake[] = [];
  const watchShellExit = vi.fn((sessionId: string, listener: () => void) => {
    listeners.set(sessionId, listener);
    const dispose = vi.fn();
    disposers.set(sessionId, dispose);
    return dispose;
  });
  const deliver = vi.fn(async (payload: DeliveredWake) => {
    delivered.push(payload);
    return true;
  });
  const wake = createBackgroundExitWake({
    watchShellExit,
    readShellExitSnapshot: (sessionId: string) =>
      snapshots.get(sessionId) ?? null,
    deliver,
    ...(options?.getThreadStatus
      ? { getThreadStatus: options.getThreadStatus }
      : {}),
  });

  return {
    wake,
    listeners,
    disposers,
    snapshots,
    delivered,
    watchShellExit,
    deliver,
  };
};

describe("background exit wake", () => {
  const tempDirs: string[] = [];
  const liveShellStates: ShellState[] = [];
  const wakes: Array<{ dispose: () => void }> = [];

  afterEach(() => {
    for (const wake of wakes.splice(0)) wake.dispose();
    for (const state of liveShellStates.splice(0)) {
      for (const shell of state.shells.values()) shell.kill();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wakes the exact owner once when a real owned shell exits", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "stella-background-exit-wake-"),
    );
    tempDirs.push(dataDir);
    const shellState = createShellState(dataDir);
    liveShellStates.push(shellState);
    const delivered: DeliveredWake[] = [];
    const wake = createBackgroundExitWake({
      watchShellExit: (sessionId: string, listener: () => void) =>
        watchShellExit(shellState, sessionId, listener),
      readShellExitSnapshot: (sessionId: string) =>
        readShellExitSnapshot(shellState, sessionId),
      deliver: async (payload: DeliveredWake) => {
        delivered.push(payload);
        return true;
      },
    });
    wakes.push(wake);

    const shell = startShell(
      shellState,
      "sleep 0.15; printf STELLA_WAKE_DONE",
      dataDir,
    );
    setShellOwner(shell, {
      ...OWNER_A,
      deviceId: "device-a",
      requestId: "request-a",
      agentType: "general",
    });

    expect(
      wake.arm({
        ...OWNER_A,
        runningSessionIds: [shell.id],
        interrupted: false,
      }),
    ).toEqual([shell.id]);

    await waitFor(() => !shell.running);
    await wake.flushNow(OWNER_A);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject(OWNER_A);
    expect(delivered[0]?.text).toContain("STELLA_WAKE_DONE");
    expect(delivered[0]?.text).toContain("succeeded");

    await wake.flushNow(OWNER_A);
    expect(delivered).toHaveLength(1);
  });

  it("isolates equal agent ids by conversation and drops mismatched snapshot owners", async () => {
    const harness = createFakeWakeHarness();
    wakes.push(harness.wake);
    harness.snapshots.set(
      "session-a",
      snapshot("session-a", OWNER_A, "output-a"),
    );
    harness.snapshots.set(
      "session-a-mismatch",
      snapshot("session-a-mismatch", OWNER_B, "must-not-deliver"),
    );
    harness.snapshots.set(
      "session-b",
      snapshot("session-b", OWNER_B, "output-b"),
    );

    harness.wake.arm({
      ...OWNER_A,
      runningSessionIds: ["session-a", "session-a-mismatch"],
    });
    harness.wake.arm({
      ...OWNER_B,
      runningSessionIds: ["session-b"],
    });

    expect(harness.wake.armedOwners()).toEqual([OWNER_A, OWNER_B]);

    harness.listeners.get("session-a-mismatch")?.();
    harness.listeners.get("session-a")?.();
    await harness.wake.flushNow(OWNER_A);

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]).toMatchObject(OWNER_A);
    expect(harness.delivered[0]?.text).toContain("output-a");
    expect(harness.delivered[0]?.text).not.toContain("must-not-deliver");
    expect(harness.wake.armedOwners()).toEqual([OWNER_B]);

    harness.listeners.get("session-b")?.();
    await harness.wake.flushNow(OWNER_B);

    expect(harness.delivered).toHaveLength(2);
    expect(harness.delivered[1]).toMatchObject(OWNER_B);
    expect(harness.delivered[1]?.text).toContain("output-b");
  });

  it("does not deliver a stale flush disarmed while status lookup is pending", async () => {
    let resolveStatus: ((status: string | undefined) => void) | undefined;
    let markStatusStarted: (() => void) | undefined;
    const statusStarted = new Promise<void>((resolve) => {
      markStatusStarted = resolve;
    });
    const statusGate = new Promise<string | undefined>((resolve) => {
      resolveStatus = resolve;
    });
    const getThreadStatus = vi.fn(async () => {
      markStatusStarted?.();
      return await statusGate;
    });
    const harness = createFakeWakeHarness({ getThreadStatus });
    wakes.push(harness.wake);
    harness.snapshots.set(
      "stale-session",
      snapshot("stale-session", OWNER_A, "stale-output"),
    );
    harness.wake.arm({
      ...OWNER_A,
      runningSessionIds: ["stale-session"],
    });
    harness.listeners.get("stale-session")?.();

    const flushing = harness.wake.flushNow(OWNER_A);
    await statusStarted;
    harness.wake.disarm(OWNER_A);
    resolveStatus?.("completed");
    await flushing;

    expect(getThreadStatus).toHaveBeenCalledWith(
      OWNER_A.agentId,
      OWNER_A.conversationId,
    );
    expect(harness.deliver).not.toHaveBeenCalled();
    expect(harness.wake.armedOwners()).toEqual([]);
  });

  it("closes the disarm race while production delivery awaits thread lookup", async () => {
    let markLookupStarted!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let enqueueCount = 0;
    const listeners = new Map<string, () => void>();
    const wake = createBackgroundExitWake({
      watchShellExit: (sessionId: string, listener: () => void) => {
        listeners.set(sessionId, listener);
        return () => listeners.delete(sessionId);
      },
      readShellExitSnapshot: (sessionId: string) =>
        snapshot(sessionId, OWNER_A, "stale-pre-send-output"),
      deliver: async (payload: DeliveredWake) => {
        markLookupStarted();
        await lookupGate;
        // Mirrors context.ts immediately after its awaited getAgent lookup.
        if (!payload.isCurrent?.()) return false;
        enqueueCount += 1;
        return true;
      },
    });
    wakes.push(wake);
    wake.arm({ ...OWNER_A, runningSessionIds: ["stale-pre-send"] });
    listeners.get("stale-pre-send")?.();

    const flushing = wake.flushNow(OWNER_A);
    await lookupStarted;
    wake.disarm(OWNER_A);
    releaseLookup();
    await flushing;

    expect(enqueueCount).toBe(0);
    expect(wake.armedOwners()).toEqual([]);
  });

  it("reschedules a sibling exit whose timer fires during an active flush", async () => {
    vi.useFakeTimers();
    try {
      const harness = createFakeWakeHarness();
      wakes.push(harness.wake);
      harness.snapshots.set("session-a", snapshot("session-a", OWNER_A));
      harness.snapshots.set("session-b", snapshot("session-b", OWNER_A));
      let releaseFirstDelivery!: () => void;
      const firstDeliveryGate = new Promise<void>((resolve) => {
        releaseFirstDelivery = resolve;
      });
      harness.deliver.mockImplementationOnce(async (payload) => {
        harness.delivered.push(payload);
        await firstDeliveryGate;
        return true;
      });
      harness.wake.arm({
        ...OWNER_A,
        runningSessionIds: ["session-a", "session-b"],
      });
      harness.listeners.get("session-a")?.();

      const firstFlush = harness.wake.flushNow(OWNER_A);
      await vi.waitFor(() => expect(harness.deliver).toHaveBeenCalledOnce());
      harness.listeners.get("session-b")?.();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(harness.deliver).toHaveBeenCalledOnce();

      releaseFirstDelivery();
      await firstFlush;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(harness.deliver).toHaveBeenCalledTimes(2);
      expect(harness.delivered[0]?.text).toContain("command-session-a");
      expect(harness.delivered[0]?.text).not.toContain("command-session-b");
      expect(harness.delivered[1]?.text).toContain("command-session-b");
      expect(harness.wake.armedOwners()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an exited batch when delivery returns false and retries it", async () => {
    const harness = createFakeWakeHarness();
    wakes.push(harness.wake);
    harness.deliver.mockResolvedValueOnce(false);
    harness.snapshots.set(
      "retry-false-session",
      snapshot("retry-false-session", OWNER_A, "retry-false-output"),
    );
    harness.wake.arm({
      ...OWNER_A,
      runningSessionIds: ["retry-false-session"],
    });
    harness.listeners.get("retry-false-session")?.();

    await harness.wake.flushNow(OWNER_A);
    expect(harness.deliver).toHaveBeenCalledTimes(1);
    expect(harness.wake.armedOwners()).toEqual([OWNER_A]);

    await harness.wake.flushNow(OWNER_A);
    expect(harness.deliver).toHaveBeenCalledTimes(2);
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]?.text).toContain("retry-false-output");
    expect(harness.wake.armedOwners()).toEqual([]);
  });

  it("retains an exited batch when delivery throws and retries it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createFakeWakeHarness();
    wakes.push(harness.wake);
    harness.deliver.mockRejectedValueOnce(new Error("temporary outage"));
    harness.snapshots.set(
      "retry-throw-session",
      snapshot("retry-throw-session", OWNER_A, "retry-throw-output"),
    );
    harness.wake.arm({
      ...OWNER_A,
      runningSessionIds: ["retry-throw-session"],
    });
    harness.listeners.get("retry-throw-session")?.();

    await harness.wake.flushNow(OWNER_A);
    expect(harness.deliver).toHaveBeenCalledTimes(1);
    expect(harness.wake.armedOwners()).toEqual([OWNER_A]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to deliver exit wake"),
      "temporary outage",
    );

    await harness.wake.flushNow(OWNER_A);
    expect(harness.deliver).toHaveBeenCalledTimes(2);
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]?.text).toContain("retry-throw-output");
    expect(harness.wake.armedOwners()).toEqual([]);
  });

  it("deduplicates a retry when delivery committed but its acknowledgement was lost", async () => {
    const persisted = new Map<string, any>();
    let runCount = 0;
    const manager = new LocalAgentManager({
      maxConcurrent: 1,
      fetchAgentContext: async () => ({
        systemPrompt: "",
        dynamicContext: "",
        maxAgentDepth: 3,
      }),
      runSubagent: async (args) => {
        runCount += 1;
        return { runId: args.runId, result: `done-${runCount}` };
      },
      toolExecutor: async (): Promise<ToolResult> => ({ result: "unused" }),
      createCloudAgentRecord: async () => ({ agentId: "cloud-unused" }),
      completeCloudAgentRecord: async () => undefined,
      getCloudAgentRecord: async () => null,
      cancelCloudAgentRecord: async () => ({ canceled: false }),
      saveAgentRecord: (record) => persisted.set(record.threadId, record),
      getAgentRecord: (threadId) => persisted.get(threadId) ?? null,
    });
    const created = await manager.createAgent({
      conversationId: "conversation-ack-loss",
      description: "wait for a background command",
      prompt: "start",
      agentType: AGENT_IDS.GENERAL,
      storageMode: "local",
    });
    await waitForAgentSettled(manager, created.threadId);
    const owner = {
      conversationId: "conversation-ack-loss",
      agentId: created.threadId,
    };
    const listeners = new Map<string, () => void>();
    const eventIds: string[] = [];
    let loseAcknowledgement = true;
    const wake = createBackgroundExitWake({
      watchShellExit: (sessionId: string, listener: () => void) => {
        listeners.set(sessionId, listener);
        return () => listeners.delete(sessionId);
      },
      readShellExitSnapshot: (sessionId: string) =>
        snapshot(sessionId, owner, "ack-loss-output"),
      getThreadStatus: async (agentId: string) =>
        (await manager.getAgent(agentId))?.status,
      deliver: async (payload: DeliveredWake) => {
        eventIds.push(payload.eventId);
        const result = await manager.sendAgentMessage(
          payload.agentId,
          payload.text,
          "orchestrator",
          {
            deliveryKind: "external-input",
            deliveryEventId: payload.eventId,
          },
        );
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw "acknowledgement lost";
        }
        return result.delivered;
      },
    });
    wakes.push(wake);
    wake.arm({ ...owner, runningSessionIds: ["ack-loss-session"] });
    listeners.get("ack-loss-session")?.();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await wake.flushNow(owner);
    await waitForAgentSettled(manager, created.threadId);
    await wake.flushNow(owner);

    expect(eventIds).toHaveLength(2);
    expect(eventIds[0]).toBe(eventIds[1]);
    expect(eventIds[0]).toMatch(/^background-exit:[a-f0-9]{64}$/u);
    expect(runCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to deliver exit wake"),
      "acknowledgement lost",
    );
    expect(wake.armedOwners()).toEqual([]);
    await manager.shutdown();
  });

  it("suppresses interrupted and disposed arms and calls every disposer", async () => {
    const harness = createFakeWakeHarness();
    wakes.push(harness.wake);
    harness.snapshots.set(
      "interrupted-session",
      snapshot("interrupted-session", OWNER_A),
    );
    harness.snapshots.set(
      "disposed-session",
      snapshot("disposed-session", OWNER_A),
    );

    harness.wake.arm({
      ...OWNER_A,
      runningSessionIds: ["interrupted-session"],
    });
    const interruptedListener = harness.listeners.get("interrupted-session");
    expect(
      harness.wake.arm({
        ...OWNER_A,
        runningSessionIds: ["must-not-watch"],
        interrupted: true,
      }),
    ).toEqual([]);
    expect(harness.disposers.get("interrupted-session")).toHaveBeenCalledOnce();
    expect(harness.watchShellExit).toHaveBeenCalledTimes(1);

    interruptedListener?.();
    await harness.wake.flushNow(OWNER_A);
    expect(harness.deliver).not.toHaveBeenCalled();

    harness.wake.arm({
      ...OWNER_A,
      runningSessionIds: ["disposed-session"],
    });
    const disposedListener = harness.listeners.get("disposed-session");
    harness.wake.dispose();

    expect(harness.disposers.get("disposed-session")).toHaveBeenCalledOnce();
    expect(harness.wake.armedOwners()).toEqual([]);
    expect(
      harness.wake.arm({
        ...OWNER_A,
        runningSessionIds: ["after-dispose"],
      }),
    ).toEqual([]);

    disposedListener?.();
    await harness.wake.flushNow(OWNER_A);
    expect(harness.deliver).not.toHaveBeenCalled();
  });
});
