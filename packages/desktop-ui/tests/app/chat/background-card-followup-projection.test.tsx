// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventRecord, MessageRecord } from "@stella/contracts/local-chat";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import { useEventRows } from "@/features/chat/hooks/use-event-rows";
import {
  getPersistedAssistantSlots,
  mergeConversationDisplayMessageSources,
} from "@/features/chat/hooks/use-conversation-display-messages";

const lifecycle = (
  id: string,
  timestamp: number,
  type: string,
  payload: Record<string, unknown>,
): EventRecord => ({ _id: id, timestamp, type, payload });

const assistant = (
  id: string,
  timestamp: number,
  toolEvents: EventRecord[],
): MessageRecord => ({
  _id: id,
  timestamp,
  type: "assistant_message",
  payload: { text: "", userMessageId: "user-turn" },
  toolEvents,
});

const start = (
  id: string,
  timestamp: number,
  agentType: "general" | "manager",
  generation: number,
  followUp = false,
) =>
  lifecycle(id, timestamp, "agent-started", {
    agentId: `${agentType}-thread`,
    agentType,
    rootRunId: `${agentType}-run`,
    attemptGeneration: generation,
    description: "Original durable work",
    statusText: followUp ? "Apply Rahul's follow-up" : "Original durable work",
    ...(followUp ? { isFollowUp: true } : {}),
  });

const complete = (
  id: string,
  timestamp: number,
  agentType: "general" | "manager",
  generation: number,
) =>
  lifecycle(id, timestamp, "agent-completed", {
    agentId: `${agentType}-thread`,
    agentType,
    rootRunId: `${agentType}-run`,
    attemptGeneration: generation,
    result: "Finished the occurrence",
  });

describe("inline follow-up card projection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let renderedRows: EventRowViewModel[] = [];

  function Probe({ messages }: { messages: MessageRecord[] }) {
    const orderedMessages = mergeConversationDisplayMessageSources({
      persistedMessages: messages,
      overlayMessages: [],
      streamingAssistants: [],
      persistedAssistantSlots: getPersistedAssistantSlots(messages),
    });
    renderedRows = useEventRows({ messages: orderedMessages }).rows;
    return null;
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    renderedRows = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it.each(["general", "manager"] as const)(
    "shows only the new %s follow-up card when it interrupts active work",
    async (agentType) => {
      const original = start("original-start", 100, agentType, 1);
      const followUp = start("follow-up-start", 200, agentType, 2, true);
      await act(async () => {
        root.render(
          <Probe
            messages={[
              assistant("original-row", 100, [original]),
              assistant("follow-up-row", 200, [followUp]),
            ]}
          />,
        );
      });

      const cards = renderedRows.flatMap((row) =>
        row.kind === "assistant" && row.backgroundWork
          ? [row.backgroundWork]
          : [],
      );
      expect(cards).toHaveLength(1);
      expect(cards[0]?.startEventIdsByThread[`${agentType}-thread`]).toBe(
        "follow-up-start",
      );
      expect(cards[0]?.followUpThreadIds).toEqual([`${agentType}-thread`]);
    },
  );

  it.each(["general", "manager"] as const)(
    "keeps the settled %s card and adds a separate follow-up card",
    async (agentType) => {
      const original = start("original-start", 100, agentType, 1);
      const originalDone = complete("original-done", 150, agentType, 1);
      const followUp = start("follow-up-start", 200, agentType, 2, true);
      await act(async () => {
        root.render(
          <Probe
            messages={[
              assistant("original-row", 100, [original]),
              assistant("completion-row", 150, [originalDone]),
              assistant("follow-up-row", 200, [followUp]),
            ]}
          />,
        );
      });

      const cards = renderedRows.flatMap((row) =>
        row.kind === "assistant" && row.backgroundWork
          ? [row.backgroundWork]
          : [],
      );
      expect(cards).toHaveLength(2);
      expect(
        cards.map((card) => card.startEventIdsByThread[`${agentType}-thread`]),
      ).toEqual(["original-start", "follow-up-start"]);
      expect(cards[0]?.completedThreadIds).toEqual([`${agentType}-thread`]);
      expect(cards[0]?.supersededThreadIds).toEqual([`${agentType}-thread`]);
      expect(cards[1]?.completedThreadIds).toEqual([]);
    },
  );

  it.each(["general", "manager"] as const)(
    "keeps a later working %s follow-up below its settled predecessor when anchor timestamps disagree",
    async (agentType) => {
      const original = start("original-start", 100, agentType, 1);
      const originalDone = complete("original-done", 150, agentType, 1);
      const followUp = start("follow-up-start", 200, agentType, 2, true);
      const originalRow = assistant("original-row", 500, [
        original,
        originalDone,
      ]);
      const followUpRow = assistant("follow-up-row", 50, [followUp]);

      await act(async () => {
        root.render(<Probe messages={[followUpRow, originalRow]} />);
      });

      const cardStarts = renderedRows.flatMap((row) =>
        row.kind === "assistant" && row.backgroundWork
          ? [row.backgroundWork.startEventIdsByThread[`${agentType}-thread`]]
          : [],
      );
      expect(cardStarts).toEqual(["original-start", "follow-up-start"]);
    },
  );

  it("does not reorder inline cards when lifecycle status changes", async () => {
    const original = start("original-start", 100, "general", 1);
    const originalDone = complete("original-done", 150, "general", 1);
    const followUp = start("follow-up-start", 200, "general", 2, true);
    const originalRow = assistant("original-row", 500, [
      original,
      originalDone,
    ]);
    const followUpRow = assistant("follow-up-row", 50, [followUp]);
    const cardStarts = () =>
      renderedRows.flatMap((row) =>
        row.kind === "assistant" && row.backgroundWork
          ? [row.backgroundWork.startEventIdsByThread["general-thread"]]
          : [],
      );

    await act(async () => {
      root.render(<Probe messages={[followUpRow, originalRow]} />);
    });
    expect(cardStarts()).toEqual(["original-start", "follow-up-start"]);

    await act(async () => {
      root.render(
        <Probe
          messages={[
            assistant("follow-up-row", 50, [
              followUp,
              complete("follow-up-done", 250, "general", 2),
            ]),
            originalRow,
          ]}
        />,
      );
    });
    expect(cardStarts()).toEqual(["original-start", "follow-up-start"]);
  });

  it("reconstructs the same occurrence order on a fresh reload projection", async () => {
    const makeReloadedMessages = () => [
      assistant("follow-up-row", 50, [
        start("follow-up-start", 200, "manager", 2, true),
      ]),
      assistant("original-row", 500, [
        start("original-start", 100, "manager", 1),
        complete("original-done", 150, "manager", 1),
      ]),
    ];
    const cardStarts = () =>
      renderedRows.flatMap((row) =>
        row.kind === "assistant" && row.backgroundWork
          ? [row.backgroundWork.startEventIdsByThread["manager-thread"]]
          : [],
      );

    await act(async () => {
      root.render(<Probe messages={makeReloadedMessages()} />);
    });
    expect(cardStarts()).toEqual(["original-start", "follow-up-start"]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<Probe messages={makeReloadedMessages()} />);
    });
    expect(cardStarts()).toEqual(["original-start", "follow-up-start"]);
  });
});
