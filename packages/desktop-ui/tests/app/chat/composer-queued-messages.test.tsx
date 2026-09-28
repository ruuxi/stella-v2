// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { withI18n } from "../../helpers/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerQueuedMessages } from "@/app/chat/ComposerQueuedMessages";
import type { QueuedUserMessage } from "@/features/chat/hooks/queued-user-messages";

class ResizeObserverStub {
  observe = vi.fn();
  disconnect = vi.fn();
}

const queued = (
  id: string,
  text = "Follow up",
  queueOrder = 1,
): QueuedUserMessage => ({
  id,
  text,
  timestamp: 100 + queueOrder,
  queueOrder,
});

describe("ComposerQueuedMessages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("plays entry once when a queued virtual item is reconstructed", async () => {
    const message = queued("queued-animation-once");

    await act(async () => {
      root.render(withI18n(<ComposerQueuedMessages messages={[message]} />));
    });
    expect(
      container.querySelector<HTMLElement>(".composer-queued-message")?.style
        .animation,
    ).toBe("");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(withI18n(<ComposerQueuedMessages messages={[message]} />));
    });

    expect(
      container.querySelector<HTMLElement>(".composer-queued-message")?.style
        .animation,
    ).toBe("none");
  });

  it("renders a queued message with the sent user bubble and no queue label", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <ComposerQueuedMessages
            messages={[queued("queued-single", "Only this message")]}
          />,
        ),
      );
    });

    expect(container.querySelectorAll(".composer-queued-message")).toHaveLength(
      1,
    );
    const bubble = container.querySelector(".composer-queued-message > div");
    expect(bubble?.className).toBe("event-item user chat-bubble-text");
    expect(bubble?.querySelector(".event-user-body .event-body")?.textContent).toBe(
      "Only this message",
    );
    expect(container.textContent).toBe("Only this message");
    expect(container.textContent?.toLowerCase()).not.toContain("queued");
  });

  it("renders each queued message as its own bubble in queue order", async () => {
    const onCancel = vi.fn();
    const messages = [
      queued("queued-third", "Third in input", 3),
      queued("queued-first", "First in queue", 1),
      queued("queued-second", "Second in queue", 2),
    ];

    await act(async () => {
      root.render(
        withI18n(
          <ComposerQueuedMessages messages={messages} onCancel={onCancel} />,
        ),
      );
    });

    const rows = container.querySelectorAll(".composer-queued-message");
    expect(
      Array.from(rows, (row) => row.querySelector(".event-item.user")?.textContent),
    ).toEqual(["First in queue", "Second in queue", "Third in input"]);
    expect(container.textContent?.toLowerCase()).not.toContain("queued");

    const cancel = rows[1]!.querySelector<HTMLButtonElement>(
      ".composer-queued-message__cancel",
    );
    expect(cancel?.getAttribute("aria-label")).toBe("Cancel queued message");
    await act(async () => cancel!.click());
    expect(onCancel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "queued-second", text: "Second in queue" }),
    );

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(withI18n(<ComposerQueuedMessages messages={messages} />));
    });
    for (const row of container.querySelectorAll<HTMLElement>(
      ".composer-queued-message",
    )) {
      expect(row.style.animation).toBe("none");
    }
  });
});
