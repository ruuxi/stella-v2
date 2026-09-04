import { expect, test } from "bun:test";
import { StellaRuntimeHost } from "./index.js";

test("cloud hand-off balances the desktop start and ignores later dispatch updates", async () => {
  const events: Array<{ type: string; outcome?: string }> = [];
  let onStatus: (status: object) => void = () => {};
  let unsubscribed = 0;
  const host = {
    ensureHostConvexClient: () => ({}),
    syncHostExecutionPlacement: async () => {},
    uploadPlacedAttachments: async () => [],
    placedDispatchByRunId: new Map(),
    emitPlacedRunEvent: (event: { type: string }) => events.push(event),
    hostExecutionPlacementBridge: {
      isRunning: true,
      submitDesktopExecution: async () => ({ dispatchId: "dispatch-1", state: "cloud_committed" }),
      watchDispatch: (_id: string, callback: typeof onStatus) => {
        onStatus = callback;
        return { unsubscribe: () => { unsubscribed += 1; } };
      },
    },
  };
  const accepted = await StellaRuntimeHost.prototype.startPlacedChat.call(host, {
    conversationId: "conversation-1", userPrompt: "Hello", requestId: "request-1",
    userMessageEventId: "local-optimistic",
  }, { mode: "cloud" });
  expect(accepted).toEqual({ runId: "placed:dispatch-1", userMessageId: "dispatch-1" });
  expect(events.map(event => event.type)).toEqual(["run-started"]);
  onStatus({ dispatchId: "dispatch-1", placement: "cloud", cloudTurnId: "turn-1" });
  expect(events.map(event => event.type)).toEqual(["run-started", "run-finished"]);
  expect(events[1]?.outcome).toBe("completed");
  expect(host.placedDispatchByRunId.size).toBe(0);
  expect(unsubscribed).toBe(1);
  onStatus({ dispatchId: "dispatch-1", state: "completed" });
  expect(events).toHaveLength(2);
});
