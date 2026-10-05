// @vitest-environment jsdom
/**
 * Chat Rewind regression tests (0.1.69 bug: clicking Rewind only prefilled
 * the composer; the conversation never truncated).
 *
 * Pins the two halves of the fix:
 *
 *   1. `local-message-timeline-store` — a destructive `localChat:updated`
 *      notification (no appended event) triggers a full latest-page re-read
 *      of the timeline, not the append-only tail read that cannot observe
 *      removed rows. This is the root cause: the store's incremental
 *      strictly-after cursor can never see deletions, so the truncated
 *      suffix stayed painted after main had already deleted it.
 *   2. `MessageActions` — the armed confirm state is visible on the first
 *      click: icon swaps to the "confirm?" affordance, an inline hint
 *      ("Click again to rewind") renders, and the button is exposed to
 *      assistive tech as a two-step control (`aria-expanded` +
 *      aria-label swap). The double-click-to-execute design itself is
 *      intentional and unchanged.
 */
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
          // Mirrors the storage contract: rows at-or-after the cursor
          // (replacement detection) plus strictly-after rows.
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

// Minimal stand-in for isUiHiddenChatMessagePayload: hidden rows carry
// metadata.ui.visibility === "hidden" in their payload.
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

/** currentDb models what SQLite holds RIGHT NOW. */
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
    // @ts-expect-error test shim teardown
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
    // Initial read lands asynchronously.
    await act(async () => {});
    expect(
      getLocalMessageTimelineSnapshot("conv-1").messages.map((m) => m._id),
    ).toEqual(["u1", "u2", "u3"]);

    // Main truncates at u2 (removes u2 + u3) and broadcasts WITHOUT an event —
    // the shape truncateConversation emits.
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

    // Normal streaming-era append: the notification carries the appended
    // event, so the cheap tail read stays on the hot path. The appended row
    // is strictly AFTER the newest loaded cursor, so the incremental path
    // must pick it up.
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

  const renderActions = async (onRewind: () => void) => {
    await act(async () => {
      root.render(
        withI18n(
          <MessageActions text="hi" messageKey="m1" onRewind={onRewind} />,
        ),
      );
    });
  };

  /** Radix opens the menu on `pointerdown`, not `click`. */
  const openMenu = async () => {
    const trigger = container.querySelector<HTMLElement>(".message-actions")!;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
  };

  const rewindItem = () =>
    document.querySelector<HTMLElement>('[data-action="rewind"]');

  it("arms on the first select and executes on the second", async () => {
    const rewinds: string[] = [];
    await renderActions(() => rewinds.push("rewound"));
    await openMenu();
    const item = rewindItem();
    expect(item).not.toBeNull();

    // First select ARMS ONLY — no truncation call, and the menu stays open so
    // the confirm affordance can't silently vanish.
    await act(async () => item!.click());
    expect(rewinds).toHaveLength(0);
    const armed = rewindItem()!;
    expect(armed.dataset.armed).toBe("true");
    // Icon swapped to the "confirm?" affordance…
    expect(armed.querySelector(".stella-icon-alert-circle")).not.toBeNull();
    expect(armed.querySelector(".stella-icon-rotate-ccw")).toBeNull();
    // …plus the spelled-out double-click intent.
    expect(armed.textContent).toContain("Click again to rewind");

    // Second select EXECUTES.
    await act(async () => armed.click());
    expect(rewinds).toHaveLength(1);
  });

  it("disarms on the timeout without executing", async () => {
    const rewinds: string[] = [];
    await renderActions(() => rewinds.push("rewound"));
    await openMenu();
    await act(async () => rewindItem()!.click());
    expect(rewindItem()!.dataset.armed).toBe("true");

    await act(async () => {
      vi.advanceTimersByTime(3_500);
    });
    const disarmed = rewindItem()!;
    expect(disarmed.dataset.armed).toBeUndefined();
    expect(disarmed.textContent).not.toContain("Click again to rewind");
    expect(disarmed.querySelector(".stella-icon-rotate-ccw")).not.toBeNull();
    expect(rewinds).toHaveLength(0);
  });
});
