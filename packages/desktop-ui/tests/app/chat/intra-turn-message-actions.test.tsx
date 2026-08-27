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
        workingMode: "direct",
        followedByToolCall: true,
      }),
    ).toBe(true);
    expect(
      isIntraTurnAssistantRuntime({
        workingMode: "orchestrated",
        followedByToolCall: true,
      }),
    ).toBe(true);
  });

  it("keeps the turn's final message: turnComplete wins over followedByToolCall", () => {

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
    expect(isIntraTurnAssistantRuntime({ workingMode: "direct" })).toBe(false);
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

    expect(container.textContent).toContain("Let me try the other endpoint.");

    expect(container.querySelector(".message-actions")).toBeNull();
  });

  it("keeps the strip (copy + read-aloud) on the turn's final message", async () => {
    await renderRow(baseRow({ text: "Done — here's the summary." }));
    const strip = container.querySelector(".message-actions");
    expect(strip).not.toBeNull();
    expect(strip!.querySelector('[aria-label="Copy"]')).not.toBeNull();
    expect(strip!.querySelector('[aria-label="Read aloud"]')).not.toBeNull();

    expect(strip!.getAttribute("inert")).toBeNull();
    expect(strip!.getAttribute("data-streaming")).toBeNull();
  });
});
