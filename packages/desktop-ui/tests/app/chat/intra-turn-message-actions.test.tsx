// @vitest-environment jsdom
/**
 * A turn that interleaves tool calls emits several short assistant
 * segments ("Let me try X…") before the final answer. Only the turn's
 * FINAL assistant message may carry the Copy / Read-aloud actions —
 * mid-turn segments used to mount them too, showing actions where they
 * weren't wanted.
 *
 * Pins both halves of the fix:
 *   1. `isIntraTurnAssistantRuntime` — the projection predicate over the
 *      persisted runtime metadata (`followedByToolCall` stamped on every
 *      segment that handed off to a tool; `turnComplete` stamped on the
 *      run's last message and winning when both are set).
 *   2. `AssistantMessageRow` — an `isIntraTurn` row renders NO
 *      `.message-actions` control at all, while a final row keeps the
 *      ellipsis beside its bubble, holding copy + read-aloud.
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

describe("AssistantMessageRow hover actions", () => {
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

  it("renders no action control for an intra-turn segment", async () => {
    await renderRow(baseRow({ isIntraTurn: true }));
    // The message text still renders…
    expect(container.textContent).toContain("Let me try the other endpoint.");
    // …but nothing mounts the control between intra-turn messages.
    expect(container.querySelector(".message-actions")).toBeNull();
  });

  it("keeps the ellipsis (copy + read-aloud) on the turn's final message", async () => {
    await renderRow(baseRow({ text: "Done — here's the summary." }));
    const trigger = container.querySelector<HTMLElement>(".message-actions");
    expect(trigger).not.toBeNull();
    // It sits beside the bubble, in the message's own horizontal line, so it
    // costs no vertical space.
    expect(
      container.querySelector(
        ".message-line--assistant > .message-actions-rail--start .message-actions",
      ),
    ).not.toBeNull();
    expect(trigger!.getAttribute("inert")).toBeNull();
    // Radix opens the menu on `pointerdown`, not `click`.
    await act(async () => {
      trigger!.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    const menu = document.querySelector(".message-actions-menu");
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain("Copy");
    expect(menu!.textContent).toContain("Read aloud");
  });
});
