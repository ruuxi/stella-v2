import { readFileSync } from "node:fs";
import path from "node:path";
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

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");

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
    const attachResumedLocalChatSession = vi.fn();
    registerAgentHandlers({
      getStellaHostRunner: () => ({
        listActiveRuns: async () => ({
          runs: [
            { runId: "run-1", conversationId: "conv-1", kind: "active" },
          ],
        }),
        resumeRunEvents,
        attachResumedLocalChatSession,
      }),
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      stellaAppDir: "/tmp",
      localChatHistoryService: { hasEventId: () => false },
      assertPrivilegedSender: () => true,
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
    registerAgentHandlers({
      getStellaHostRunner: () => ({
        listActiveRuns: async () => ({
          runs: [
            { runId: "run-1", conversationId: "conv-1", kind: "active" },
          ],
        }),
        resumeRunEvents,
        attachResumedLocalChatSession: vi.fn(),
      }),
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      stellaAppDir: "/tmp",
      localChatHistoryService: { hasEventId: () => false },
      assertPrivilegedSender: () => true,
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

  it("rejects untrusted resume", async () => {
    registerAgentHandlers({
      getStellaHostRunner: () => null,
      getAppSessionStartedAt: () => 0,
      isHostAuthAuthenticated: () => true,
      stellaAppDir: "/tmp",
      localChatHistoryService: { hasEventId: () => false },
      assertPrivilegedSender: () => false,
    });

    await expect(
      ipc.handles.get("agent:resume")?.(
        { sender: { id: 1 } },
        { conversationId: "conv-1" },
      ),
    ).rejects.toThrow("Blocked untrusted agent:resume");
  });
});

describe("agent-handlers stream routing", () => {
  it("owns one callback table and drops the unused run map", () => {
    const source = readFileSync(
      path.join(
        repoRoot,
        "packages/desktop/electron/ipc/agent-handlers.js",
      ),
      "utf8",
    );
    expect(source).toContain("createLocalChatStreamCallbacks");
    expect(source).toContain("isTaskLifecycleTerminalType");
    expect(source).not.toContain("runToConversationId");
  });
});
