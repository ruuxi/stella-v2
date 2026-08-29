/**
 * Adapted from main's agent-resume-seq test. The source-shape assertions about
 * `createLocalChatStreamCallbacks` / `runToConversationId` are omitted: that
 * callback-table extraction is a separate refactor, and the privileged-sender
 * gate for `agent:resume` belongs to the IPC-gating slice, not this one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RECORDER_SEQ_CEILING } from "@stella/contracts/agent-runtime";

const ipc = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  on: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipc.handles.set(channel, handler);
      },
    ),
    on: ipc.on,
  },
  webContents: { fromId: () => null },
}));

const { registerAgentHandlers } = await import(
  "@stella/desktop/electron/ipc/agent-handlers.js"
);

const registerForConversation = (
  hostRunner: Record<string, unknown>,
  conversationId = "conv-1",
) =>
  (registerAgentHandlers as (options: unknown) => unknown)({
    getStellaHostRunner: () => hostRunner,
    getAppSessionStartedAt: () => 0,
    isHostAuthAuthenticated: () => true,
    stellaAppDir: "/tmp",
    localChatHistoryService: { hasEventId: () => false },
    assertPrivilegedSender: () => true,
    uiState: { conversationId },
  });

afterEach(() => {
  ipc.handles.clear();
  vi.clearAllMocks();
});

describe("agent:resume seq spaces", () => {
  it("remaps worker-fallback recorder seqs onto the live wire", async () => {
    const resumeRunEvents = vi.fn(async () => ({
      exhausted: false,
      events: [
        {
          type: "stream",
          runId: "run-1",
          conversationId: "conv-1",
          seq: 5,
          chunk: "hello",
        },
      ],
    }));
    registerForConversation({
      listActiveRuns: async () => ({
        runs: [{ runId: "run-1", conversationId: "conv-1", kind: "active" }],
      }),
      resumeRunEvents,
      attachResumedLocalChatSession: vi.fn(),
    });

    const resume = ipc.handles.get("agent:resume");
    const result = (await resume?.(
      { sender: { id: 1 } },
      {
        conversationId: "conv-1",
        lastSeq: 1_800_000_000_001,
        lastSourceSeq: 4,
      },
    )) as { events: Array<{ seq: number; sourceSeq?: number }> };

    expect(resumeRunEvents).toHaveBeenCalledWith({
      runId: "run-1",
      lastSeq: 4,
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.sourceSeq).toBe(5);
    expect(result.events[0]?.seq).toBeGreaterThanOrEqual(
      AGENT_RECORDER_SEQ_CEILING,
    );
  });

  it("does not query the worker log with MAX_SAFE_INTEGER", async () => {
    const resumeRunEvents = vi.fn(async () => ({
      exhausted: true,
      events: [],
    }));
    registerForConversation({
      listActiveRuns: async () => ({
        runs: [{ runId: "run-1", conversationId: "conv-1", kind: "active" }],
      }),
      resumeRunEvents,
      attachResumedLocalChatSession: vi.fn(),
    });

    await ipc.handles.get("agent:resume")?.(
      { sender: { id: 1 } },
      {
        conversationId: "conv-1",
        lastSeq: Number.MAX_SAFE_INTEGER,
      },
    );

    expect(resumeRunEvents).toHaveBeenCalledWith({
      runId: "run-1",
      lastSeq: 0,
    });
  });
});
