import { describe, expect, test } from "bun:test";

import type { ChatArtifact, ChatMessage, MobileTask } from "../../types";
import { applyLiveAgentWorkState } from "../agent-work-live-state";

const task = (overrides: Partial<MobileTask> & { id: string }): MobileTask => ({
  title: "Background work",
  status: "running",
  createdAt: 1_000,
  ...overrides,
});

const agentWorkArtifact = (
  overrides: Partial<
    Extract<ChatArtifact["payload"], { kind: "agent-work" }>
  > & { agentIds: string[] },
): ChatArtifact => ({
  id: `agent-work:${overrides.agentIds[0]}`,
  conversationId: "c1",
  payload: {
    kind: "agent-work",
    state: "done",
    total: overrides.agentIds.length,
    completed: overrides.agentIds.length,
    title: "Task",
    subtitle: "Finished",
    createdAt: 1_000,
    ...overrides,
  },
});

const message = (
  id: string,
  artifacts: ChatArtifact[] | undefined,
): ChatMessage => ({
  id,
  role: "assistant",
  text: "",
  ...(artifacts ? { artifacts } : {}),
});

const payloadOf = (chatMessage: ChatMessage, index = 0) => {
  const payload = chatMessage.artifacts?.[index]?.payload;
  if (payload?.kind !== "agent-work") throw new Error("expected agent-work");
  return payload;
};

describe("applyLiveAgentWorkState", () => {
  test("send_input follow-up on a running thread renders as in-progress, not Finished", () => {

    const followUpCard = agentWorkArtifact({
      agentIds: ["agent-a"],
      state: "done",
      completed: 1,
      subtitle: "Finished",
      title: "Produce visual evidence of the redesign",
    });
    const result = applyLiveAgentWorkState(
      [message("m1", [followUpCard])],
      [task({ id: "agent-a", status: "running" })],
    );
    const payload = payloadOf(result[0]!);
    expect(payload.state).toBe("running");
    expect(payload.completed).toBe(0);
    expect(payload.subtitle).toBe("Working in background");
  });

  test("a genuinely completed agent keeps its finished card", () => {
    const card = agentWorkArtifact({ agentIds: ["agent-a"], state: "done" });
    const messages = [message("m1", [card])];
    const result = applyLiveAgentWorkState(messages, [
      task({ id: "agent-a", status: "completed", completedAt: 9_000 }),
    ]);
    expect(result).toBe(messages);
    expect(payloadOf(result[0]!).state).toBe("done");
  });

  test("a live terminal status never flips a running card to done (bridge/sync own that)", () => {

    const card = agentWorkArtifact({
      agentIds: ["agent-a"],
      state: "running",
      completed: 0,
      subtitle: "Working in background",
    });
    const messages = [message("m1", [card])];
    const result = applyLiveAgentWorkState(messages, [
      task({ id: "agent-a", status: "completed" }),
    ]);
    expect(result).toBe(messages);
  });

  test("only the latest card covering a thread follows live state; earlier turns stay settled", () => {

    const spawnCard = agentWorkArtifact({ agentIds: ["agent-a"] });
    const followUpCard = agentWorkArtifact({
      agentIds: ["agent-a"],
      title: "Follow-up",
    });
    const result = applyLiveAgentWorkState(
      [message("m1", [spawnCard]), message("m2", [followUpCard])],
      [task({ id: "agent-a", status: "running" })],
    );
    expect(payloadOf(result[0]!).state).toBe("done");
    expect(payloadOf(result[1]!).state).toBe("running");
  });

  test("multi-agent aggregate recounts completed from live statuses", () => {
    const card = agentWorkArtifact({
      agentIds: ["agent-a", "agent-b"],
      state: "done",
      completed: 2,
      subtitle: "Finished",
    });
    const result = applyLiveAgentWorkState(
      [message("m1", [card])],
      [
        task({ id: "agent-a", status: "completed" }),
        task({ id: "agent-b", status: "running" }),
      ],
    );
    const payload = payloadOf(result[0]!);
    expect(payload.state).toBe("running");
    expect(payload.completed).toBe(1);
    expect(payload.subtitle).toBe("1 of 2 done");
  });

  test("a card whose agent is unknown to the live fold keeps its synced state", () => {
    const card = agentWorkArtifact({ agentIds: ["agent-a"] });
    const messages = [message("m1", [card])];
    expect(
      applyLiveAgentWorkState(messages, [
        task({ id: "other", status: "running" }),
      ]),
    ).toBe(messages);
    expect(applyLiveAgentWorkState(messages, [])).toBe(messages);
  });

  test("non-agent-work artifacts and messages without artifacts pass through by reference", () => {
    const mediaArtifact: ChatArtifact = {
      id: "media-1",
      conversationId: "c1",
      payload: {
        kind: "media",
        asset: { kind: "image", filePaths: [] },
        createdAt: 1_000,
      },
    };
    const messages = [message("m1", [mediaArtifact]), message("m2", undefined)];
    expect(
      applyLiveAgentWorkState(messages, [task({ id: "agent-a" })]),
    ).toBe(messages);
  });
});
