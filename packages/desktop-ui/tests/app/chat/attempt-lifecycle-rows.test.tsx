// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventRecord, MessageRecord } from "@stella/contracts/local-chat";
import { useEventRows } from "@/features/chat/hooks/use-event-rows";

const lifecycle = (
  id: string,
  type: string,
  attemptGeneration: number,
): EventRecord => ({
  _id: id,
  timestamp: 10_000,
  type,
  payload: {
    agentId: "resumed-thread",
    rootRunId: "same-root",
    agentType: "general",
    attemptGeneration,
    ...(type === "agent-started"
      ? {
          description: `Attempt ${attemptGeneration}`,
          statusText: `Attempt ${attemptGeneration}`,
          ...(attemptGeneration > 1 ? { isFollowUp: true } : {}),
        }
      : { result: `Attempt ${attemptGeneration} result` }),
  },
});

const message = (id: string, toolEvents: EventRecord[]): MessageRecord => ({
  _id: id,
  timestamp: 10_000,
  type: "assistant_message",
  payload: { text: "" },
  toolEvents,
});

function Harness({ messages }: { messages: MessageRecord[] }) {
  const { rows } = useEventRows({ messages });
  const cards = rows.flatMap((row) =>
    row.kind === "assistant" && row.backgroundWork
      ? [
          {
            start: row.backgroundWork.startEventIdsByThread["resumed-thread"],
            attempt:
              row.backgroundWork.attemptGenerationsByThread?.["resumed-thread"],
            completed:
              row.backgroundWork.completedThreadIds.includes("resumed-thread"),
            superseded:
              row.backgroundWork.supersededThreadIds?.includes(
                "resumed-thread",
              ) ?? false,
            terminal:
              row.backgroundWork.terminalEventIdsByThread?.["resumed-thread"],
          },
        ]
      : [],
  );
  return <pre data-testid="cards">{JSON.stringify(cards)}</pre>;
}

describe("attempt-generation row ownership", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps the higher generation current when its row and id sort earlier", async () => {
    const currentStart = lifecycle("aa-current-start", "agent-started", 2);
    const currentTerminal = lifecycle(
      "00-current-terminal",
      "agent-completed",
      2,
    );
    const oldStart = lifecycle("zz-old-start", "agent-started", 1);

    await act(async () => {
      // Current is physically first and the old row is last, reproducing a
      // same-ms reload whose random ids previously made the old card owner.
      root.render(
        <Harness
          messages={[
            message("aa-current-row", [currentTerminal, currentStart]),
            message("zz-old-row", [oldStart]),
          ]}
        />,
      );
    });

    const cards = JSON.parse(
      container.querySelector('[data-testid="cards"]')?.textContent ?? "[]",
    ) as Array<Record<string, unknown>>;
    expect(cards).toEqual([
      {
        start: "aa-current-start",
        attempt: 2,
        completed: true,
        superseded: false,
        terminal: "00-current-terminal",
      },
      {
        start: "zz-old-start",
        attempt: 1,
        completed: false,
        superseded: true,
      },
    ]);
  });
});
