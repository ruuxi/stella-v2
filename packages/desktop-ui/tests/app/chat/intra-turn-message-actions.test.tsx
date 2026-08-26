// @vitest-environment jsdom
/**
 * A turn that interleaves tool calls emits several short assistant
 * segments ("Let me try X…") before the final answer. Only the turn's
 * FINAL assistant message may carry the Copy / Read-aloud action strip —
 * mid-turn segments used to mount it too, showing actions where they
 * weren't wanted and reserving the strip's 24px + flex gap under every
 * preamble.
 *
 * Pins both halves of the fix:
 *   1. `isIntraTurnAssistantRuntime` — the projection predicate over the
 *      persisted runtime metadata (`followedByToolCall` stamped on every
 *      segment that handed off to a tool; `turnComplete` stamped on the
 *      run's last message and winning when both are set).
 *   2. `AssistantMessageRow` — an `isIntraTurn` row renders NO
 *      `.message-actions` element at all (nothing reserving height), while
 *      a final row keeps the strip with its read-aloud button.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";
import { AssistantMessageRow } from "@/app/chat/MessageRow";
import { isIntraTurnAssistantRuntime } from "@/features/chat/hooks/use-event-rows";

describe("isIntraTurnAssistantRuntime", () => {
  it("flags a segment that handed off to a tool call", () => {
    expect(
      isIntraTurnAssistantRuntime({
        followedByToolCall: true,
      }),
    ).toBe(true);
  });

  it("keeps the turn's final message: turnComplete wins over followedByToolCall", () => {
    // A run whose LAST action was a tool call stamps both flags on the same
    // message — that message is still the turn's terminal answer.
    expect(
      isIntraTurnAssistantRuntime({
        followedByToolCall: true,
        turnComplete: true,
      }),
    ).toBe(false);
    expect(isIntraTurnAssistantRuntime({ turnComplete: true })).toBe(false);
  });

  it("never flags legacy metadata or plain answers", () => {
    expect(isIntraTurnAssistantRuntime(undefined)).toBe(false);
    expect(isIntraTurnAssistantRuntime({})).toBe(false);
    expect(isIntraTurnAssistantRuntime({})).toBe(false);
  });
});

describe("AssistantMessageRow action strip", () => {
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

  const renderRow = async (row: Record<string, unknown>) => {
    await act(async () => {
      root.render(
        withI18n(
          <AssistantMessageRow
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            row={row as any}
            conversationId="conv-1"
          />,
        ),
      );
    });
  };

  const baseRow = (overrides: Record<string, unknown>) => ({
    kind: "assistant",
    id: "assistant-user-1-1",
    cacheKey: "assistant-user-1-1",
    text: "Let me try the other endpoint.",
    replyToUserMessageId: "user-1",
    ...overrides,
  });

  it("renders no action strip for an intra-turn segment", async () => {
    await renderRow(baseRow({ isIntraTurn: true }));
    // The message text still renders…
    expect(container.textContent).toContain("Let me try the other endpoint.");
    // …but nothing mounts the strip, so there is no element reserving its
    // 24px height between intra-turn messages.
    expect(container.querySelector(".message-actions")).toBeNull();
  });

  it("keeps the strip (copy + read-aloud) on the turn's final message", async () => {
    await renderRow(baseRow({ text: "Done — here's the summary." }));
    const strip = container.querySelector(".message-actions");
    expect(strip).not.toBeNull();
    expect(strip!.querySelector('[aria-label="Copy"]')).not.toBeNull();
    expect(strip!.querySelector('[aria-label="Read aloud"]')).not.toBeNull();
    // Settled (non-streaming) strip stays hover-revealable: not inert.
    expect(strip!.getAttribute("inert")).toBeNull();
    expect(strip!.getAttribute("data-streaming")).toBeNull();
  });
});
