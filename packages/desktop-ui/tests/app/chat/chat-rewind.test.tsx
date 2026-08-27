import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageRecord } from "@stella/contracts/local-chat";
import {
  __testing as timelineTesting,
  getLocalMessageTimelineSnapshot,
  subscribeToLocalMessageTimeline,
} from "@/features/chat/services/local-message-timeline-store";
import { MessageActions } from "@/app/chat/MessageActions";
import { withI18n } from "../../helpers/i18n";

type UpdateListener = (payload: unknown) => void;

const installedListeners: UpdateListener[] = [];

const installFakeLocalChatApi = () => {
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: {
      localChat: {
        listMessages: async ({
          maxVisibleMessages,
        }: {
          maxVisibleMessages?: number;
        }) => {
          const visible = currentDb.filter((message) => !isUiHidden(message));
          return {
            messages: visible.slice(-maxVisibleMessages),
            visibleMessageCount: visible.length,
          };
        },
        listMessagesAfter: async ({
          afterId,
          maxVisibleMessages,
        }: {
          afterTimestampMs: number;
          afterId: string;
          maxVisibleMessages?: number;
        }) => {

          const cursorIndex = currentDb.findIndex(
            (message) => message._id === afterId,
          );
          if (cursorIndex === -1) {
            return { messages: [], visibleMessageCount: 0 };
          }
          const fromCursor = currentDb.slice(cursorIndex);
          return {
            messages: fromCursor.slice(0, maxVisibleMessages),
            visibleMessageCount: fromCursor.length,
          };
        },
        onUpdated: (listener: UpdateListener) => {
          installedListeners.push(listener);
          return () => {
            const index = installedListeners.indexOf(listener);
            if (index >= 0) installedListeners.splice(index, 1);
          };
        },
      },
    },
  });
};

const isUiHidden = (message: MessageRecord): boolean =>
  Boolean(
    (message.payload?.metadata as { ui?: { visibility?: string } } | undefined)
      ?.ui?.visibility,
  );

let nextSequence = 100;
const userMessage = (id: string, text: string): MessageRecord => ({
  _id: id,
  timestamp: 1_000 + nextSequence,
  sequence: nextSequence++,
  type: "user_message",
  payload: { text },
  toolEvents: [],
});

const emitUpdate = (payload: Record<string, unknown>) => {
  for (const listener of [...installedListeners]) listener(payload);
};

let currentDb: MessageRecord[] = [];

describe("local-message-timeline-store destructive updates", () => {
  beforeEach(() => {
    timelineTesting.reset();
    installedListeners.length = 0;
    nextSequence = 100;
    currentDb = [];
    installFakeLocalChatApi();
  });

  afterEach(() => {
    timelineTesting.reset();

    delete window.electronAPI;
  });

  it("re-reads the full page when a truncation update carries no event", async () => {
    currentDb = [
      userMessage("u1", "first"),
      userMessage("u2", "second"),
      userMessage("u3", "third"),
    ];
    let listenerCount = 0;
    const unsubscribe = subscribeToLocalMessageTimeline("conv-1", () => {
      listenerCount += 1;
    });

    await act(async () => {});
    expect(
      getLocalMessageTimelineSnapshot("conv-1").messages.map((m) => m._id),
    ).toEqual(["u1", "u2", "u3"]);

    currentDb = [userMessage("u1", "first")];
    emitUpdate({ conversationId: "conv-1" });
    await act(async () => {});

    expect(listenerCount).toBeGreaterThanOrEqual(2);
    expect(
      getLocalMessageTimelineSnapshot("conv-1").messages.map((m) => m._id),
    ).toEqual(["u1"]);
    unsubscribe();
  });

  it("still refreshes incrementally when an append update carries its event", async () => {
    currentDb = [userMessage("u1", "first"), userMessage("u3", "third")];
    const unsubscribe = subscribeToLocalMessageTimeline("conv-1", () => {});
    await act(async () => {});
    expect(
      getLocalMessageTimelineSnapshot("conv-1").messages.map((m) => m._id),
    ).toEqual(["u1", "u3"]);

    const appended = userMessage("u4", "fourth");
    currentDb = [...currentDb, appended];
    emitUpdate({ conversationId: "conv-1", event: appended });
    await act(async () => {});
    expect(
      getLocalMessageTimelineSnapshot("conv-1").messages.map((m) => m._id),
    ).toEqual(["u1", "u3", "u4"]);
    unsubscribe();
  });
});

describe("MessageActions rewind confirm affordance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
  });

  const renderStrip = async (onRewind: () => void) => {
    await act(async () => {
      root.render(
        withI18n(
          <MessageActions text="hi" messageKey="m1" onRewind={onRewind} />,
        ),
      );
    });
  };

  const rewindButton = () =>
    container.querySelector<HTMLButtonElement>('button[data-action="rewind"]');

  it("shows the confirm affordance on first click and executes on second", async () => {
    const rewinds: string[] = [];
    await renderStrip(() => rewinds.push("rewound"));
    const button = rewindButton();
    expect(button).not.toBeNull();

    await act(async () => button!.click());
    expect(rewinds).toHaveLength(0);
    const armed = rewindButton()!;
    expect(armed.dataset.armed).toBe("true");
    expect(armed.getAttribute("aria-expanded")).toBe("true");
    expect(armed.getAttribute("title")).toBe("Click again to rewind");

    expect(armed.querySelector(".stella-icon-alert-circle")).not.toBeNull();
    expect(armed.querySelector(".stella-icon-rotate-ccw")).toBeNull();

    expect(container.textContent).toContain("Click again to rewind");

    await act(async () => armed.click());
    expect(rewinds).toHaveLength(1);
    const disarmed = rewindButton()!;
    expect(disarmed.dataset.armed).toBeUndefined();
    expect(container.textContent).not.toContain("Click again to rewind");
    expect(disarmed.querySelector(".stella-icon-rotate-ccw")).not.toBeNull();
  });

  it("disarms without executing on blur or Escape", async () => {
    const rewinds: string[] = [];
    await renderStrip(() => rewinds.push("rewound"));
    const button = rewindButton()!;
    await act(async () => button.click());
    expect(button.dataset.armed).toBe("true");

    await act(async () => {

      container
        .querySelector(".message-actions")!
        .dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    });
    expect(rewindButton()).not.toBeNull();
    expect(rewindButton()?.dataset.armed).toBe("true");
    expect(container.textContent).toContain("Click again to rewind");

    await act(async () => rewindButton()!.click());
    const armedAgain = rewindButton()!;
    expect(armedAgain.dataset.armed).toBeUndefined();
    expect(container.textContent).not.toContain("Click again to rewind");

    const rewindsBeforeEscape = rewinds.length;
    await act(async () => armedAgain.click());
    expect(rewindButton()?.dataset.armed).toBe("true");
    await act(async () => {
      rewindButton()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(rewindButton()?.dataset.armed).toBeUndefined();
    expect(rewinds.length).toBe(rewindsBeforeEscape);
  });

  it("keeps the strip hover-revealed while armed so the confirm state stays visible", async () => {
    await renderStrip(() => {});
    const button = rewindButton()!;
    await act(async () => button.click());
    const row = container.querySelector<HTMLElement>(".message-actions");
    expect(row?.dataset.confirming).toBe("true");

    await act(async () => {
      vi.advanceTimersByTime(3_500);
    });
    expect(row?.dataset.confirming).toBeUndefined();
  });
});
