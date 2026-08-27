import { describe, expect, it, vi } from "vitest";

import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { startPreparedOrchestratorRun } from "@stella/runtime/kernel/runner/orchestrator-launch";

const mocked = vi.hoisted(() => ({
  providerStarted: vi.fn(),
}));

vi.mock("@stella/runtime/kernel/runner/model-selection", () => ({
  createRunnerImageDescriptionService: vi.fn(() =>
    vi.fn(async () => "described image"),
  ),
  resolveRunnerLlmRouteWithMetadata: vi.fn(async () => ({
    model: { id: "test-model", provider: "test-provider" },
    route: "direct-provider",
    getApiKey: () => "test-key",
  })),
}));

vi.mock("@stella/runtime/kernel/agent-runtime", () => ({
  runOrchestratorTurn: vi.fn(async () => {
    mocked.providerStarted();
  }),
}));

const createContext = () =>
  ({
    state: {
      activeOrchestratorRunId: null,
      activeOrchestratorConversationId: null,
      activeOrchestratorUiVisibility: "visible",
      activeOrchestratorSession: null,
      orchestratorSessions: new Map(),
      loadedAgents: [],
      localAgentManager: { listActiveAgentRuns: () => [] },
      compactionScheduler: {},
      supervisor: {
        registerRun: vi.fn(),
        discardRun: vi.fn(),
        adoptResource: vi.fn(),
        adoptChild: vi.fn(),
        startRun: vi.fn(),
        hasRun: vi.fn(() => false),
        abortRun: vi.fn(),
        abortAllRuns: vi.fn(),
        activeRunCount: vi.fn(() => 0),
        cancelRun: vi.fn(async () => undefined),
      },
    },
    toolHost: {
      getToolCatalog: () => [],
      executeTool: vi.fn(),
      endBrowserTurn: vi.fn(async () => undefined),
    },
    runtimeStore: {},
    deviceId: "device-1",
    stellaDataDir: "/tmp/stella-home",
    stellaAppDir: "/tmp/stella-root",
  }) as any;

const start = (context: any, onPrepared: () => Promise<void>) =>
  startPreparedOrchestratorRun({
    context,
    buildAgentContext: async () => ({
      systemPrompt: "",
      dynamicContext: "",
      maxAgentDepth: 3,
    }),
    runId: "local:auto:remote:attempt-1",
    conversationId: "conversation-1",
    agentType: AGENT_IDS.ORCHESTRATOR,
    userPrompt: "do the work",
    attachments: [],
    userMessageId: "connector:request-1",
    createRuntimeCallbacks: () => ({}),
    cleanupRun: vi.fn(),
    onFatalError: vi.fn(),
    onPrepared,
  });

describe("remote-turn worker admission", () => {
  it("cannot launch provider work before the positive admission ACK", async () => {
    mocked.providerStarted.mockClear();
    const context = createContext();
    let releaseAdmission: (() => void) | undefined;
    const admissionStarted = vi.fn();

    const launched = start(
      context,
      async () =>
        await new Promise<void>((resolve) => {
          admissionStarted();
          releaseAdmission = resolve;
        }),
    );

    await vi.waitFor(() => expect(admissionStarted).toHaveBeenCalledOnce());
    expect(mocked.providerStarted).not.toHaveBeenCalled();
    releaseAdmission?.();
    await launched;
    await vi.waitFor(() => expect(mocked.providerStarted).toHaveBeenCalledOnce());
  });

  it("releases admission and never launches when the host denies the attempt", async () => {
    mocked.providerStarted.mockClear();
    const context = createContext();

    await expect(
      start(context, async () => {
        throw new Error("attempt denied");
      }),
    ).rejects.toThrow("attempt denied");

    expect(mocked.providerStarted).not.toHaveBeenCalled();
    expect(context.state.activeOrchestratorRunId).toBeNull();
    expect(context.state.supervisor.discardRun).toHaveBeenCalledWith(
      "local:auto:remote:attempt-1",
    );
  });
});
