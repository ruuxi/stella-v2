import { beforeEach, describe, expect, it, vi } from "vitest";

const runCompactionWithHooksMock = vi.hoisted(() => vi.fn());

vi.mock("@stella/runtime/kernel/agent-runtime/run-completion.js", () => ({
  runCompactionWithHooks: (...args: unknown[]) =>
    runCompactionWithHooksMock(...args),
}));

import { BackgroundCompactionScheduler } from "@stella/runtime/kernel/agent-runtime/compaction-scheduler";
import { isThreadCompactionForced } from "@stella/runtime/kernel/agent-runtime/context-budget.js";
import { OrchestratorSession } from "@stella/runtime/kernel/agent-runtime/orchestrator-session";
import type { ResolvedLlmRoute } from "@stella/runtime/kernel/model-routing";
import type { RuntimeStore } from "@stella/runtime/kernel/storage/runtime-store";

const CONVERSATION_ID = "conversation-switch";

const createRoute = (id: string, contextWindow: number): ResolvedLlmRoute =>
  ({
    route: "stella",
    model: { id, contextWindow },
    getApiKey: async () => "auth-token",
  }) as unknown as ResolvedLlmRoute;

const bigThreadMessages = Array.from({ length: 60 }, (_, index) => ({
  entryId: `entry-${index + 1}`,
  timestamp: 1_000 + index,
  role: index % 2 === 0 ? "user" : "assistant",
  content: `message ${index + 1} ${"x".repeat(10_000)}`,
}));

const smallThreadMessages = [
  { entryId: "entry-1", timestamp: 1, role: "user", content: "hi" },
  { entryId: "entry-2", timestamp: 2, role: "assistant", content: "hello" },
];

const createOpts = (args: {
  resolvedLlm: ResolvedLlmRoute;
  messages?: Array<Record<string, unknown>>;
}) => ({
  resolvedLlm: args.resolvedLlm,
  agentType: "orchestrator",
  conversationId: CONVERSATION_ID,
  stellaDataDir: "/tmp/stella",
  compactionScheduler: new BackgroundCompactionScheduler(),
  store: {
    loadThreadMessages: () => args.messages ?? bigThreadMessages,
  } as unknown as RuntimeStore,
});

describe("shrinking-model-switch compaction", () => {
  beforeEach(() => {
    runCompactionWithHooksMock.mockReset();
    runCompactionWithHooksMock.mockResolvedValue({ compacted: true });
  });

  it("force-compacts on the outgoing route before a shrinking switch", async () => {
    const session = new OrchestratorSession(CONVERSATION_ID);
    const outgoing = createRoute("big/model", 1_000_000);
    session.setResolvedLlm(outgoing);

    let forcedDuringRun = false;
    runCompactionWithHooksMock.mockImplementation(
      async (call: { threadKey: string }) => {
        forcedDuringRun = isThreadCompactionForced(call.threadKey);
        return { compacted: true };
      },
    );

    const onCompacting = vi.fn();
    await session.maybeCompactForModelSwitch({
      opts: createOpts({ resolvedLlm: createRoute("small/model", 200_000) }),
      runId: "run-1",
      onCompacting,
    });

    expect(onCompacting).toHaveBeenCalledTimes(1);
    expect(runCompactionWithHooksMock).toHaveBeenCalledTimes(1);
    const call = runCompactionWithHooksMock.mock.calls[0]![0] as {
      opts: { resolvedLlm: ResolvedLlmRoute };
    };

    expect(call.opts.resolvedLlm).toBe(outgoing);

    expect(forcedDuringRun).toBe(true);
  });

  it("does not block when the thread still fits the incoming route", async () => {
    const session = new OrchestratorSession(CONVERSATION_ID);
    session.setResolvedLlm(createRoute("big/model", 1_000_000));

    const onCompacting = vi.fn();
    await session.maybeCompactForModelSwitch({
      opts: createOpts({
        resolvedLlm: createRoute("small/model", 200_000),
        messages: smallThreadMessages,
      }),
      runId: "run-1",
      onCompacting,
    });

    expect(onCompacting).not.toHaveBeenCalled();
    expect(runCompactionWithHooksMock).not.toHaveBeenCalled();
  });

  it("does not block when the window grows or on the first turn of a session", async () => {
    const growing = new OrchestratorSession(CONVERSATION_ID);
    growing.setResolvedLlm(createRoute("small/model", 200_000));
    await growing.maybeCompactForModelSwitch({
      opts: createOpts({ resolvedLlm: createRoute("big/model", 1_000_000) }),
      runId: "run-1",
    });
    expect(runCompactionWithHooksMock).not.toHaveBeenCalled();

    const fresh = new OrchestratorSession(CONVERSATION_ID);
    await fresh.maybeCompactForModelSwitch({
      opts: createOpts({ resolvedLlm: createRoute("small/model", 200_000) }),
      runId: "run-1",
    });
    expect(runCompactionWithHooksMock).not.toHaveBeenCalled();
  });

  it("drains an in-flight background compaction before deciding", async () => {
    const session = new OrchestratorSession(CONVERSATION_ID);
    session.setResolvedLlm(createRoute("big/model", 1_000_000));

    const scheduler = new BackgroundCompactionScheduler();
    let releaseInFlight: () => void = () => undefined;
    let inFlightSettled = false;
    void scheduler.schedule({
      threadKey: CONVERSATION_ID,
      run: () =>
        new Promise<void>((resolve) => {
          releaseInFlight = () => {
            inFlightSettled = true;
            resolve();
          };
        }),
    });

    let currentMessages = bigThreadMessages;
    const opts = {
      ...createOpts({ resolvedLlm: createRoute("small/model", 200_000) }),
      compactionScheduler: scheduler,
      store: {
        loadThreadMessages: () => currentMessages,
      } as unknown as RuntimeStore,
    };

    const waiting = session.maybeCompactForModelSwitch({
      opts,
      runId: "run-1",
    });
    currentMessages = smallThreadMessages as never;
    releaseInFlight();
    await waiting;

    expect(inFlightSettled).toBe(true);
    expect(runCompactionWithHooksMock).not.toHaveBeenCalled();
  });
});
