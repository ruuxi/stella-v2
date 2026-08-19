// @vitest-environment jsdom
/**
 * Orchestrator-off (direct) mode replaces each interim assistant message in
 * place: the handoff controller marks the previous slot's overlay
 * `textTransition: "hidden"` and reveals the next one. Hidden overlays stay
 * unlocked (they keep masking their persisted preamble twin), so their
 * runtime metadata still said `isStreaming: true` — and every streaming
 * assistant row is kept by `eventRowRendersContent` as a 1px placeholder
 * timeline item plus the assistant-run separator gap. Result: each
 * replacement stacked ~one line of blank space above the live message for
 * the rest of the turn.
 *
 * Pins the fix: a hidden slot's row is NOT marked `isStreaming`, so the
 * timeline drops it entirely, while the actively streaming slot keeps its
 * pre-first-token placeholder (scroll-follow target).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageRecord } from "@stella/contracts/local-chat";
import type { StreamingAssistantOverlay } from "@/features/chat/streaming/streaming-types";
import { overlayToMessageRecord } from "@/features/chat/hooks/use-conversation-display-messages";
import { useEventRows } from "@/features/chat/hooks/use-event-rows";
import { buildChatTimelineItems } from "@/features/chat/lib/chat-timeline-items";
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";

const message = (overrides: Partial<MessageRecord>): MessageRecord => ({
  _id: overrides._id ?? "message",
  timestamp: overrides.timestamp ?? 0,
  type: overrides.type ?? "assistant_message",
  payload: overrides.payload ?? {},
  toolEvents: overrides.toolEvents ?? [],
  ...overrides,
});

const overlay = (
  overrides: Partial<StreamingAssistantOverlay>,
): StreamingAssistantOverlay => ({
  _id: overrides._id ?? "stream-overlay:u1:1",
  userMessageId: overrides.userMessageId ?? "u1",
  indexInTurn: overrides.indexInTurn ?? 1,
  text: overrides.text ?? "",
  timestamp: overrides.timestamp ?? 2,
  runId: overrides.runId ?? "run-1",
  ...overrides,
});

describe("direct-mode replaced (hidden) slots", () => {
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

  const projectRows = async (
    messages: MessageRecord[],
  ): Promise<EventRowViewModel[]> => {
    let captured: EventRowViewModel[] = [];
    const Probe = ({ messages }: { messages: MessageRecord[] }) => {
      captured = useEventRows({ messages }).rows;
      return null;
    };
    await act(async () => {
      root.render(<Probe messages={messages} />);
    });
    return captured;
  };

  it("drops hidden slots from the timeline but keeps the live placeholder", async () => {
    const user = message({ _id: "u1", type: "user_message", timestamp: 1 });
    // Two interim segments already replaced by the handoff controller…
    const hiddenSlots = [1, 2].map((index) =>
      overlayToMessageRecord(
        overlay({
          _id: `stream-overlay:u1:${index}`,
          indexInTurn: index,
          text: "",
          timestamp: 1 + index,
          textTransition: "hidden",
        }),
      ),
    );
    // …and the live slot, still before its first token.
    const liveSlot = overlayToMessageRecord(
      overlay({
        _id: "stream-overlay:u1:3",
        indexInTurn: 3,
        text: "",
        timestamp: 5,
      }),
    );

    const rows = await projectRows([user, ...hiddenSlots, liveSlot]);
    const assistantRows = rows.filter((row) => row.kind === "assistant");
    expect(assistantRows).toHaveLength(3);

    // Hidden slots must not read as streaming — that flag is what reserves
    // a placeholder timeline item (1px + assistant-run gap each).
    expect(assistantRows[0]?.isStreaming).toBeUndefined();
    expect(assistantRows[1]?.isStreaming).toBeUndefined();
    // The live slot keeps its placeholder so scroll-follow has a target.
    expect(assistantRows[2]?.isStreaming).toBe(true);

    const items = buildChatTimelineItems({
      rows,
      queuedUserMessages: [],
      includeWorkingIndicator: false,
    });
    expect(
      items
        .filter((item) => item.type === "message")
        .map((item) => item.id),
    ).toEqual([
      "u1",
      // Only the live slot occupies an item; no per-replacement spacers.
      assistantRows[2]!.id,
    ]);
  });

  it("keeps a fading slot visible until its exit transition ends", async () => {
    const user = message({ _id: "u1", type: "user_message", timestamp: 1 });
    const fadingSlot = overlayToMessageRecord(
      overlay({
        _id: "stream-overlay:u1:1",
        indexInTurn: 1,
        text: "Checking the file…",
        timestamp: 2,
        textTransition: "fading",
      }),
    );

    const rows = await projectRows([user, fadingSlot]);
    const assistantRows = rows.filter((row) => row.kind === "assistant");
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]?.isStreaming).toBe(true);
    expect(assistantRows[0]?.isFadingOut).toBe(true);

    const items = buildChatTimelineItems({
      rows,
      queuedUserMessages: [],
      includeWorkingIndicator: false,
    });
    expect(items.map((item) => item.id)).toEqual([
      "u1",
      assistantRows[0]!.id,
    ]);
  });
});
